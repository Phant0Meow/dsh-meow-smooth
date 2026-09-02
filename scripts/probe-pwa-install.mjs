/**
 * 探针：PWA 可安装性诊断（安卓 Chrome"安装应用"判定）。
 *
 * 用 Chrome DevTools 协议的 Page.getInstallabilityErrors 拿 Chromium 引擎
 * 自己的可安装性判定（与安卓 Chrome 菜单"安装应用"同源逻辑），配合页面内
 * 实测 manifest 链接/SW 注册状态/图标可达性，输出可安装性缺口清单。
 *
 * 运行：node scripts/probe-pwa-install.mjs [baseUrl]
 * （默认 http://127.0.0.1:3080；localhost 属 secure context，SW 可注册，
 *  Chromium 的 installability 判定与 https 一致。）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9367
const profile = join(process.env.TEMP ?? '.', `meow-pwa-probe-${Date.now()}`)
const proc = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) break
    } catch {}
    await sleep(250)
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  return (await created.json()).webSocketDebuggerUrl
}

let ws
let seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 20000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
  return JSON.parse(res.result.value)
}
async function waitFor(label, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(150)
  }
  throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(2000) // 等 SW 注册/manifest 解析完成

  // 1. Chromium 引擎自己的可安装性判定（安卓"安装应用"同源逻辑）
  const errors = await call('Page.getInstallabilityErrors')
  console.log('--- getInstallabilityErrors ---')
  const list = errors?.installabilityErrors ?? []
  if (list.length === 0) console.log('PASS 无错误 — Chromium 判定当前页面可安装 PWA')
  for (const e of list) console.log(`ERROR ${e.errorId} — ${e.errorArgument ?? ''}`)

  // 2. 页面内 manifest 链接与内容
  const manifest = await evalJson(`(async () => {
    const links = [...document.querySelectorAll('link[rel="manifest"]')].map(l => l.href)
    if (links.length === 0) return JSON.stringify({ links })
    let m = null
    try {
      const res = await fetch(links[0])
      m = await res.json()
    } catch (e) { m = { fetchError: String(e) } }
    return JSON.stringify({ links, manifest: m })
  })()`)
  console.log('--- manifest ---')
  console.log(`链接 (${manifest.links.length} 个，首个生效): ${manifest.links.join(' | ')}`)
  console.log(JSON.stringify(manifest.manifest, null, 2))

  // 3. SW 注册状态
  const sw = await evalJson(`(async () => {
    if (!('serviceWorker' in navigator)) return JSON.stringify({ supported: false })
    const regs = await navigator.serviceWorker.getRegistrations()
    return JSON.stringify({
      supported: true, secure: window.isSecureContext,
      count: regs.length,
      scopes: regs.map(r => ({ scope: r.scope, active: r.active?.scriptURL ?? null })),
    })
  })()`)
  console.log('--- service worker ---')
  console.log(`secure=${sw.secure} 注册数=${sw.count}`)
  for (const s of sw.scopes) console.log(`  scope=${s.scope} active=${s.active}`)

  // 4. manifest 引用的资源可达性
  const assets = await evalJson(`(async () => {
    const urls = ['/plugins/meow-smooth/manifest.json', '/plugins/meow-smooth/icon-180.png',
      '/plugins/meow-smooth/icon-512.png', '/plugins/meow-smooth/sw.js']
    const out = []
    for (const u of urls) {
      try { const r = await fetch(u); out.push(u + ' -> ' + r.status) } catch (e) { out.push(u + ' -> ERR ' + e) }
    }
    return JSON.stringify(out)
  })()`)
  console.log('--- 资源可达性 ---')
  for (const line of assets) console.log(`  ${line}`)

  console.log(list.length === 0 ? 'RESULT PASS' : `RESULT ${list.length} 个安装性错误`)
} catch (error) {
  console.log('FAIL', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
