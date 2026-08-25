/**
 * 诊断（临时）：抑制器存活探针。加载页面后手动派发合成 focusin，
 * 经 console 回传：ta 是否找到、focusin 是否派发到 document capture、
 * 抑制器 trace 内容、派发后焦点状态。
 * 运行：node scripts/probe-autofocus-alive.mjs [baseUrl]
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
const PORT = 9349
const profile = join(process.env.TEMP ?? '.', `meow-af-alive-${Date.now()}`)
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
      logs.push('[c] ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      logs.push('[EXC] ' + (d.exception?.description ?? d.text))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text))
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
  for (let i = 0; i < 40; i++) {
    if (await evalRaw(`document.querySelector('[data-slot="root"] > *') !== null`) === true) break
    await sleep(300)
  }
  // 等最新构建
  for (let i = 0; i < 15; i++) {
    const tag = await evalRaw(`JSON.stringify(document.documentElement.dataset.meowSmoothGestureLoaded ?? '')`)
    if (tag.includes('autofocus')) break
    await sleep(1000)
  }
  await sleep(1200)

  console.log('--- 初始状态 ---')
  await evalRaw(`document.documentElement.dataset.probeTest = 'hello'`)
  console.log(await evalRaw(`JSON.stringify({
    active: document.activeElement?.tagName ?? null,
    isTa: document.activeElement instanceof HTMLTextAreaElement,
    supTrace: window.__meowSuppressTrace ?? null,
    instId: window.__meowGestureInstanceId ?? null,
    applyStage: document.documentElement.dataset.meowApplyStage ?? '(absent)',
    probeTest: document.documentElement.dataset.probeTest ?? '(absent)',
    allDataset: JSON.stringify({...document.documentElement.dataset}),
  })`))

  console.log('--- 合成 focusin 探针 ---')
  const probeResult = await evalRaw(`(async function(){
    window.__syn = 0
    document.addEventListener('focusin', () => window.__syn++, { capture: true })
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ err: 'no ta' })
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await new Promise(r => setTimeout(r, 100))
    return JSON.stringify({
      syn: window.__syn,
      active: document.activeElement?.tagName ?? null,
      supTrace: window.__meowSuppressTrace ?? null,
    })
  })())`)
  console.log(`probeResult> ${JSON.stringify(probeResult)}`)
  console.log('--- 真实 focus 探针 ---')
  await evalRaw(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    ta.focus({ preventScroll: true })
    console.log('[af] focused real, active=' + (document.activeElement?.tagName ?? '?'))
  })())`)
  await sleep(400)
  console.log(await evalRaw(`JSON.stringify({
    active: document.activeElement?.tagName ?? null,
    supTrace: window.__meowSuppressTrace ?? null,
    supCalled: window.__supCalled ?? 'undefined',
  })`))
  console.log('--- 全部 console ---')
  for (const l of logs.slice(-15)) console.log(l)
} catch (e) {
  console.log('DIAG-ERR', e.message)
} finally {
  proc.kill()
}
