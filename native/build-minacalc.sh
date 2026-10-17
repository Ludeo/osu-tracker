#!/bin/sh
# Compiles Etterna's MinaCalc (native/etterna) to WebAssembly for src/main/minacalc.js.
# Needs Emscripten (`em++` on PATH, e.g. via `source ~/emsdk/emsdk_env.sh`). The output is checked
# in, so this only has to run after updating the vendored calc.
set -eu
cd "$(dirname "$0")"

em++ -std=c++20 -O3 -DSTANDALONE_CALC -msse -msimd128 -Wno-inconsistent-missing-override \
  minacalc_wasm.cpp etterna/MinaCalc/MinaCalc.cpp \
  -o ../src/main/minacalc-wasm.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createMinaCalc -sENVIRONMENT=node -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_mc_version,_mc_calc,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU32,HEAPF32

echo "Built src/main/minacalc-wasm.js"
