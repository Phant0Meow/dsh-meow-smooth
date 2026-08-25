#!/usr/bin/env bash
# meow-smooth 构建壳（dev_build_plugin 生产线入口）：实际构建逻辑在
# build.mjs（esbuild 双产物：host ESM + client ModuleLoader 包装）。
# DSH_CHECKOUT 探测由生产线负责；本脚本只保证在插件目录内执行 node。
set -euo pipefail
cd "$(dirname "$0")/.."
node build.mjs
