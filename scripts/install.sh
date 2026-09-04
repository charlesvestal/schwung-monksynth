#!/usr/bin/env bash
# Deploy a local build straight to the device, without going through a release.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEVICE="${DEVICE:-ableton@move.local}"
# Category subdir, per component_type. NOTE: sound_generators, not
# sound_generator -- the host pluralises the type when it lays modules out.
DEST="/data/UserData/schwung/modules/sound_generators/monksynth"

[ -d "$REPO_ROOT/dist/monksynth" ] || { echo "run scripts/build.sh first"; exit 1; }

ssh "$DEVICE" "mkdir -p $DEST"
scp "$REPO_ROOT"/dist/monksynth/* "$DEVICE:$DEST/"
echo "installed to $DEST"
echo "No restart needed: an external module is picked up on the next chain load."
