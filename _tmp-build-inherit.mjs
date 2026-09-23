// 临时构建脚本：build.mjs 的 esbuild JS API 需 spawn stdio:pipe 的 service
// 子进程（dsh 沙箱禁止命名管道 → EPERM）。本脚本改走 esbuild CLI——bin
// 脚本以 stdio:inherit spawn esbuild.exe，不受该限制，产物与 build.mjs
// 完全一致。构建完成后本文件按「绝不删除」协议改名 Delete_ 前缀留痕。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('./node_modules/esbuild/bin/esbuild', import.meta.url))
const nodePaths = fileURLToPath(new URL('./node_modules', import.meta.url))
const env = { ...process.env, NODE_PATH: nodePaths }

// 2026-09-02 复用：PR #6 引入 src/run-send.tsx（JSX），build.mjs 显式给
// .tsx 指定 tsx loader——CLI 同步该参数（与 build.mjs 完全一致）。
const tsxLoader = '--loader:.tsx=tsx'

const host = spawnSync(process.execPath, [
  bin, 'src/index.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
  '--outfile=lib/index.js', '--sourcemap', '--log-level=info', '--external:web-push',
  tsxLoader,
], { stdio: 'inherit', env })
if (host.status !== 0) process.exit(host.status ?? 1)

const clientBanner = [
  'window.__ModuleLoader__.load({',
  '  id: "meow-smooth",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')
const clientFooter = [
  '    return module.exports;',
  '  }',
  '});',
].join('\n')

const client = spawnSync(process.execPath, [
  bin, 'src/client.ts', '--bundle', '--platform=browser', '--format=cjs', '--target=es2022',
  '--outfile=lib/client.js', '--sourcemap', '--log-level=info',
  '--external:react', '--external:react/jsx-runtime', '--external:react-dom', '--external:react-dom/client',
  tsxLoader,
  `--banner:js=${clientBanner}`,
  `--footer:js=${clientFooter}`,
], { stdio: 'inherit', env })
if (client.status !== 0) process.exit(client.status ?? 1)

console.log('[build-inherit] all artifacts done')
