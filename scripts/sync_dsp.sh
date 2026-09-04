#!/usr/bin/env bash
#
# Re-pull the vendored DSP.
#
# src/dsp/{synth,voice,delay}.{c,h} and synth_internal.h are READ-ONLY in this
# repo. Fix DSP bugs upstream and sync them down; never patch them here, or the
# next sync silently reverts the fix.
#
# The default source is a monksynth-ios checkout, which is where this copy came
# from and which vendors JonET/monksynth verbatim itself. Point it at a
# JonET/monksynth checkout instead if you prefer; the files are the same.
#
#   ./scripts/sync_dsp.sh [path-to-checkout]
#
# NOT synced, because they are ours: monksynth_plugin.c (the Schwung adapter)
# and plugin_api_v1.h (copied from the schwung host).
set -euo pipefail

SRC="${1:-../monksynth-ios}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DEST="$ROOT/src/dsp"

if [ ! -d "$SRC/dsp" ]; then
    echo "no dsp/ under '$SRC'" >&2
    echo "usage: $0 [path to a monksynth-ios or monksynth checkout]" >&2
    exit 1
fi

changed=0
for f in synth.c synth.h synth_internal.h voice.c voice.h delay.c delay.h; do
    if ! cmp -s "$SRC/dsp/$f" "$DEST/$f"; then
        cp "$SRC/dsp/$f" "$DEST/$f"
        echo "  updated $f"
        changed=1
    fi
done

if [ "$changed" -eq 0 ]; then
    echo "already in sync with $SRC"
else
    echo
    echo "DSP changed. Rebuild and re-render the faces before trusting anything:"
    echo "  ./scripts/build.sh && node tools/preview_faces.mjs"
fi
