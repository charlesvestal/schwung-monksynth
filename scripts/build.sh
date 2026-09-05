#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="schwung-monksynth-builder"

if [ -z "$CROSS_PREFIX" ] && [ ! -f "/.dockerenv" ]; then
    echo "=== Building MonkSynth Module (via Docker) ==="
    if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm \
        -v "$REPO_ROOT:/build" \
        -u "$(id -u):$(id -g)" \
        -w /build \
        "$IMAGE_NAME" \
        ./scripts/build.sh
    exit 0
fi

CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}"
cd "$REPO_ROOT"

# module.json's contract is GENERATED from the C adapter, never hand-edited --
# see scripts/extract_contract.py. Regenerating here means a build can only
# ever package a manifest that matches the DSP it is packaging.
python3 scripts/gen_module_json.py

# CLEAN THE STAGING DIR, or a renamed artifact ships alongside its replacement.
# That is not hypothetical: this module's binary was renamed monksynth.so ->
# dsp.so and the next tarball contained BOTH, because packaging only ever
# copied in and never removed. A stale .so in a module directory is worse than
# clutter -- it is a second, older plugin sitting where a loader might find it.
rm -rf dist/monksynth
mkdir -p build dist/monksynth

# -ffast-math is deliberately NOT used. The vendored engine's grain scheduler
# relies on ordinary IEEE comparisons around zero, and upstream builds it
# without it; matching upstream's flags is what keeps a preset sounding the
# same in both ports.
${CROSS_PREFIX}gcc -O3 -shared -fPIC \
    -march=armv8-a -mtune=cortex-a72 \
    -fomit-frame-pointer -fno-stack-protector \
    -DNDEBUG \
    -Wall -Wextra \
    src/dsp/monksynth_plugin.c \
    src/dsp/synth.c \
    src/dsp/voice.c \
    src/dsp/delay.c \
    -o build/dsp.so \
    -Isrc/dsp \
    -lm

cp src/module.json  dist/monksynth/module.json
cp src/help.json    dist/monksynth/help.json
cp src/ui/canvas.js dist/monksynth/canvas.js
cp LICENSE          dist/monksynth/LICENSE
cp NOTICE           dist/monksynth/NOTICE
# THE BINARY MUST BE CALLED dsp.so, and that is not a convention -- it is what
# the chain host opens. It builds the path itself, and it uses a DIFFERENT rule
# per component type:
#
#   sound_generator   <dir>/dsp.so          hardcoded  (chain_host.c:444)
#   audio_fx          <dir>/<module-id>.so             (chain_host.c:272, 638)
#   midi_fx           <dir>/dsp.so          hardcoded  (chain_midi.c:259)
#
# module.json's "dsp" field is NOT consulted on any of those paths -- only
# module_manager.c reads it, for the standalone/menu load. So a sound generator
# named after itself dlopens nothing, and the only symptom is one line in
# debug.log: "cannot open shared object file". This module was built from an
# audio-FX template and shipped as monksynth.so for exactly that reason.
cp build/dsp.so dist/monksynth/dsp.so
chmod +x dist/monksynth/dsp.so

cd dist
tar -czf monksynth-module.tar.gz monksynth/
echo "=== built dist/monksynth-module.tar.gz ==="
