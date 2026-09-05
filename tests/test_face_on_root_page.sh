#!/usr/bin/env bash
#
# THE MOUTH WIDGET MUST BE ABLE TO LEARN WHICH CHARACTER IS LOADED.
#
# Its five anchor shapes are per character, and a widget CANNOT READ -- it is
# handed the page's value map and nothing else. So `face` has to reach it
# somehow, and the two ways are not equal:
#
#   as a KNOB on the same page   works, and spends one of eight cells on a
#                                17x15 head nobody can read, purely so the cell
#                                beside it can see a number. This is what the
#                                module shipped first, and it was rightly
#                                called useless on hardware.
#
#   as extra_keys on the viz     the widget NAMES the off-page value; the
#                                controller adds it to the read rotation as one
#                                extra stop and hands it over in `values`.
#
# The second is what this pins. Get it wrong and every mouth silently draws
# "--": no error, no log line, just a cell that never shows anything.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, subprocess, sys
c = json.loads(subprocess.check_output([sys.executable, "scripts/extract_contract.py"]))
knobs = c["ui_hierarchy"]["levels"]["root"]["knobs"]
params = {p["key"]: p for p in c["chain_params"]}

if "vowel" not in knobs:
    sys.exit(f"FAIL: 'vowel' is not a knob on the root page (knobs={knobs})")

if "face" in knobs:
    sys.exit("FAIL: 'face' is a knob again. It should reach the widget through "
             "the vowel widget's extra_keys, not by occupying a cell.")

viz = params["vowel"].get("viz") or {}
kind = viz.get("kind")
if not kind:
    sys.exit("FAIL: vowel declares no custom viz kind")

extra = viz.get("extra_keys") or []
if "face" not in extra:
    sys.exit("FAIL: the vowel widget must declare extra_keys ['face'], or it "
             f"cannot know whose mouth to draw; got {extra}")

if params["face"].get("access") != "read":
    sys.exit("FAIL: 'face' must stay access:'read' -- it is set by loading a "
             "character, never turned")

canvas = open("src/ui/canvas.js").read()
if '"%s"' % kind not in canvas:
    sys.exit(f"FAIL: {kind} is declared in chain_params but canvas.js never "
             "names it, so it would never register and the cell would fall "
             "back to a built-in dial")

print(f"PASS: vowel is a root knob drawing {kind}, reaching 'face' via extra_keys")
PY
