#!/usr/bin/env bash
#
# `face` must stay a KNOB on the SAME PAGE as `vowel`.
#
# drawCell cannot read: it is handed the page's value map and nothing else. The
# mouth widget on `vowel` learns which character's anchors to use only because
# `face` is a sibling key on that page. Move `face` to a child level and every
# mouth silently draws with no face at all -- the cell falls back to "--" and
# the card loses its picture, with no error anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, subprocess, sys
c = json.loads(subprocess.check_output([sys.executable, "scripts/extract_contract.py"]))
knobs = c["ui_hierarchy"]["levels"]["root"]["knobs"]
for k in ("face", "vowel"):
    if k not in knobs:
        sys.exit(f"FAIL: '{k}' is not a knob on the root page (knobs={knobs})")

params = {p["key"]: p for p in c["chain_params"]}
if params["face"].get("access") != "read":
    sys.exit("FAIL: 'face' must be access:'read' -- it is a readout, "
             "set by loading a character, never turned")

kinds = {k: params[k].get("viz", {}).get("kind") for k in ("face", "vowel")}
if len(set(kinds.values())) != 1 or not all(kinds.values()):
    sys.exit(f"FAIL: face and vowel must declare the SAME custom kind "
             f"(the host registers only one per module); got {kinds}")
print(f"PASS: face and vowel are both root knobs sharing {kinds['face']}, face is read-only")
PY
