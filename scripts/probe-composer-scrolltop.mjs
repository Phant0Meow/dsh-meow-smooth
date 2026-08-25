/**
 * 探针4：composer 卡片的滚动容器拓扑——textarea 往上有哪些 overflow 可滚
 * 祖先？document 根滚动器有没有余量？决定「聚焦可视性修正」的实现路线。
 * 运行：node scripts/probe-composer-scrolltop.mjs [baseUrl]
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
const PORT = 9348
const profile = join(process.env.TEMP ?? '.', `meow-probe-cst-${Date.now()}`)
const proc = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) break } catch {}
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
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  await evalJson(`(async () => {
    for (let i = 0; i < 100; i++) {
      const f = document.querySelector('[data-slot="root"] > *')
      if (f !== null && document.documentElement.getAttribute('data-meow-smooth-furled') === 'true') break
      await new Promise(r => setTimeout(r, 300))
    }
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(800)

  const dump = label => evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ label: '${label}', err: 'no textarea' })
    const chain = []
    let node = ta.parentElement
    while (node !== null && node !== document.documentElement) {
      if (node instanceof HTMLElement) {
        const s = getComputedStyle(node)
        const scrollableY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1
        chain.push({
          tag: node.tagName,
          cls: String(node.className).slice(0, 34),
          oy: s.overflowY,
          sh: node.scrollHeight, ch: node.clientHeight,
          y: scrollableY,
        })
      }
      node = node.parentElement
    }
    const se = document.scrollingElement
    return JSON.stringify({
      label: '${label}',
      htmlOy: getComputedStyle(document.documentElement).overflowY,
      bodyOy: getComputedStyle(document.body).overflowY,
      rootScrollRoom: se ? se.scrollHeight - se.clientHeight : null,
      chain,
    })
  })()`)
  console.log(JSON.stringify(await dump('首页'), null, 1))
} catch (err) {
  console.log('探针异常 —', err.message)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
