#!/usr/bin/env python3
"""Write src/module.json, taking the contract from the C adapter."""
import json, pathlib, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

contract = json.loads(subprocess.check_output([sys.executable, str(HERE / "extract_contract.py")]))

module = {
    "id": "monksynth",
    "name": "MonkSynth",
    "version": "0.1.0",
    "description": ("Monophonic formant (FOF) vocal synthesizer with twelve singing "
                    "characters - an homage to Delay Lama. Pad pressure sweeps the vowel."),
    "author": "Jonathan Taylor (DSP), Charles Vestal (port)",
    "component_type": "sound_generator",
    "abbrev": "MK",
    "api_version": 2,
    "dsp": "monksynth.so",
    "capabilities": {
        "chainable": True,
        "audio_out": True,
        "audio_in": False,
        "midi_in": True,
        # Move has no pitch wheel and no mod wheel; the vowel sweep is driven by
        # polyphonic aftertouch, so the module must declare it or the host
        # filters pad pressure before it ever arrives.
        "aftertouch": True,
        "canvas_script": "canvas.js",
        "chain_params": contract["chain_params"],
    },
    "ui_hierarchy": contract["ui_hierarchy"],
}

out = ROOT / "src" / "module.json"
out.write_text(json.dumps(module, indent=2) + "\n")
print(f"wrote {out} ({out.stat().st_size} bytes)")
