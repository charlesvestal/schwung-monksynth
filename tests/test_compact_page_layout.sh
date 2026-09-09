#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, subprocess, sys

ui = json.loads(subprocess.check_output(
    [sys.executable, "scripts/extract_contract.py"]))["ui_hierarchy"]
levels = ui["levels"]

expected_effects = [
    "vibrato", "vibrato_rate", "delay", "delay_rate",
    "unison", "unison_detune", "unison_spread",
]
expected_envelope = [
    "attack", "decay", "sustain", "release",
    "pressure_routing", "pressure_depth", "bend_range",
]

if set(levels) != {"root", "effects", "envelope"}:
    sys.exit(f"FAIL: expected two detail pages, got {list(levels)}")
if levels["effects"]["knobs"] != expected_effects:
    sys.exit(f"FAIL: effects rows are {levels['effects']['knobs']}")
if levels["envelope"]["knobs"] != expected_envelope:
    sys.exit(f"FAIL: envelope rows are {levels['envelope']['knobs']}")

links = [p.get("level") for p in levels["root"]["params"] if "level" in p]
if links != ["effects", "envelope"]:
    sys.exit(f"FAIL: root detail-page links are {links}")

print("PASS: two compact detail pages preserve requested row grouping")
PY
