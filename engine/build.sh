#!/usr/bin/env bash
# Build the P.533 engine to WebAssembly (wasm32-wasip1 reactor) with clang.
#
# Recommended: wasi-sdk (https://github.com/WebAssembly/wasi-sdk/releases), as in CI:
#   WASI_SDK=/opt/wasi-sdk ./build.sh
# Or distro clang (Debian/Ubuntu: apt install clang lld wasi-libc libclang-rt-dev-wasm32).
# Older distro sysroots only ship the wasm32-wasi layout, so pass the old target name:
#   TARGET=wasm32-wasi ./build.sh
#
# Output: ../web/engine/p533.wasm (override with OUT=path)
set -euo pipefail
cd "$(dirname "$0")"

if [[ -n "${WASI_SDK:-}" ]]; then
  CC="${CC:-$WASI_SDK/bin/clang}"
  SYSROOT="${WASI_SYSROOT:-$WASI_SDK/share/wasi-sysroot}"
else
  CC="${CC:-clang}"
  SYSROOT="${WASI_SYSROOT:-/usr}"
fi
TARGET="${TARGET:-wasm32-wasip1}"
OUT="${OUT:-../web/engine/p533.wasm}"
mkdir -p "$(dirname "$OUT")"

SRCS=(vendor/*.c ohp.c)

"$CC" --version | head -1
"$CC" --target="$TARGET" --sysroot="$SYSROOT" \
  ${OPT:--O3 -flto -msimd128 -mbulk-memory -mnontrapping-fptoint} \
  -mexec-model=reactor \
  -include ohp_shim.h -Ivendor \
  -DNDEBUG -std=gnu99 \
  -Wno-everything \
  -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=16777216 -Wl,--max-memory=1073741824 \
  "${SRCS[@]}" -o "$OUT"

ls -l "$OUT"
