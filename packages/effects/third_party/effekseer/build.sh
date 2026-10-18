#!/usr/bin/env bash
# Rebuilds the four runtime files in this folder from source (S6.01, DR-12): EffekseerForWeb at
# the commit below, with its Effekseer submodule (1.80.7), compiled by Emscripten 6.0.7, with
# FlatChat's patch (flatchat.patch). The output equals the files here byte for byte; with
# --patch=no it equals upstream's own CI build of that commit (run 32250773782, checked 2026-10-18).
#
#   bash build.sh WORKDIR [--patch=no]
#
# Needs git, python3, cmake, and about 2 GB in WORKDIR for the sources and the Emscripten SDK.
set -euo pipefail

FOR_WEB=https://github.com/effekseer/EffekseerForWeb.git
FOR_WEB_COMMIT=da76b5023bd7aa10fe66ee05f6fecd4b84debce3
EFFEKSEER_COMMIT=216c307192ff9bc7917472b05731bbc4fd46fa04
EMSDK_VERSION=6.0.7

here=$(cd "$(dirname "$0")" && pwd)
work=${1:?usage: build.sh WORKDIR [--patch=no]}
patch=yes
[ "${2:-}" = "--patch=no" ] && patch=no
mkdir -p "$work"
cd "$work"

[ -d emsdk ] || git clone --quiet https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install "$EMSDK_VERSION" >/dev/null
./emsdk/emsdk activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source ./emsdk/emsdk_env.sh >/dev/null 2>&1

[ -d EffekseerForWeb ] || git clone --quiet "$FOR_WEB"
cd EffekseerForWeb
git checkout --quiet "$FOR_WEB_COMMIT"
git submodule update --init --depth 1 Effekseer
(cd Effekseer && git checkout --quiet "$EFFEKSEER_COMMIT" && git submodule update --init --recursive --depth 1)
git checkout --quiet -- src
[ "$patch" = yes ] && git apply "$here/flatchat.patch"

for backend in webgl webgpu; do
  rm -rf "build_$backend"
  mkdir "build_$backend"
  (cd "build_$backend" && emcmake cmake -DEFK_WEB_BACKEND="$backend" ../src/cpp >/dev/null && cmake --build . -j "$(nproc)" >/dev/null)
done
mkdir -p out/wasm
cp build_webgl/effekseer-webgl-native.js build_webgpu/effekseer-webgpu-native.js out/
cp build_webgl/effekseer-webgl-native.wasm build_webgpu/effekseer-webgpu-native.wasm out/wasm/
(cd out && sha256sum effekseer-* wasm/effekseer-*)
if [ "$patch" = yes ]; then
  (cd out && for f in effekseer-* wasm/effekseer-*; do cmp -s "$f" "$here/$f" && echo "same: $f" || echo "DIFFERS: $f"; done)
fi
