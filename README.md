# MonkSynth for Schwung

A monophonic **formant (FOF) vocal synthesizer** for Ableton Move via
[Schwung](https://github.com/charlesvestal/schwung) — twelve singing
characters, each with its own voice and its own face on the 128×64 display.

An homage to the **Delay Lama** VST plug-in by AudioNerdz (2002), by way of
[MonkSynth](https://github.com/JonET/monksynth) by Jonathan Taylor and its
[iOS port](https://github.com/charlesvestal/monksynth-ios).

MonkSynth is offered completely free of charge. If you enjoy it, you are kindly
requested to make a donation at [savetibet.org](https://www.savetibet.org).

## Features

- **Twelve characters.** Jog the Presets page and each one loads its own voice
  *and* its own face: Monk, Fish, Unicorn, Little Girl, Old Man, Cow, Dog,
  Ghost, Officer Eeoo, Punk, Pizza, Cat.
- **Pad pressure sweeps the vowel.** Move has no pitch or mod wheel, so
  polyphonic aftertouch takes the place of the original's pitch wheel. Four
  routings — Vowel, Pitch, Both, Both Inv — with an adjustable depth, and
  pressure *modifies* the Vowel knob rather than replacing it.
- **Monophonic with a 16-deep note stack.** Overlapping notes retune rather
  than retrigger, and releasing the top note falls back to the one still held.
- **Unison** up to ten voices, with detune and vocal-tract spread, plus the
  stereo delay the factory characters were voiced with.
- **The face is drawn everywhere:** as a mouth in the knob grid, as a card that
  floats while the Vowel knob turns, as a fullscreen portrait with a live vowel
  readout, and as the character picker page.

External gear on USB-A also gets real pitch bend, channel pressure and CC.

## Requirements

Schwung host **1.2.1 or newer**. On an older host the module still loads, but
the Vowel cell falls back to a plain dial, the card loses its face, and there
is no Face page.

## Install

Install from Schwung's Module Store, or build it yourself:

```bash
./scripts/build.sh          # cross-compiles for ARM64 in Docker
./scripts/install.sh        # scp to move.local (restart shadow_ui for UI changes)
```

## Test

```bash
for t in tests/*.sh; do bash "$t"; done
```

`tests/test_smoke.sh` builds the module natively, `dlopen`s it and drives it the
way the chain host does — the contract, all twelve presets, MIDI, pad pressure,
state round-trip, junk input, and the output level across every character.

`tests/test_faces_render.sh` renders all twelve characters across all four
drawing surfaces to a PNG and asserts each one actually drew, that nothing ran
off the panel, and that every glyph exists in the device font. To look at the
sheet:

```bash
node tools/preview_faces.mjs && open faces-out/faces.png
```

## Performance

| | |
|---|---|
| `create_instance` | ~0.8 ms (2.58 MB, ten voices' tables) |
| `render_block`, mono | 4.3 µs/block |
| `render_block`, unison 9 | 31.5 µs/block |
| output level | −21.3 dBFS RMS mean across the twelve, 6.8 dB spread |

Measured on an Apple Silicon host against Schwung's ~2370 µs frame budget;
scale for the Cortex-A72. Unison 10 is comfortably usable.

## Development notes

**The DSP is vendored and read-only.** `src/dsp/{synth,voice,delay}.{c,h}` and
`synth_internal.h` come from upstream unmodified. Fix DSP bugs upstream and
re-pull with `./scripts/sync_dsp.sh`; never patch them here, or the next sync
reverts the fix. `monksynth_plugin.c` is the Schwung adapter and is ours.

**`src/module.json` is generated** from the C contract by
`scripts/gen_module_json.py` — don't hand-edit it.

**Faces are drawn by one set of functions at four scales**, which makes this
module a worked example of every module-supplied draw surface Schwung offers:

| Surface | Where | What it draws |
|---|---|---|
| `drawCell` (Vowel) | knob grid | the character's **mouth**, cropped tight so the morph reads at 17×15 |
| `card_script` | floats while Vowel turns | the face mouthing the vowel, the anchor name and a travel bar |
| `type: "canvas"` | fullscreen | a legible portrait and live vowel readout |
| `drawPage` | character picker | the same portrait, cropped for the 120×45 picker frame |

A whole face is illegible in a 17×15 knob cell, which is why the grid shows
only the mouth and passes the character through `extra_keys`. A widget is
handed its page's value map and nothing else, so `face` is pinned to the same
page as `vowel` — with a test.

`min_host_version` is **1.2.1**, meaning "anything after v1.2.0", when the
`values`/`nowMs` card payload and the other surfaces above landed. Version
comparison is numeric per component, so that floor admits 1.3.0 too. The value
is read from the catalog entry, not from `module.json`; it is recorded in both
so they cannot drift, and `tools/preview_faces.mjs` refuses to run against a
checkout without those host features.

## Licence

MIT, © Jonathan Taylor for the DSP. See `LICENSE` and `NOTICE`.
