#!/usr/bin/env bash
# Build the P.533 engine to WebAssembly (wasm32-wasi reactor) with plain clang.
#
# Requirements (Debian/Ubuntu):
#   apt install clang lld wasi-libc libclang-rt-dev-wasm32   (or libclang-rt-18-dev-wasm32)
# Or use wasi-sdk: WASI_SYSROOT=/opt/wasi-sdk/share/wasi-sysroot CC=/opt/wasi-sdk/bin/clang ./build.sh
#
# Output: ../web/engine/p533.wasm
set -euo pipefail
cd "$(dirname "$0")"

CC="${CC:-clang}"
SYSROOT="${WASI_SYSROOT:-/usr}"
OUT=../web/engine/p533.wasm
mkdir -p ../web/engine

SRCS=(vendor/*.c ohp.c)

"$CC" --target=wasm32-wasi --sysroot="$SYSROOT" \
  ${OPT:--O3 -flto -msimd128 -mbulk-memory -mnontrapping-fptoint} \
  -mexec-model=reactor \
  -include ohp_shim.h -Ivendor \
  -DNDEBUG -std=gnu99 \
  -Wno-everything \
  -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=16777216 -Wl,--max-memory=1073741824 \
  "${SRCS[@]}" -o "$OUT"

ls -l "$OUT"
