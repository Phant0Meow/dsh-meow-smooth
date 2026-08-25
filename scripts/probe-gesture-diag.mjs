/**
 * 诊断（临时）：需求⑲ 手势触摸链路探针。连真实实例，装计数监听后
 * 派发与 e2e 相同的触摸序列，逐步报告事件到达情况、coarse 判定、
 * html 标记与轨道值——定位"短滑没触发"断在哪一环。
 * 运行：node scripts/probe-gesture-diag.mjs [baseUrl]
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
const PORT = 9342
const profile = join(process.env.TEMP ?? '.', `meow-gesture-diag-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
    await sleep(250)
  }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  return tab.webSocketDebuggerUrl
}
let ws, seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 15000)
  })
}
async function evalRaw(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) return { __exc: res.exceptionDetails.text }
  return res.result.value
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const logs = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error !== undefined ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) {
    const r = await evalRaw(`document.querySelector('[data-slot="root"] > *') !== null`)
    if (r === true) break
    await sleep(300)
  }
  await sleep(1200)

  console.log('--- 环境 ---')
  console.log(await evalRaw(`JSON.stringify({
    coarse: matchMedia('(pointer: coarse)').matches,
    hoverNone: matchMedia('(hover: none)').matches,
    touchPoints: navigator.maxTouchPoints,
    uaMobile: /Mobile/.test(navigator.userAgent),
    furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
    gestureCss: document.querySelector('style[data-meow-smooth-gesture-css]') !== null,
    gestureLoaded: document.documentElement.dataset.meowSmoothGestureLoaded ?? '(absent)',
  }))`)

  console.log('--- 资源与伺服内容 ---')
  console.log('resources>', await evalRaw(`JSON.stringify(performance.getEntriesByType('resource').map(r => r.name).filter(n => /meow/i.test(n)).slice(0, 15))`))
  console.log('scripts>', await evalRaw(`JSON.stringify([...document.querySelectorAll('script[src]')].map(s => s.src).filter(n => /meow/i.test(n)))`))
  console.log('refetch>', await evalRaw(`fetch('/plugins/meow-smooth/client.js', { cache: 'no-store' }).then(r => r.text()).then(t => JSON.stringify({ len: t.length, hasGestureMarker: t.includes('meowSmoothGestureLoaded') }))`))

  // 计数监听（capture，先于插件 handler 也无妨，只统计到达量）
  await evalRaw(`
    window.__c = { start: 0, move: 0, end: 0, len: -1, x0: null, lastDX: null }
    document.addEventListener('touchstart', (e) => {
      window.__c.start++
      window.__c.len = e.touches.length
      const t = e.touches[0]
      window.__c.x0 = t ? t.clientX : null
    }, { capture: true, passive: true })
    document.addEventListener('touchmove', () => { window.__c.move++ }, { capture: true, passive: true })
    document.addEventListener('touchend', () => { window.__c.end++ }, { capture: true, passive: true })
    'ok'
  `)

  console.log('--- 派发触摸序列 ---')
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 8, y: 420 }] })
  await sleep(50)
  console.log('afterStart:', JSON.stringify(await evalRaw('window.__c')))
  for (let i = 1; i <= 14; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 8 + i * 3, y: 420 }] })
    await sleep(20)
  }
  console.log('afterMoves:', JSON.stringify(await evalRaw('window.__c')))
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(600)
  console.log('afterEnd:', JSON.stringify(await evalRaw('window.__c')))

  // 长滑复现挂起场景 + 时间轴采样（phase/reveal 每 600ms 一次）
  console.log('--- timer 探活 ---')
  console.log('timer>', await evalRaw(`new Promise(r => setTimeout(() => r('timer-ok'), 120))`))
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 30, y: 420 }] })
  for (let i = 1; i <= 22; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 30 + i * 15, y: 420 }] })
    await sleep(25)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  console.log('--- 触摸后时间轴 ---')
  for (let i = 0; i < 8; i++) {
    const d = await evalRaw(`JSON.stringify(window.__meowGestureDebug ?? {})`)
    const tr = await evalRaw(`JSON.stringify((window.__meowGestureTrace ?? []).slice(-2))`)
    console.log(`t+${i * 600} debug=${d} traceTail=${tr}`)
    await sleep(600)
  }

  console.log('--- 终态 ---')
  console.log(await evalRaw(`JSON.stringify({
    furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
    gestureAttr: document.documentElement.getAttribute('data-meow-smooth-gesture'),
    track1: getComputedStyle(document.querySelector('[data-slot="root"] > *')).gridTemplateColumns.split(' ')[0],
    inlineCols: document.querySelector('[data-slot="root"] > *').style.gridTemplateColumns || '(none)',
  })`))
  console.log('--- 手势 trace ---')
  console.log(JSON.stringify(await evalRaw('window.__meowGestureTrace ?? []'), null, 1))
  console.log('--- 页面 console ---')
  for (const l of logs.slice(-12)) console.log('console>', l)
} catch (e) {
  console.log('DIAG-ERR', e.message)
} finally {
  proc.kill()
}
