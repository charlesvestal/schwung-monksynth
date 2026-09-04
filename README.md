# MonkSynth for Schwung

A monophonic **formant (FOF) vocal synthesizer** for Ableton Move via
[Schwung](https://github.com/charlesvestal/schwung) — twelve singing
characters, each with its own voice and its own face on the 128×64 display.

An homage to the **Delay Lama** VST plug-in by AudioNerdz (2002), by way of
[MonkSynth](https://github.com/JonET/monksynth) by Jonathan Taylor and its
[iOS port](https://github.com/charlesvestal/monksynth-ios).

MonkSynth is offered completely free of charge. If you enjoy it, you are kindly
requested to make a donation at [savetibet.org](https://www.savetibet.org).

## What it is

- **Monophonic**, with a 16-deep note stack — overlapping notes retune rather
  than retrigger, and releasing the top note falls back to the one still held.
- **Twelve characters as presets.** Jog the Presets page and each one loads its
  own voice *and* its own face. Six are hand-tuned (Monk, Fish, Unicorn, Little
  Girl, Old Man, Cow); six are upstream's own factory patches wearing new faces
  (Dog, Ghost, Fire Fighter, Punk, Pizza, Cat).
- **Pad pressure sweeps the vowel.** The original did this with the pitch
  wheel; Move has neither a pitch wheel nor a mod wheel, so polyphonic
  aftertouch takes its place. Four routings: Vowel, Both, Both Inv, Pitch.
- **Unison** up to ten voices, with detune and vocal-tract spread, plus the
  stereo delay the factory characters were voiced with.

## The four drawing surfaces

This module is also a worked example of every module-supplied draw surface
Schwung offers, which is why the faces exist at four different scales from one
set of drawing functions:

| Surface | Where | What it draws |
|---|---|---|
| `drawCell` (Who) | knob grid | the loaded character's head — a **readout**, `access: "read"` |
| `drawCell` (Vowel) | knob grid | that character's **mouth**, cropped tight so the morph reads at 17×15 |
| `card_script` | floats while Vowel turns | the face mouthing the vowel, plus the anchor name and a travel bar |
| `type: "canvas"` | fullscreen | the whole character; the jog steps through all twelve |

Three constraints shaped that table, all of them discovered rather than
assumed, and all documented at the code:

- **One custom kind per module.** The host registers a single `widgetKind` from
  a hardcoded `canvas.js`, so both cells declare `custom:monkface` and
  `drawCell` tells them apart by key.
- **A cell cannot read.** It gets the page's value map, which is why `face` is
  pinned to the same page as `vowel` — with a test.
- **A card gets only `{w, h, name, value, raw}`.** No sibling keys at all, so
  the character reaches it through a timestamped stamp on `globalThis` that
  `drawCell` writes. See the long comment above `vowel_card`.

## Build

```bash
./scripts/build.sh          # cross-compiles for ARM64 in Docker
./scripts/install.sh        # scp to move.local (no restart needed)
```

## Test

```bash
for t in tests/*.sh; do bash "$t"; done
```

`tests/test_faces_render.sh` renders all twelve characters across all four
surfaces to a PNG and asserts each one actually drew, that nothing ran off the
panel, and that every glyph exists in the device font. Look at the sheet:

```bash
node tools/preview_faces.mjs && open faces-out/faces.png
```

## The DSP is vendored, and read-only

`src/dsp/{synth,voice,delay}.{c,h}` and `synth_internal.h` come from upstream
unmodified. Fix DSP bugs upstream and re-pull with `./scripts/sync_dsp.sh`;
never patch them here, or the next sync reverts the fix. `monksynth_plugin.c`
is the Schwung adapter and is ours.

`src/module.json` is **generated** from the C contract by
`scripts/gen_module_json.py` — don't hand-edit it.

## Measured costs

| | |
|---|---|
| `create_instance` | ~0.8 ms (2.58 MB, ten voices' tables) — a brief click on load |
| `render_block`, mono | 4.3 µs/block |
| `render_block`, unison 9 | 31.5 µs/block |

Against Schwung's ~2370 µs frame budget, on an Apple Silicon host; scale for
the Cortex-A72. Unison 10 is comfortably usable.

## Licence

MIT, © Jonathan Taylor for the DSP. See `LICENSE` and `NOTICE`.
