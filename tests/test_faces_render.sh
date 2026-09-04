#!/usr/bin/env bash
#
# Every character must actually DRAW, on every surface, without running off the
# panel. "It did not throw" is not the bar -- a face that puts four pixels on
# the screen also does not throw.
#
# Needs a schwung checkout for the device framebuffer + font; skipped (not
# failed) without one, so this repo still tests standalone.
set -euo pipefail
cd "$(dirname "$0")/.."
SCHWUNG="${SCHWUNG:-../schwung}"
if [ ! -f "$SCHWUNG/tools/param-pages/harness.mjs" ]; then
    echo "SKIP: no schwung checkout at $SCHWUNG (set SCHWUNG=<path>)"
    exit 0
fi
node tools/preview_faces.mjs --schwung "$SCHWUNG" --out faces-out/faces.png | tail -4
