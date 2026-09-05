#!/usr/bin/env bash
#
# The DSP binary must be called dsp.so, because that is what the chain host
# opens for a sound_generator -- it builds the path itself and does NOT read
# module.json's "dsp" field on that path:
#
#   sound_generator   <dir>/dsp.so           hardcoded
#   audio_fx          <dir>/<module-id>.so
#   midi_fx           <dir>/dsp.so           hardcoded
#
# Getting this wrong is a module that simply never loads, with one line in
# debug.log ("cannot open shared object file") and nothing on screen. It
# happened here: this repo was scaffolded from an audio-FX module, where
# <module-id>.so is correct, and shipped monksynth.so.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1"; exit 1; }

type=$(python3 -c "import json;print(json.load(open('src/module.json'))['component_type'])")
dsp=$(python3 -c "import json;print(json.load(open('src/module.json'))['dsp'])")
id=$(python3 -c "import json;print(json.load(open('src/module.json'))['id'])")

case "$type" in
  sound_generator|midi_fx) want="dsp.so" ;;
  audio_fx)                want="${id}.so" ;;
  *)                       echo "SKIP: no filename rule for component_type '$type'"; exit 0 ;;
esac

[ "$dsp" = "$want" ] || fail "component_type '$type' must ship '$want', module.json says '$dsp'"
grep -q -- "-o build/$want" scripts/build.sh || fail "build.sh does not build $want"
grep -q "dist/monksynth/$want" scripts/build.sh || fail "build.sh does not package $want"

# And if a tarball has been built, the name must actually be in it.
if [ -f dist/monksynth-module.tar.gz ]; then
    tar tzf dist/monksynth-module.tar.gz | grep -q "monksynth/$want$" \
        || fail "the built tarball does not contain monksynth/$want"

    # And NOTHING ELSE ending in .so. A rename that leaves the old artifact in
    # the staging dir ships both, which is how a stale plugin reaches a device.
    strays=$(tar tzf dist/monksynth-module.tar.gz | grep '\.so$' | grep -v "monksynth/$want$" || true)
    [ -z "$strays" ] || fail "the tarball carries stray shared objects: $strays"
fi

echo "PASS: a $type ships its binary as $want"
