/**
 * 探针2：手势识别链路逐环旁听。
 * 在 document 上挂旁听 capture 监听（start/move/end），记录每次事件的
 * touches 数、目标、以及"若我是手势会怎么判"的关键量（frame 宽、furl、
 * coarse 缓存不可达→用 matchMedia 现算）。对照 __meowGestureTrace。
 * 运行：node scripts/probe-gesture-chain.mjs [baseUrl]
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
const PORT = 9346
const profile = join(process.env.TEMP ?? '.', `meow-probe-chain-${Date.now()}`)
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
    window.__log = []
    const tap = (type) => (e) => {
      const frame = document.querySelector('[data-slot="root"] > *')
      window.__log.push([
        type,
        'touches=' + e.touches.length,
        'x=' + Math.round(e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? -1),
        'y=' + Math.round(e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? -1),
        'tgt=' + (e.target instanceof Element ? e.target.tagName + '.' + String(e.target.className).slice(0, 24) : String(e.target)),
        'frameW=' + (frame ? Math.round(frame.getBoundingClientRect().width) : -1),
        'coarse=' + matchMedia('(pointer: coarse)').matches,
      ].join(' '))
    }
    document.addEventListener('touchstart', tap('start'), { capture: true, passive: true })
    document.addEventListener('touchmove', tap('move '), { capture: true })
    document.addEventListener('touchend', tap('end  '), { capture: true, passive: true })
    return JSON.stringify({ ok: true })
  })()`)

  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 420 }] })
  for (let i = 1; i <= 10; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 10 + 6 * i, y: 420 }] })
    await sleep(16)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  console.log('== 首页滑动的链路日志 ==')
  console.log(JSON.stringify(await evalJson(`(function(){
    return JSON.stringify({
      log: window.__log,
      trace: window.__meowGestureTrace ?? [],
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
    })
  })()`), null, 1))

  // == 会话页复测：展开边栏 → 点第一行 → 兜底收起 → 同坐标滑动 ==
  await evalJson(`(function(){
    const fab = document.querySelector('[data-meow-smooth-fab]')
    if (fab !== null) fab.click()
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(900)
  await evalJson(`(function(){
    const row = document.querySelector('div[role="treeitem"]')
    if (row !== null) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(900)
  // 兜底：若仍展开（已知独立 bug），点右侧窗口区收起。
  await evalJson(`(function(){
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame !== null && !frame.hasAttribute('data-sidebar-collapsed')) {
      const t = document.elementFromPoint(340, 420) ?? document.body
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 340, clientY: 420 }))
    }
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(700)
  console.log('== 会话页前置状态 ==', JSON.stringify(await evalJson(`(function(){
    const frame = document.querySelector('[data-slot="root"] > *')
    return JSON.stringify({
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      collapsed: frame !== null && frame.hasAttribute('data-sidebar-collapsed'),
      at: (() => { const e = document.elementFromPoint(8, 420); return e ? e.tagName + '.' + String(e.className).slice(0, 30) : null })(),
    })
  })()`)))
  await evalJson(`(function(){ window.__log = []; window.__meowGestureTrace.length = 0; return JSON.stringify({ ok: true }) })()`)
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 8, y: 420 }] })
  for (let i = 1; i <= 10; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 8 + 4.2 * i, y: 420 }] })
    await sleep(16)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  console.log('== 会话页滑动的链路日志 ==')
  console.log(JSON.stringify(await evalJson(`(function(){
    return JSON.stringify({
      log: window.__log,
      trace: window.__meowGestureTrace ?? [],
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      cols: getComputedStyle(document.querySelector('[data-slot="root"] > *')).gridTemplateColumns,
    })
  })()`), null, 1))
} catch (err) {
  console.log('探针异常 —', err.message)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
