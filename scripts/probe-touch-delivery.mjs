/**
 * 探针：CDP Input.dispatchTouchEvent 的触摸事件到底以什么形态到达页面？
 * 对照 document 级 touchstart/mousedown 计数器，一次触摸序列后读数。
 * 运行：node scripts/probe-touch-delivery.mjs [baseUrl]
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
const PORT = 9345
const profile = join(process.env.TEMP ?? '.', `meow-probe-touch-${Date.now()}`)
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
      if (document.querySelector('[data-slot="root"] > *') !== null) break
      await new Promise(r => setTimeout(r, 300))
    }
    window.__c = { ts: 0, md: 0, pd: 0 }
    document.addEventListener('touchstart', () => { window.__c.ts++ }, { capture: true, passive: true })
    document.addEventListener('mousedown', () => { window.__c.md++ }, { capture: true })
    document.addEventListener('pointerdown', (e) => { window.__c.pd += (e.pointerType === 'touch' ? 1 : 0) }, { capture: true })
    return JSON.stringify({ ready: true })
  })()`)

  // 场景 A：setTouchEmulationEnabled 之后直接派发。
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 420 }] })
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  console.log('场景A（emulation 先于 navigate）:', JSON.stringify(await evalJson(`JSON.stringify(window.__c)`)))

  // 场景 B：navigate 后重新启用触摸模拟再派发。
  await call('Emulation.setTouchEmulationEnabled', { enabled: false })
  await sleep(100)
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await evalJson(`(function(){ window.__c = { ts: 0, md: 0, pd: 0 }; return JSON.stringify(window.__c) })()`)
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 420 }] })
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  console.log('场景B（重启用后再派发）:', JSON.stringify(await evalJson(`JSON.stringify(window.__c)`)))

  // 场景 C：完整右滑序列（轻扫档位），逐步记录选区与手势轨迹。
  await evalJson(`(function(){
    window.__sellog = []
    document.addEventListener('selectionchange', () => {
      window.__sellog.push(document.getSelection().type)
    }, { capture: true })
    return JSON.stringify({ ok: true })
  })()`)
  const el = await evalJson(`(function(){
    const e = document.elementFromPoint(10, 420)
    return JSON.stringify({ tag: e ? e.tagName : null, cls: e ? String(e.className).slice(0, 60) : null,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      collapsed: (document.querySelector('[data-slot="root"] > *') ?? document.body).hasAttribute('data-sidebar-collapsed') })
  })()`)
  console.log('场景C 起点:', JSON.stringify(el))
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 420 }] })
  for (let i = 1; i <= 10; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 10 + 6 * i, y: 420 }] })
    await sleep(16)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  console.log('场景C 结果:', JSON.stringify(await evalJson(`(function(){
    return JSON.stringify({
      sellog: window.__sellog,
      selType: document.getSelection().type,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      trace: window.__meowGestureTrace ?? [],
    })
  })()`)))
} catch (err) {
  console.log('探针异常 —', err.message)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
