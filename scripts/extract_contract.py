#!/usr/bin/env python3
"""
Pull CHAIN_PARAMS_JSON / UI_HIERARCHY_JSON out of the C adapter.

The DSP is the authority: the shadow UI reads the contract from the loaded
component's get_param, not from module.json. But module.json must carry the
same thing so the module reads correctly in the picker before it is ever
instantiated. Rather than maintain two copies by hand, module.json is
GENERATED from the C, and tests/test_contract_matches_dsp.sh re-runs this and
fails on any drift.
"""
import json, re, sys, pathlib

SRC = pathlib.Path(__file__).resolve().parent.parent / "src" / "dsp" / "monksynth_plugin.c"

def literal(name, text):
    m = re.search(r'static const char %s\[\]\s*=\s*(.*?);\s*\n' % name, text, re.S)
    if not m:
        sys.exit("could not find %s" % name)
    body = m.group(1)
    # Concatenated C string literals, with /* comments */ interleaved.
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
    s = "".join(parts).replace('\\"', '"')
    return json.loads(s)

def main():
    text = SRC.read_text()
    out = {
        "chain_params": literal("CHAIN_PARAMS_JSON", text),
        "ui_hierarchy": literal("UI_HIERARCHY_JSON", text),
    }
    json.dump(out, sys.stdout, indent=2)
    print()

if __name__ == "__main__":
    main()
