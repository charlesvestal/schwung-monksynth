#!/usr/bin/env bash
#
# module.json's contract must equal the DSP's, because two copies of the same
# fact drift. module.json is GENERATED from the C (scripts/gen_module_json.py);
# this fails if someone hand-edited it instead.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, subprocess, sys
c = json.loads(subprocess.check_output([sys.executable, "scripts/extract_contract.py"]))
m = json.load(open("src/module.json"))
if m["capabilities"]["chain_params"] != c["chain_params"]:
    sys.exit("FAIL: module.json chain_params differ from the DSP's "
             "-- run scripts/gen_module_json.py")
if m["ui_hierarchy"] != c["ui_hierarchy"]:
    sys.exit("FAIL: module.json ui_hierarchy differs from the DSP's "
             "-- run scripts/gen_module_json.py")
print("PASS: module.json matches the DSP contract")
PY
