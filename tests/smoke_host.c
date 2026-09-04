/*
 * A real consumer, on the host.
 *
 * Every other test in this repo reads SOURCE. None of them loads the module,
 * and a contract that parses is not a contract that works -- so this one does
 * what the chain host does: dlopen, move_plugin_init_v2, create_instance, read
 * the contract back, drive it with MIDI, and listen to what comes out.
 *
 * Built and run by tests/test_smoke.sh natively (not cross-compiled).
 */
#include <dlfcn.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "plugin_api_v1.h"

static int failures = 0;
static void ok(int cond, const char *what) {
    printf("  %s %s\n", cond ? "ok  " : "FAIL", what);
    if (!cond) failures++;
}

/* Peak absolute sample over a rendered block, 0..1. */
static double peak(const int16_t *buf, int frames) {
    int m = 0;
    for (int i = 0; i < frames * 2; i++) { int a = abs(buf[i]); if (a > m) m = a; }
    return m / 32768.0;
}

int main(int argc, char **argv) {
    const char *so = argc > 1 ? argv[1] : "build-host/monksynth-host.so";
    void *h = dlopen(so, RTLD_NOW);
    if (!h) { printf("dlopen failed: %s\n", dlerror()); return 1; }

    move_plugin_init_v2_fn init =
        (move_plugin_init_v2_fn)dlsym(h, MOVE_PLUGIN_INIT_V2_SYMBOL);
    ok(init != NULL, "exports move_plugin_init_v2");
    if (!init) return 1;

    /* The host hands a real struct; a NULL one would let a missing guard pass. */
    host_api_v1_t host;
    memset(&host, 0, sizeof(host));
    plugin_api_v2_t *api = init(&host);
    ok(api != NULL && api->api_version == 2, "api_version is 2");
    ok(api->create_instance && api->destroy_instance && api->on_midi &&
       api->set_param && api->get_param && api->render_block,
       "all six v2 entry points are non-NULL");

    void *inst = api->create_instance(".", NULL);
    ok(inst != NULL, "create_instance");
    if (!inst) return 1;

    char buf[8192];

    /* --- the contract the shadow UI will read --- */
    int n = api->get_param(inst, "chain_params", buf, sizeof(buf));
    ok(n > 0, "serves chain_params");
    ok(n > 0 && buf[0] == '[' && buf[n - 1] == ']', "chain_params is a JSON array");
    ok(strstr(buf, "custom:monkface") != NULL, "declares its custom widget kind");
    ok(strstr(buf, "card_script") != NULL, "declares the vowel card");

    n = api->get_param(inst, "ui_hierarchy", buf, sizeof(buf));
    ok(n > 0 && strstr(buf, "list_param") != NULL, "root declares the preset browser");

    /* A buffer too small must FAIL, not overflow. */
    char tiny[16];
    ok(api->get_param(inst, "chain_params", tiny, sizeof(tiny)) < 0,
       "refuses to serve chain_params into a short buffer");

    /* --- the preset browser triple --- */
    ok(api->get_param(inst, "preset_count", buf, sizeof(buf)) > 0 && atoi(buf) == 12,
       "preset_count is 12");

    int names_ok = 1, faces_ok = 1;
    for (int i = 0; i < 12; i++) {
        char idx[8]; snprintf(idx, sizeof(idx), "%d", i);
        api->set_param(inst, "preset", idx);
        if (api->get_param(inst, "preset", buf, sizeof(buf)) <= 0 || atoi(buf) != i) names_ok = 0;
        if (api->get_param(inst, "preset_name", buf, sizeof(buf)) <= 0 || buf[0] == '\0') names_ok = 0;
        /* face must track the loaded character -- the widgets index on it. */
        if (api->get_param(inst, "face", buf, sizeof(buf)) <= 0 || atoi(buf) != i) faces_ok = 0;
        if (api->get_param(inst, "face_id", buf, sizeof(buf)) <= 0 || buf[0] == '\0') faces_ok = 0;
    }
    ok(names_ok, "every preset selects and names itself");
    ok(faces_ok, "face and face_id follow the selected character");

    /* Out-of-range must be ignored, not crash or wrap. */
    api->set_param(inst, "preset", "99");
    api->get_param(inst, "preset", buf, sizeof(buf));
    ok(atoi(buf) == 11, "an out-of-range preset is ignored");

    /* --- a character must not stomp the live vowel --- */
    api->set_param(inst, "vowel", "0.9");
    api->set_param(inst, "preset", "6");            /* Dog, whose patch has a vowel */
    api->get_param(inst, "vowel", buf, sizeof(buf));
    ok(fabs(atof(buf) - 0.9) < 1e-3, "loading a character leaves vowel alone");

    /* --- audio --- */
    int16_t out[128 * 2];
    memset(out, 0xAB, sizeof(out));
    api->render_block(inst, out, 128);
    ok(peak(out, 128) == 0.0, "silent before any note");

    const uint8_t note_on[3] = { 0x90, 60, 100 };
    api->on_midi(inst, note_on, 3, MOVE_MIDI_SOURCE_INTERNAL);
    double p = 0;
    for (int i = 0; i < 60; i++) { api->render_block(inst, out, 128); double q = peak(out, 128); if (q > p) p = q; }
    ok(p > 0.02, "makes sound on a note");
    ok(p <= 1.0, "never exceeds full scale");
    printf("       peak after note on: %.3f\n", p);

    ok(api->get_param(inst, "active", buf, sizeof(buf)) > 0 && atoi(buf) == 1, "reports active");

    /* --- pressure sweeps the vowel, in the default routing --- */
    api->set_param(inst, "vowel", "0.0");
    api->set_param(inst, "pressure_routing", "0");     /* Vowel */
    const uint8_t at_hi[3] = { 0xA0, 60, 127 };
    api->on_midi(inst, at_hi, 3, MOVE_MIDI_SOURCE_INTERNAL);
    api->render_block(inst, out, 128);
    api->get_param(inst, "vowel:effective", buf, sizeof(buf));
    double eff = atof(buf);
    ok(eff > 0.5, "pad pressure drives the effective vowel");
    api->get_param(inst, "vowel", buf, sizeof(buf));
    ok(fabs(atof(buf) - 0.0) < 1e-6, "and leaves the knob's own value alone");

    /* Pressure for a note that is NOT on top must be ignored. */
    const uint8_t other_on[3] = { 0x90, 48, 100 };
    api->on_midi(inst, other_on, 3, MOVE_MIDI_SOURCE_INTERNAL);   /* 48 now on top */
    api->set_param(inst, "vowel", "0.0");
    const uint8_t at_lo[3] = { 0xA0, 60, 0 };                     /* pressure for 60 */
    api->on_midi(inst, at_lo, 3, MOVE_MIDI_SOURCE_INTERNAL);
    api->get_param(inst, "vowel:effective", buf, sizeof(buf));
    ok(atof(buf) > 0.5, "pressure from a non-top note is ignored");

    /* --- state round-trip --- */
    api->set_param(inst, "preset", "2");
    api->set_param(inst, "head_size", "0.1234");
    api->set_param(inst, "vowel", "0.4321");
    char saved[4096];
    ok(api->get_param(inst, "state", saved, sizeof(saved)) > 0, "serves state");

    void *inst2 = api->create_instance(".", NULL);
    api->set_param(inst2, "state", saved);
    api->get_param(inst2, "head_size", buf, sizeof(buf));
    ok(fabs(atof(buf) - 0.1234) < 1e-3, "state restores a knob moved after the preset");
    api->get_param(inst2, "vowel", buf, sizeof(buf));
    ok(fabs(atof(buf) - 0.4321) < 1e-3, "state restores vowel");
    api->get_param(inst2, "preset", buf, sizeof(buf));
    ok(atoi(buf) == 2, "state restores the character");
    api->destroy_instance(inst2);

    /* --- junk must not crash --- */
    api->set_param(inst, "no_such_key", "1");
    api->set_param(inst, "vowel", "not a number");
    api->set_param(inst, "state", "{{{garbage");
    ok(api->get_param(inst, "no_such_key", buf, sizeof(buf)) < 0, "unknown key returns -1");
    const uint8_t runt[1] = { 0x90 };
    api->on_midi(inst, runt, 1, MOVE_MIDI_SOURCE_INTERNAL);
    api->render_block(inst, out, 128);
    ok(1, "survives junk params and a truncated MIDI message");

    api->destroy_instance(inst);

    /*
     * OUTPUT LEVEL, ACROSS ALL TWELVE.
     *
     * A slot synth that is 10 dB quiet is not a bug anyone reports -- it just
     * sits under everything else in the chain and gets blamed on the mix. The
     * reference band for a healthy Schwung module is around -20 dBFS RMS, and
     * the vendored engine has a FIXED 0.1 attenuator (cc_volume) on top of our
     * `level`, so this is exactly the kind of thing an upstream sync could move
     * without anyone noticing.
     *
     * Measured over the SUSTAIN, skipping the first 40 blocks: sampling the
     * attack instead reads ~10 dB low and is what made this look broken at
     * first. Checked across every character, not one -- a calibration fitted at
     * a single point hides what it does at the others.
     */
    {
        double sum = 0, lo = 1e9, hi = -1e9;
        for (int p2 = 0; p2 < 12; p2++) {
            void *v = api->create_instance(".", NULL);
            char idx[8]; snprintf(idx, sizeof(idx), "%d", p2);
            api->set_param(v, "preset", idx);
            const uint8_t on[3] = { 0x90, 60, 100 };
            api->on_midi(v, on, 3, MOVE_MIDI_SOURCE_INTERNAL);
            double acc = 0; long cnt = 0;
            for (int i = 0; i < 200; i++) {
                api->render_block(v, out, 128);
                if (i < 40) continue;
                for (int k = 0; k < 256; k++) { double x = out[k] / 32768.0; acc += x * x; cnt++; }
            }
            double db = 20 * log10(sqrt(acc / cnt) + 1e-12);
            sum += db; if (db < lo) lo = db; if (db > hi) hi = db;
            api->destroy_instance(v);
        }
        double mean = sum / 12;
        printf("       level: mean %.1f dBFS RMS, spread %.1f dB\n", mean, hi - lo);
        ok(mean > -26.0 && mean < -14.0, "mean output level is in the healthy band");
        ok(hi - lo < 10.0, "no character is wildly louder or quieter than the rest");
    }

    dlclose(h);

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
