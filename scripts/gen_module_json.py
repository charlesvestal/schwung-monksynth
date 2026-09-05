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
    # The floor for the CATALOG entry, recorded here so the two cannot drift and
    # so the requirement is discoverable from the module itself.
    #
    # 1.2.1 is "anything after 1.2.0", which is what this actually needs: every
    # host feature it depends on (widgetKinds, viz.extra_keys, as_page,
    # preset_browser, "live") landed after the v1.2.0 release. Naming the next
    # release instead would be wrong in the other direction -- both comparators
    # are numeric per component (store_utils.compareVersions, the manager's
    # isNewerSemver), so 1.2.1 correctly admits 1.3.0 while a floor of 1.3.0
    # would wrongly reject a 1.2.1 host that did carry them.
    #
    # NOTE the manager reads this from module-catalog.json, NOT from here.
    "min_host_version": "1.2.1",
    # Must be dsp.so for a sound_generator -- see scripts/build.sh. The chain
    # host does not read this field at all on the synth path; it is here for
    # module_manager.c's standalone load, and for the two to agree.
    "dsp": "dsp.so",
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
