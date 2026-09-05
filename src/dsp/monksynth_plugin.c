/*
 * MonkSynth for Schwung — plugin_api_v2 adapter around the vendored FOF
 * vocal engine.
 *
 * The engine in dsp/{synth,voice,delay}.{c,h} is VENDORED VERBATIM from
 * charlesvestal/monksynth-ios, which in turn vendors it from
 * JonET/monksynth. It is pure C with no platform dependencies and is
 * READ-ONLY here: fix DSP bugs upstream and re-pull with
 * scripts/sync_dsp.sh. Everything Schwung-specific lives in this file.
 *
 * WHAT THIS FILE OWES THE HOST
 *
 *   Every entry point below runs ON THE SPI CALLBACK — create_instance,
 *   destroy_instance, set_param, get_param, on_midi and render_block alike.
 *   So: no logging, no file I/O, no locks, and no allocation anywhere except
 *   create_instance, where it is unavoidable.
 *
 *   create_instance is the expensive one and it is measured, not guessed:
 *   monk_synth_new mallocs 2.58 MB (ten MonkVoice at 168 KB each) and fills
 *   each voice's sine / formant-spline / cos-window / exp-decay tables, which
 *   costs ~0.8 ms on an Apple Silicon host. That is a few SPI frames' worth on
 *   the A72 — a brief click when the module is loaded into a slot, and nothing
 *   after. Steady-state render_block measures 4.3 us/block mono and 31.5 us at
 *   unison 9 on the same host, i.e. low single-digit percent of the ~2370 us
 *   frame budget. The load cost is inherent to the vendored engine's fixed
 *   ten-voice array; it is not something this adapter can defer without
 *   editing DSP we do not own.
 *
 * PARAMETERS are normalized 0..1 on the wire, exactly as upstream stores
 * them, and are converted to engine units here — the same conversions
 * AU/RenderContext.swift:89-113 performs, kept identical so a patch means the
 * same thing in both ports.
 *
 * CHARACTERS ARE PRESETS, NOT AN ENUM. The twelve characters are served
 * through the fleet's list_param / count_param / name_param contract, so the
 * shadow UI gives them its own auditioning browser page rather than a knob
 * with twelve dead detents. Selecting one applies that character's voice AND
 * sets `face`, which is what the JS surfaces draw.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "plugin_api_v1.h"
#include "synth.h"

static const host_api_v1_t *g_host = NULL;

/* ------------------------------------------------------------------ params */

/*
 * The sixteen continuous voice parameters, in the order the character table
 * below lists them. Index order is this file's own; it is NOT upstream's
 * Param rawValue order, and nothing persisted depends on it (state is written
 * as named JSON keys) — so it may be reordered freely, unlike the character
 * value arrays, which are positional.
 */
enum {
    P_GLIDE = 0,      /* upstream portTime  -> monk_synth_set_glide      */
    P_HEAD_SIZE,      /* upstream headSize  -> monk_synth_set_voice      */
    P_VIBRATO,
    P_VIBRATO_RATE,
    P_ASPIRATION,
    P_ATTACK,
    P_DECAY,
    P_SUSTAIN,
    P_RELEASE,
    P_UNISON,
    P_UNISON_DETUNE,
    P_UNISON_SPREAD,
    P_DELAY,
    P_DELAY_RATE,
    P_LEVEL,
    P_COUNT
};

/*
 * WHICH PARAMS ARE SLEWED, AND WHY THEY HAVE TO BE.
 *
 * The vendored engine ramps exactly two things: pitch and vowel, over its
 * RAMP_TICKS = 10 ticks of 10 ms (the original Delay Lama's ramp). Everything
 * else ASSIGNS -- monk_voice_set_voice and monk_voice_set_aspiration are a
 * clamp and a store. So every knob detent was a hard discontinuity in a value
 * the grain is rebuilt from, which is audible as stair-stepping, and it gets
 * worse the faster you turn.
 *
 * Slewing here rather than upstream: dsp/ is vendored read-only, and this is a
 * host-integration concern anyway -- a VST host sends automation at audio rate,
 * while Move sends one discrete step per detent. Applied once per BLOCK
 * (2.9 ms at 128 frames), which is well inside the ~30 ms the ear reads as
 * immediate and far cheaper than per-sample.
 *
 * NOT slewed, deliberately:
 *   unison        an integer VOICE COUNT -- slewing it thrashes allocation
 *   glide, A/D/R  time constants, not signals; they are read when a stage
 *                 begins, so a slewed value is just a lagged setting
 * `sustain` IS slewed: it scales the envelope continuously, so a jump in it is
 * a jump in level.
 */
static const int PARAM_SMOOTH[P_COUNT] = {
    /* GLIDE */ 0, /* HEAD_SIZE */ 1, /* VIBRATO */ 1, /* VIBRATO_RATE */ 1,
    /* ASPIRATION */ 1, /* ATTACK */ 0, /* DECAY */ 0, /* SUSTAIN */ 1,
    /* RELEASE */ 0, /* UNISON */ 0, /* UNISON_DETUNE */ 1, /* UNISON_SPREAD */ 1,
    /* DELAY */ 1, /* DELAY_RATE */ 1, /* LEVEL */ 1,
};

/*
 * One-pole coefficient per 128-frame block at 44.1 kHz.
 *
 * 1 - exp(-2.9ms / 30ms) ~= 0.092. Thirty milliseconds is short enough that a
 * turn feels attached to the knob and long enough to bridge a detent; the
 * snap threshold below stops it creeping toward the target forever.
 */
#define SLEW_COEF   0.092f
#define SLEW_SNAP   1.0e-4f

/* Keys, in P_* order. */
static const char *const PARAM_KEYS[P_COUNT] = {
    "glide", "head_size", "vibrato", "vibrato_rate", "aspiration",
    "attack", "decay", "sustain", "release",
    "unison", "unison_detune", "unison_spread",
    "delay", "delay_rate", "level"
};

/* ------------------------------------------------------- character presets */

#define CHAR_COUNT 12

typedef struct {
    const char *id;       /* stable; matches the iOS Character.id, and the JS face table */
    const char *name;     /* what the preset browser says */
    float v[P_COUNT];     /* positional, in P_* order */
} monk_character_t;

/*
 * The twelve voices, ported verbatim as numbers.
 *
 * The first six are AU/UI/CharacterVoice.swift's hand-tuned entries. The last
 * six are upstream's own factory patches, mapped to characters by
 * AU/UI/FactoryVoiceTable.swift (dog=Monastary, ghost=Rabten,
 * firefighter=Dorje, punk=Jamyang, pizza=Ngawang, cat=Tinley) and read out of
 * AU/FactoryPresets.swift's arrays by upstream Param index.
 *
 * `vowel` IS DELIBERATELY ABSENT from every row, and selecting a character
 * must never write it. It is a live performance position, not a voice trait —
 * CharacterVoice.swift says so explicitly, and the factory arrays do carry a
 * vowel (Monastary's is 0.445236) that would otherwise yank the mouth shut
 * under the player's hand. Same reasoning excludes the pressure routing.
 */
static const monk_character_t CHARACTERS[CHAR_COUNT] = {
    /*                     glide  head  vib  vibR  asp  atk  dec  sus  rel  uni  det  spr  dly  dlyR  lvl */
    { "monk",        "Monk",
      { 0.50f, 0.50f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.80f, 0.50f, 1.00f } },
    { "fish",        "Fish",
      { 0.50f, 0.70f, 0.00f, 0.50f, 0.05f, 0.00f, 0.05f, 0.70f, 0.02f, 0.00f, 0.00f, 0.00f, 0.95f, 0.75f, 1.00f } },
    { "unicorn",     "Unicorn",
      { 0.50f, 0.60f, 0.35f, 0.20f, 0.40f, 0.05f, 0.10f, 0.80f, 0.55f, 0.90f, 0.60f, 0.70f, 0.90f, 0.60f, 1.00f } },
    { "girl",        "Little Girl",
      { 0.50f, 0.92f, 0.15f, 0.85f, 0.25f, 0.00f, 0.00f, 1.00f, 0.05f, 0.00f, 0.00f, 0.00f, 0.80f, 0.50f, 1.00f } },
    { "oldman",      "Old Man",
      { 0.75f, 0.12f, 0.55f, 0.12f, 0.85f, 0.12f, 0.10f, 0.85f, 0.30f, 0.00f, 0.00f, 0.00f, 0.80f, 0.50f, 1.00f } },
    { "cow",         "Cow",
      { 0.90f, 0.08f, 0.00f, 0.50f, 0.30f, 0.08f, 0.10f, 0.90f, 0.60f, 0.00f, 0.00f, 0.00f, 0.50f, 0.50f, 1.00f } },
    /* Monastary */
    { "dog",         "Dog",
      { 0.400000f, 0.000000f, 0.094488f, 0.500000f, 0.034247f, 0.109589f, 0.000000f, 1.000000f,
        0.041096f, 0.264840f, 0.465753f, 0.178082f, 0.300000f, 0.335616f, 1.000000f } },
    /* Rabten — upstream's all-defaults patch */
    { "ghost",       "Ghost",
      { 0.50f, 0.50f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.80f, 0.50f, 1.00f } },
    /* Dorje */
    { "firefighter", "Fire Fighter",
      { 0.40f, 0.00f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.30f, 0.50f, 1.00f } },
    /* Jamyang */
    { "punk",        "Punk",
      { 0.50f, 0.75f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.50f, 1.00f } },
    /* Ngawang */
    { "pizza",       "Pizza",
      { 0.80f, 0.25f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.60f, 0.50f, 1.00f } },
    /* Tinley */
    { "cat",         "Cat",
      { 1.00f, 1.00f, 0.00f, 0.50f, 0.50f, 0.00f, 0.00f, 1.00f, 0.00f, 0.00f, 0.00f, 0.00f, 0.90f, 0.50f, 1.00f } },
};

/* ------------------------------------------------- pressure / bend routing */

/*
 * Upstream routes the PITCH WHEEL through four modes (controller.cpp:423-452),
 * and in the default one the wheel drives the VOWEL — that is the Delay Lama
 * gesture, not a pitch effect.
 *
 * Move has neither a pitch wheel nor a mod wheel, so on this hardware the
 * source is PAD PRESSURE: Move emits polyphonic aftertouch (0xA0) on pads.
 * The routing survives; only what feeds it changes. External gear plugged into
 * USB-A still gets real 0xE0 bend, 0xD0 channel pressure and CC 1, which cost
 * a few lines here and would otherwise silently do nothing.
 */
/*
 * Ordered the way you would reach for them: the two single destinations first,
 * then the combinations. NOT upstream's order -- its enum is
 * classic/both/bothInverted/pitch, which puts the second-simplest choice third.
 * The stored value is an index, so this order is what a saved patch means;
 * `Vowel` stays 0 either way, which is the default and every character's.
 */
enum { ROUTE_VOWEL = 0, ROUTE_PITCH, ROUTE_BOTH, ROUTE_BOTH_INV, ROUTE_COUNT };

static const char *const ROUTE_NAMES[ROUTE_COUNT] = {
    "Vowel", "Pitch", "Both", "Both Inv"
};

#define MAX_HELD 16

typedef struct {
    MonkSynthEngine *engine;

    /*
     * TARGET and CURRENT are separate, and get_param answers the TARGET.
     *
     * The knob's value is what the player set and what the UI must read back;
     * `cur` is where the slew has got to, and only the engine sees it. Serving
     * `cur` would make a knob appear to drift after you let go of it.
     */
    float p[P_COUNT];
    float cur[P_COUNT];
    int   preset;          /* index into CHARACTERS; -1 once a knob is moved */
    int   route;
    float bend_range;      /* semitones, 0..12 */

    /*
     * The note stack, mirrored.
     *
     * The engine keeps its own stack for pitch, but this adapter needs to know
     * WHICH note is on top so that monophonic pressure follows the note you
     * are leaning on. Poly aftertouch for a note that is not on top is
     * discarded: with one voice sounding, honouring it would let a still-held
     * lower pad drag the vowel around under a melody line.
     */
    uint8_t held[MAX_HELD];
    int     held_count;

    float vowel;           /* the KNOB's vowel -- the resting position */
    float vowel_cur;       /* slewed toward `vowel` */
    float expr_cur;        /* slewed toward `expr` -- pressure, 0..1 */
    float pressure_depth;  /* how far full pressure moves the vowel */
    float expr;            /* last routed expression value, 0..1 */
} monk_inst_t;

/* ------------------------------------------------------------- conversions */

static float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

/*
 * Push one normalized parameter into the engine.
 *
 * These conversions mirror AU/RenderContext.swift:89-113 exactly. Keep them
 * that way: a preset value means the same sound in both ports only because
 * both apply the same scaling, and the scalings are not all linear-to-unit
 * (unison rounds to a voice COUNT, spread halves, the envelope times are
 * seconds).
 */
/* Push one value into the engine. `v` is the CURRENT (slewed) value, not the
 * target -- see monk_inst_t. */
static void apply_value(MonkSynthEngine *s, int idx, float v) {
    switch (idx) {
    case P_GLIDE:         monk_synth_set_glide(s, v); break;
    case P_HEAD_SIZE:     monk_synth_set_voice(s, v); break;   /* upstream's "voice" */
    case P_VIBRATO:       monk_synth_set_vibrato(s, v); break;
    case P_VIBRATO_RATE:  monk_synth_set_vibrato_rate(s, v); break;
    case P_ASPIRATION:    monk_synth_set_aspiration(s, v); break;
    case P_ATTACK:        monk_synth_set_attack(s, v * 5.0f); break;
    case P_DECAY:         monk_synth_set_decay(s, v * 5.0f); break;
    case P_SUSTAIN:       monk_synth_set_sustain(s, v); break;
    case P_RELEASE:       monk_synth_set_release(s, v * 5.0f); break;
    case P_UNISON:        monk_synth_set_unison(s, (int)(v * 9.0f + 1.5f)); break;
    case P_UNISON_DETUNE: monk_synth_set_unison_detune(s, v * 50.0f); break;
    case P_UNISON_SPREAD: monk_synth_set_unison_voice_spread(s, v * 0.5f); break;
    case P_DELAY:         monk_synth_set_delay_mix(s, v); break;
    case P_DELAY_RATE:    monk_synth_set_delay_rate(s, v); break;
    case P_LEVEL:         monk_synth_set_level(s, v); break;
    default: break;
    }
}

/*
 * Apply a parameter now.
 *
 * A param that is not slewed goes straight through. A slewed one only has its
 * TARGET moved here; render_block walks it there. The exception is `snap`,
 * used at construction, where there is nothing to slew from and starting every
 * value at zero would fade the first note in.
 */
static void apply_param(monk_inst_t *in, int idx, int snap) {
    if (!PARAM_SMOOTH[idx] || snap) {
        in->cur[idx] = in->p[idx];
        apply_value(in->engine, idx, in->cur[idx]);
    }
}

static void apply_all(monk_inst_t *in, int snap) {
    for (int i = 0; i < P_COUNT; i++) apply_param(in, i, snap);
}

/* Defined below, beside route_expression, where the composition rule reads with
 * the reason for it. */
static float combined_vowel(const monk_inst_t *in);
static float combined_target(const monk_inst_t *in);

/* Walk every slewed parameter one block closer to its target. */
static void slew_block(monk_inst_t *in) {
    /*
     * VOWEL IS SLEWED TOO, and it lives outside the p[] table so it needed
     * saying twice. Missing it is why the first smoothing pass fixed Head Size
     * and Breath and left the one knob anybody actually performs with stepping.
     *
     * The engine has a ramp of its own -- ten ticks of 10 ms -- but it is
     * RESTARTED by every set_vowel, so a knob sending one discrete step per
     * detent produces a staircase of restarts rather than a glide. Slewing here
     * at block rate (~344 Hz against the ramp's 100 Hz) means what the engine
     * is handed already moves smoothly.
     *
     * Skipped entirely while pressure is driving: aftertouch writes the engine's
     * vowel directly, and slewing the knob's value on top would drag it back
     * toward where the knob was left, which reads as the pad fighting you.
     */
    /*
     * The knob and the pressure are slewed SEPARATELY and combined after, so
     * neither can drag the other. Pressure is slewed too: aftertouch arrives in
     * coarse 7-bit steps and a raw one is as steppy as a knob detent.
     */
    const float dv = in->vowel - in->vowel_cur;
    if (dv > -SLEW_SNAP && dv < SLEW_SNAP) in->vowel_cur = in->vowel;
    else in->vowel_cur += dv * SLEW_COEF;

    const float de = in->expr - in->expr_cur;
    if (de > -SLEW_SNAP && de < SLEW_SNAP) in->expr_cur = in->expr;
    else in->expr_cur += de * SLEW_COEF;

    monk_synth_set_vowel(in->engine, combined_vowel(in));

    /* Pitch, for the modes that route pressure there. Applied every block for
     * the same reason as the vowel: a 7-bit step is audible. */
    if (in->route == ROUTE_BOTH || in->route == ROUTE_BOTH_INV || in->route == ROUTE_PITCH)
        monk_synth_set_pitch_bend(in->engine, in->expr_cur * in->bend_range);
    for (int i = 0; i < P_COUNT; i++) {
        if (!PARAM_SMOOTH[i]) continue;
        const float t = in->p[i], c = in->cur[i];
        const float d = t - c;
        if (d > -SLEW_SNAP && d < SLEW_SNAP) {
            if (c != t) { in->cur[i] = t; apply_value(in->engine, i, t); }
            continue;
        }
        in->cur[i] = c + d * SLEW_COEF;
        apply_value(in->engine, i, in->cur[i]);
    }
}

/* Load a character: its voice, and the face the JS surfaces draw. */
static void apply_character(monk_inst_t *in, int idx, int snap) {
    if (idx < 0 || idx >= CHAR_COUNT) return;
    memcpy(in->p, CHARACTERS[idx].v, sizeof(in->p));
    in->preset = idx;
    apply_all(in, snap);
}

/* ---------------------------------------------------------------- lifecycle */

static void *v2_create_instance(const char *dir, const char *cfg) {
    (void)dir; (void)cfg;
    monk_inst_t *in = (monk_inst_t *)calloc(1, sizeof(monk_inst_t));
    if (!in) return NULL;
    in->engine = monk_synth_new(44100.0f);
    if (!in->engine) { free(in); return NULL; }
    in->route = ROUTE_VOWEL;
    in->bend_range = 2.0f;
    in->expr = 0.0f;
    in->vowel = 0.5f;
    in->vowel_cur = 0.5f;
    in->expr_cur = 0.0f;
    in->pressure_depth = 0.5f;
    /* Vowel is not in the character table (see CHARACTERS), so seed upstream's
     * own default for it here rather than leaving the mouth shut at 0. */
    monk_synth_set_vowel(in->engine, 0.5f);
    /* Snap at construction: there is no previous value to slew from, and
     * slewing from zero would fade the first note in. */
    apply_character(in, 0, 1);   /* Monk — upstream's Rabten defaults */
    return in;
}

static void v2_destroy_instance(void *instance) {
    monk_inst_t *in = (monk_inst_t *)instance;
    if (!in) return;
    if (in->engine) monk_synth_free(in->engine);
    free(in);
}

/* -------------------------------------------------------------------- midi */

/*
 * Record pressure. It is APPLIED in slew_block, never here.
 *
 * PRESSURE MODIFIES THE KNOB; it does not replace it. It used to call
 * set_vowel with an absolute position, which meant the knob and the pad were
 * two things writing one value: press a pad and the knob's own slew was
 * switched off so it would not fight back, then turn the knob and it took over
 * again. Whichever moved last won, and both felt like they were being yanked.
 *
 * Composing them removes the conflict rather than arbitrating it -- the knob is
 * the resting vowel, pressure is a departure from it, and one place computes
 * the sum. Which is also what a player expects: set the vowel you want to sit
 * on, then lean into a pad to push it.
 */
static void route_expression(monk_inst_t *in, float x) {
    in->expr = clamp01(x);
}

/* The vowel actually sung: the knob, plus wherever pressure is pushing it. */
static float combine(const monk_inst_t *in, float vowel, float expr) {
    const float d = expr * in->pressure_depth;
    switch (in->route) {
    case ROUTE_BOTH_INV: return clamp01(vowel - d);
    case ROUTE_PITCH:    return vowel;              /* pressure is all pitch */
    default:             return clamp01(vowel + d);
    }
}

/* What is being sung right now: the SLEWED values, which is what the engine got. */
static float combined_vowel(const monk_inst_t *in) {
    return combine(in, in->vowel_cur, in->expr_cur);
}

/*
 * What WOULD be sung: the targets, with no dependence on rendering.
 *
 * THE SHIM SKIPS render_block ENTIRELY ON A SILENT SLOT -- one probe frame in
 * 172, so roughly four a second. The slew lives in render_block, so on a silent
 * slot the slewed values crawl, and a reading derived from them appears frozen:
 * the vowel only started tracking the knob after the first note had been
 * played, which is exactly how it was reported.
 *
 * Silent, the targets are the honest answer anyway. They are also what the
 * engine snaps to the instant a note begins, since the MIDI path assigns the
 * vowel rather than ramping it.
 */
static float combined_target(const monk_inst_t *in) {
    return combine(in, in->vowel, in->expr);
}

static void push_held(monk_inst_t *in, uint8_t note) {
    for (int i = 0; i < in->held_count; i++)
        if (in->held[i] == note) return;
    if (in->held_count >= MAX_HELD) return;
    in->held[in->held_count++] = note;
}

static void pop_held(monk_inst_t *in, uint8_t note) {
    for (int i = 0; i < in->held_count; i++) {
        if (in->held[i] != note) continue;
        for (int j = i; j + 1 < in->held_count; j++) in->held[j] = in->held[j + 1];
        in->held_count--;
        return;
    }
}

static void v2_on_midi(void *instance, const uint8_t *msg, int len, int source) {
    monk_inst_t *in = (monk_inst_t *)instance;
    (void)source;
    if (!in || !in->engine || !msg || len < 1) return;

    const uint8_t status = (uint8_t)(msg[0] & 0xF0);

    switch (status) {
    case 0x90:
        if (len >= 3 && msg[2] > 0) {
            push_held(in, msg[1]);
            monk_synth_note_on(in->engine, msg[1], msg[2] / 127.0f);
            break;
        }
        /* velocity 0 is a note-off */
        /* fall through */
    case 0x80:
        if (len >= 2) {
            pop_held(in, msg[1]);
            monk_synth_note_off(in->engine, msg[1]);
        }
        break;

    /*
     * Polyphonic aftertouch — Move's pads. Honoured only for the note on TOP
     * of the stack, because the engine is monophonic: see monk_inst_t.held.
     */
    case 0xA0:
        if (len >= 3 && in->held_count > 0 && msg[1] == in->held[in->held_count - 1])
            route_expression(in, msg[2] / 127.0f);
        break;

    /* Channel pressure — external gear that sends 0xD0 instead of 0xA0. */
    case 0xD0:
        if (len >= 2) route_expression(in, msg[1] / 127.0f);
        break;

    /*
     * A real 14-bit pitch wheel, from external gear. Bipolar, so it is
     * remapped into the same unipolar 0..1 the routing expects, with centre
     * reading 0.5 — which in the default Vowel mode is exactly upstream's
     * "wheel sweeps the vowel" behaviour.
     */
    case 0xE0:
        if (len >= 3) {
            const int raw = (int)msg[1] | ((int)msg[2] << 7);   /* 0..16383 */
            route_expression(in, (float)raw / 16383.0f);
        }
        break;

    /* CC. The engine has its own map (1/5/7/12/13); pass it through. */
    case 0xB0:
        if (len >= 3) monk_synth_midi_cc(in->engine, msg[1], msg[2] / 127.0f);
        break;

    default:
        break;
    }
}

/* -------------------------------------------------------------------- audio */

#define MAX_FRAMES 2048
static float g_l[MAX_FRAMES];
static float g_r[MAX_FRAMES];

static void v2_render_block(void *instance, int16_t *out_lr, int frames) {
    monk_inst_t *in = (monk_inst_t *)instance;
    if (!out_lr || frames <= 0) return;
    if (!in || !in->engine) {
        memset(out_lr, 0, (size_t)frames * 2 * sizeof(int16_t));
        return;
    }
    if (frames > MAX_FRAMES) frames = MAX_FRAMES;

    /* Before the audio, not after: a target set by set_param since the last
     * block must reach the engine before it renders with the old value. */
    slew_block(in);

    monk_synth_process(in->engine, g_l, g_r, (uint32_t)frames);

    for (int i = 0; i < frames; i++) {
        float l = g_l[i], r = g_r[i];
        if (l < -1.0f) l = -1.0f; else if (l > 1.0f) l = 1.0f;
        if (r < -1.0f) r = -1.0f; else if (r > 1.0f) r = 1.0f;
        out_lr[i * 2]     = (int16_t)(l * 32767.0f);
        out_lr[i * 2 + 1] = (int16_t)(r * 32767.0f);
    }
}

/* --------------------------------------------------------------- set_param */

/*
 * Restore is deliberately forgiving, and it is ORDER-SENSITIVE in one place:
 * `preset` must be applied BEFORE the individual knobs, because applying a
 * character overwrites all fifteen. A blob written by autosave carries both,
 * and the knobs are the authority — they are what the player last heard.
 */
static void restore_state(monk_inst_t *in, const char *json);

static void v2_set_param(void *instance, const char *key, const char *val) {
    monk_inst_t *in = (monk_inst_t *)instance;
    if (!in || !in->engine || !key || !val) return;

    if (strcmp(key, "state") == 0) { restore_state(in, val); return; }

    if (strcmp(key, "preset") == 0) {
        int idx = atoi(val);
        /* A character change SLEWS -- fifteen values moving at once is exactly
         * where an instant jump clicks. */
        if (idx >= 0 && idx < CHAR_COUNT) apply_character(in, idx, 0);
        return;
    }

    if (strcmp(key, "vowel") == 0) {
        /* Set the TARGET; slew_block walks the engine there and adds pressure. */
        in->vowel = clamp01((float)atof(val));
        return;
    }

    if (strcmp(key, "pressure_routing") == 0) {
        int r = atoi(val);
        if (r >= 0 && r < ROUTE_COUNT) in->route = r;
        return;
    }

    if (strcmp(key, "pressure_depth") == 0) {
        in->pressure_depth = clamp01((float)atof(val));
        return;
    }

    if (strcmp(key, "bend_range") == 0) {
        float v = (float)atof(val);
        if (v < 0.0f) v = 0.0f;
        if (v > 12.0f) v = 12.0f;
        in->bend_range = v;
        return;
    }

    /* `face` is a READOUT. It is served so the knob-grid widgets can see which
     * character to draw, and it is set only by loading one — a write here is
     * accepted from a state restore but never invents a voice. */
    if (strcmp(key, "face") == 0) {
        int idx = atoi(val);
        if (idx >= 0 && idx < CHAR_COUNT) in->preset = idx;
        return;
    }

    for (int i = 0; i < P_COUNT; i++) {
        if (strcmp(key, PARAM_KEYS[i]) != 0) continue;
        in->p[i] = clamp01((float)atof(val));
        apply_param(in, i, 0);
        return;
    }
}

/* Pull one "key":number out of a flat JSON object. Returns 1 when found. */
static int json_num(const char *json, const char *key, float *out) {
    char pat[64];
    const int n = snprintf(pat, sizeof(pat), "\"%s\"", key);
    if (n <= 0 || n >= (int)sizeof(pat)) return 0;
    const char *p = strstr(json, pat);
    if (!p) return 0;
    p = strchr(p + n, ':');
    if (!p) return 0;
    *out = (float)atof(p + 1);
    return 1;
}

static void restore_state(monk_inst_t *in, const char *json) {
    float f;

    /* Character first — it writes all fifteen, so the knobs below must win. */
    if (json_num(json, "preset", &f)) {
        int idx = (int)f;
        /* A restore SNAPS: this is not a performance gesture, and slewing a
         * whole slot into place on boot would be audible as a swell. */
        if (idx >= 0 && idx < CHAR_COUNT) apply_character(in, idx, 1);
    }

    for (int i = 0; i < P_COUNT; i++) {
        if (!json_num(json, PARAM_KEYS[i], &f)) continue;
        in->p[i] = clamp01(f);
        apply_param(in, i, 1);
    }
    if (json_num(json, "vowel", &f)) {
        /* A restore SNAPS, like every other value here. */
        in->vowel = clamp01(f);
        in->vowel_cur = in->vowel;
        monk_synth_set_vowel(in->engine, in->vowel);
    }
    if (json_num(json, "pressure_depth", &f)) in->pressure_depth = clamp01(f);
    if (json_num(json, "pressure_routing", &f)) {
        int r = (int)f;
        if (r >= 0 && r < ROUTE_COUNT) in->route = r;
    }
    if (json_num(json, "bend_range", &f)) {
        if (f < 0.0f) f = 0.0f;
        if (f > 12.0f) f = 12.0f;
        in->bend_range = f;
    }
}

/* --------------------------------------------------------------- get_param */

/*
 * The knob-grid contract. Declared here rather than only in module.json so the
 * shadow UI gets it from the loaded component, which is what it actually reads.
 *
 * THE TWO CUSTOM WIDGET KINDS and the card are declared exactly as a built-in
 * would be, on `viz.kind` / `card_script`. A host that has never heard of
 * "custom:monkface" does not claim the key and draws its own dial instead, so
 * this module still renders correctly on an older Schwung.
 *
 * `face` MUST STAY ON THE SAME PAGE AS `vowel`. drawCell cannot read — it is
 * handed the page's value map — so the mouth widget learns which character's
 * anchors to use only because `face` is a sibling key on that page. Move it to
 * a child level and every mouth silently falls back to the Monk rig.
 */
static const char CHAIN_PARAMS_JSON[] =
"["
 /* NOT A KNOB any more. It was one only so the mouth widget beside it could
  * read it off the page, which spent one of eight cells on a 17x15 head nobody
  * could read. It is declared here so it has metadata, and reaches the widget
  * through `extra_keys` on `vowel` instead. */
 "{\"key\":\"face\",\"name\":\"Who\",\"short_name\":\"Who\",\"type\":\"int\","
  "\"min\":0,\"max\":11,\"step\":1,\"default\":0,\"access\":\"read\","
  "\"show_value\":false},"
 /* LIVE: pad pressure drives this past whatever the knob says, so the host
  * keeps its effective value refreshed every tick and every picture of it --
  * the cell widget and the face page -- moves with the pressure rather than
  * sitting frozen where the knob was left. */
 "{\"key\":\"vowel\",\"name\":\"Vowel\",\"short_name\":\"Vow\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5,\"live\":true,"
  /* THE MOUTH, and the character it belongs to.
   *
   * `extra_keys` names a value the picture needs that has NO CELL on this page.
   * The mouth's five anchor shapes are per character, so the widget has to know
   * which of the twelve is loaded -- and a widget cannot read, it is handed the
   * page's value map. Before extra_keys existed the only way to get a fact to a
   * widget was to give it a knob, which is exactly the useless "Who" cell this
   * replaces. It costs one extra read stop in the page's rotation. */
  "\"viz\":{\"kind\":\"custom:monkmouth\",\"extra_keys\":[\"face\"]},"
  "\"card_script\":\"cards.js#vowel_card\",\"card_w\":104,\"card_h\":46},"
 "{\"key\":\"head_size\",\"name\":\"Head Size\",\"short_name\":\"Head\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 "{\"key\":\"aspiration\",\"name\":\"Breath\",\"short_name\":\"Brth\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 "{\"key\":\"glide\",\"name\":\"Glide\",\"short_name\":\"Gld\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 "{\"key\":\"vibrato\",\"name\":\"Vibrato\",\"short_name\":\"Vib\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"delay\",\"name\":\"Delay\",\"short_name\":\"Dly\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.8},"
 "{\"key\":\"level\",\"name\":\"Level\",\"short_name\":\"Lvl\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":1},"
 "{\"key\":\"vibrato_rate\",\"name\":\"Vib Rate\",\"short_name\":\"VbRt\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 "{\"key\":\"attack\",\"name\":\"Attack\",\"short_name\":\"Atk\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"decay\",\"name\":\"Decay\",\"short_name\":\"Dec\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"sustain\",\"name\":\"Sustain\",\"short_name\":\"Sus\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":1},"
 "{\"key\":\"release\",\"name\":\"Release\",\"short_name\":\"Rel\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"unison\",\"name\":\"Unison\",\"short_name\":\"Uni\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"unison_detune\",\"name\":\"Detune\",\"short_name\":\"Det\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"unison_spread\",\"name\":\"Spread\",\"short_name\":\"Spr\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0},"
 "{\"key\":\"delay_rate\",\"name\":\"Delay Rate\",\"short_name\":\"DlRt\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 /* Four modes, and the DEFAULT one sweeps the VOWEL, not the pitch — see
  * route_expression. Move has no wheels, so pad pressure is the source. */
 "{\"key\":\"pressure_routing\",\"name\":\"Pressure\",\"short_name\":\"Prs\",\"type\":\"enum\","
  "\"options\":[\"Vowel\",\"Pitch\",\"Both\",\"Both Inv\"],\"default\":0},"
 "{\"key\":\"bend_range\",\"name\":\"Bend Range\",\"short_name\":\"Bend\",\"type\":\"float\","
  "\"min\":0,\"max\":12,\"step\":0.5,\"default\":2,\"unit\":\"st\"},"
 /*
  * How far full pressure moves the vowel FROM the knob. 0 means the pad does
  * nothing and the knob is the whole story.
  *
  * DEFAULT 0.5, NOT 1, and that is the difference between composing the two and
  * merely relocating the conflict. At 1 the sum saturates: knob at 0.3 plus
  * full pressure clamps to 1.0, and so does knob at 0.0 -- so while you lean on
  * a pad the knob does nothing at all, which is the same complaint in a new
  * place. At 0.5 a hard press moves half the range from wherever the knob is,
  * so both controls are always live.
  */
 "{\"key\":\"pressure_depth\",\"name\":\"Prs Depth\",\"short_name\":\"Dpth\",\"type\":\"float\","
  "\"min\":0,\"max\":1,\"step\":0.01,\"default\":0.5},"
 /*
  * THE FACE IS THE PRESET BROWSER.
  *
  * `as_page` puts it in the level's jog rotation carrying the level's own
  * knobs; `preset_browser` merges it WITH the level's browser rather than
  * adding a page beside it. So it is the first page you land on, the jog steps
  * through the twelve characters once entered, the eight encoders still edit
  * the sound, and it animates because the host redraws it every tick.
  *
  * A face per character is a better picker than a row of text, and two pages --
  * one showing the character and one naming it -- would be two doors onto the
  * same choice. The header and footer stay the host's.
  */
 "{\"key\":\"big_face\",\"name\":\"Face\",\"short_name\":\"Face\",\"type\":\"canvas\","
  "\"canvas_script\":\"canvas.js\",\"as_page\":true,\"preset_browser\":true,"
  "\"show_value\":false}"
"]";

static const char UI_HIERARCHY_JSON[] =
"{"
 "\"pad_layout\":\"chromatic\","
 "\"levels\":{"
  "\"root\":{"
   "\"label\":\"MonkSynth\","
   "\"list_param\":\"preset\",\"count_param\":\"preset_count\",\"name_param\":\"preset_name\","
   "\"knobs\":[\"vowel\",\"head_size\",\"aspiration\",\"glide\",\"vibrato\",\"unison\",\"delay\",\"level\"],"
   "\"params\":["
     "{\"key\":\"big_face\"},"
     "{\"key\":\"vowel\"},{\"key\":\"head_size\"},{\"key\":\"aspiration\"},"
     "{\"key\":\"glide\"},{\"key\":\"vibrato\"},{\"key\":\"unison\"},"
     "{\"key\":\"delay\"},{\"key\":\"level\"},"
     "{\"level\":\"envelope\",\"label\":\"Envelope\"},"
     "{\"level\":\"unison\",\"label\":\"Unison\"},"
     "{\"level\":\"motion\",\"label\":\"Vibrato & Delay\"},"
     "{\"level\":\"expression\",\"label\":\"Expression\"}"
   "]"
  "},"
  "\"envelope\":{\"label\":\"Envelope\","
   "\"knobs\":[\"attack\",\"decay\",\"sustain\",\"release\"],"
   "\"params\":[{\"key\":\"attack\"},{\"key\":\"decay\"},{\"key\":\"sustain\"},{\"key\":\"release\"}]},"
  "\"unison\":{\"label\":\"Unison\","
   "\"knobs\":[\"unison\",\"unison_detune\",\"unison_spread\"],"
   "\"params\":[{\"key\":\"unison\"},{\"key\":\"unison_detune\"},{\"key\":\"unison_spread\"}]},"
  "\"motion\":{\"label\":\"Vibrato & Delay\","
   "\"knobs\":[\"vibrato\",\"vibrato_rate\",\"delay\",\"delay_rate\"],"
   "\"params\":[{\"key\":\"vibrato\"},{\"key\":\"vibrato_rate\"},{\"key\":\"delay\"},{\"key\":\"delay_rate\"}]},"
  "\"expression\":{\"label\":\"Expression\","
   "\"knobs\":[\"pressure_routing\",\"pressure_depth\",\"bend_range\"],"
   "\"params\":[{\"key\":\"pressure_routing\"},{\"key\":\"pressure_depth\"},{\"key\":\"bend_range\"}]}"
 "}"
"}";

static int serve(char *buf, int len, const char *src) {
    const int n = (int)strlen(src);
    if (n >= len) return -1;
    memcpy(buf, src, (size_t)n + 1);
    return n;
}

static int v2_get_param(void *instance, const char *key, char *buf, int buf_len) {
    monk_inst_t *in = (monk_inst_t *)instance;
    if (!in || !key || !buf || buf_len <= 0) return -1;

    if (strcmp(key, "chain_params") == 0) return serve(buf, buf_len, CHAIN_PARAMS_JSON);
    if (strcmp(key, "ui_hierarchy") == 0) return serve(buf, buf_len, UI_HIERARCHY_JSON);

    /* The preset browser's triple. */
    if (strcmp(key, "preset") == 0)       return snprintf(buf, buf_len, "%d", in->preset);
    if (strcmp(key, "preset_count") == 0) return snprintf(buf, buf_len, "%d", CHAR_COUNT);
    if (strcmp(key, "preset_name") == 0) {
        const int i = (in->preset >= 0 && in->preset < CHAR_COUNT) ? in->preset : 0;
        return serve(buf, buf_len, CHARACTERS[i].name);
    }

    /* The face index, and its id — the JS surfaces key their art off the id so
     * a reordering of CHARACTERS cannot silently repaint the wrong character. */
    if (strcmp(key, "face") == 0)     return snprintf(buf, buf_len, "%d", in->preset);
    if (strcmp(key, "face_id") == 0) {
        const int i = (in->preset >= 0 && in->preset < CHAR_COUNT) ? in->preset : 0;
        return serve(buf, buf_len, CHARACTERS[i].id);
    }

    /*
     * `vowel` and `vowel:base` are the same answer: what the KNOB is set to.
     * The host asks for `:base` once a key is live, and falls back to the plain
     * key on a miss -- serving it directly saves that second read on every
     * refresh of the most-read key on the page.
     */
    if (strcmp(key, "vowel") == 0 || strcmp(key, "vowel:base") == 0)
        return snprintf(buf, buf_len, "%.4f", in->vowel);

    /*
     * The DRIVEN vowel, per the `<key>:effective` convention: a plain read of a
     * modulated key answers the base, and pad pressure is a modulation. This is
     * what the fullscreen face asks for so the mouth follows what is sounding
     * rather than where the knob was left.
     */
    if (strcmp(key, "vowel:effective") == 0) {
        /*
         * THE ENGINE'S VOWEL IS ONLY LIVE WHILE SOMETHING IS SOUNDING.
         *
         * monk_synth_get_vowel returns voices[0].current_vowel, and that is
         * advanced by apply_portamento -- which sits INSIDE the
         * `if (v->active || env_stage == ENV_RELEASE)` branch of
         * monk_voice_process. With no note playing it is frozen at whatever the
         * last one ended on, so turning the vowel knob moved nothing on screen
         * until you pressed a pad. Reported exactly that way from hardware.
         *
         * Silent, the honest answer is what WOULD be sung: the knob plus
         * pressure, which is the value the engine will snap to the moment a
         * note starts.
         */
        const float ev = monk_synth_is_active(in->engine)
                       ? monk_synth_get_vowel(in->engine)
                       : combined_target(in);
        return snprintf(buf, buf_len, "%.4f", ev);
    }
    if (strcmp(key, "amplitude") == 0)
        return snprintf(buf, buf_len, "%.4f", monk_synth_amplitude(in->engine));
    if (strcmp(key, "active") == 0)
        return snprintf(buf, buf_len, "%d", monk_synth_is_active(in->engine) ? 1 : 0);

    if (strcmp(key, "pressure_routing") == 0) return snprintf(buf, buf_len, "%d", in->route);
    if (strcmp(key, "pressure_routing_name") == 0)
        return serve(buf, buf_len, ROUTE_NAMES[in->route >= 0 && in->route < ROUTE_COUNT ? in->route : 0]);
    if (strcmp(key, "bend_range") == 0) return snprintf(buf, buf_len, "%.2f", in->bend_range);
    if (strcmp(key, "pressure_depth") == 0) return snprintf(buf, buf_len, "%.4f", in->pressure_depth);

    for (int i = 0; i < P_COUNT; i++)
        if (strcmp(key, PARAM_KEYS[i]) == 0)
            return snprintf(buf, buf_len, "%.4f", in->p[i]);

    /*
     * The autosave / user-preset snapshot. A chain component is expected to
     * answer this even when it has little to say; without it the shadow UI logs
     * "synth:state read FAILED after retries" every few seconds and declines to
     * write the slot file at all.
     */
    if (strcmp(key, "state") == 0) {
        int n = snprintf(buf, buf_len, "{\"preset\":%d,\"vowel\":%.4f,"
                         "\"pressure_routing\":%d,\"bend_range\":%.2f,"
                         "\"pressure_depth\":%.4f",
                         in->preset, in->vowel, in->route, in->bend_range,
                         in->pressure_depth);
        if (n < 0 || n >= buf_len) return -1;
        for (int i = 0; i < P_COUNT; i++) {
            const int m = snprintf(buf + n, (size_t)(buf_len - n), ",\"%s\":%.4f",
                                   PARAM_KEYS[i], in->p[i]);
            if (m < 0 || n + m >= buf_len) return -1;
            n += m;
        }
        if (n + 2 > buf_len) return -1;
        buf[n++] = '}';
        buf[n] = '\0';
        return n;
    }

    return -1;
}

/* --------------------------------------------------------------------- init */

static plugin_api_v2_t g_api;

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host) {
    g_host = host;
    memset(&g_api, 0, sizeof(g_api));
    g_api.api_version      = 2;
    g_api.create_instance  = v2_create_instance;
    g_api.destroy_instance = v2_destroy_instance;
    g_api.on_midi          = v2_on_midi;
    g_api.set_param        = v2_set_param;
    g_api.get_param        = v2_get_param;
    g_api.render_block     = v2_render_block;
    return &g_api;
}
