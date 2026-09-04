#!/usr/bin/env bash
# Build the module natively and drive it the way the chain host does.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build-host
cc -O1 -g -fPIC -shared -Isrc/dsp \
   src/dsp/monksynth_plugin.c src/dsp/synth.c src/dsp/voice.c src/dsp/delay.c \
   -o build-host/monksynth-host.so -lm
cc -O1 -g -Isrc/dsp tests/smoke_host.c -o build-host/smoke -ldl -lm
./build-host/smoke build-host/monksynth-host.so
