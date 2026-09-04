#!/usr/bin/env bash
#
# The C character table and the JS face table must agree, BY POSITION.
#
# `face` is served to the knob grid as an INTEGER INDEX, and drawCell resolves
# it with FACES[i]. A card or a cell therefore paints whichever face sits at
# that position in canvas.js -- so inserting a character in the C table without
# inserting it at the same position in the JS one silently draws the wrong
# character for every entry after it. That is a defect with no error, a
# plausible picture, and no way to notice except by knowing what a cow looks
# like, which is exactly the class of bug a source pin is for.
set -euo pipefail
cd "$(dirname "$0")/.."

c_ids=$(sed -n '/^static const monk_character_t CHARACTERS/,/^};/p' src/dsp/monksynth_plugin.c \
        | sed -n 's/^[[:space:]]*{ "\([a-z]*\)",.*/\1/p')

js_ids=$(node -e '
const fs=require("fs");
const src=fs.readFileSync("src/ui/canvas.js","utf8");
const f=new Function("globalThis",src+";return globalThis.MONK_FACES_FOR_TEST;")({});
console.log(f.map(x=>x.id).join("\n"));
')

if [ "$c_ids" != "$js_ids" ]; then
    echo "FAIL: character order differs between the DSP and canvas.js"
    diff <(echo "$c_ids") <(echo "$js_ids") || true
    exit 1
fi

n=$(echo "$c_ids" | wc -l | tr -d ' ')
echo "PASS: $n characters, same ids in the same order in both tables"
