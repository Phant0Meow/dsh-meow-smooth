/** 探针：header 原始 padding 对称性 + 高度测量。 */
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
const PORT = 9357
const profile = join(process.env.TEMP ?? '.', `meow-probe5-${Date.now()}`)
const proc = spawn(edge, ['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) { try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) break } catch {} ; await sleep(250) }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  return (await created.json()).webSocketDebuggerUrl
}
let ws, seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时')) } }, 20000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails))
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
  for (let i = 0; i < 60; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ frame: f !== null })
    })()`)
    if (r.frame === true) break
    await sleep(300)
  }
  for (let i = 0; i < 60; i++) {
    const r = await evalJson(`(function(){
      const header = document.querySelector('[data-slot="conversation.session.header"] > header')
      return JSON.stringify({ header: header !== null, furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.header === true && r.furled === true) break
    await sleep(300)
  }
  await sleep(800)
  const m = await evalJson(`(function(){
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    if (header === null) return JSON.stringify({ none: true })
    const cs = getComputedStyle(header)
    const rect = header.getBoundingClientRect()
    const varVal = document.documentElement.style.getPropertyValue('--meow-smooth-header-pad')
    return JSON.stringify({
      padLeft: cs.paddingLeft, padRight: cs.paddingRight, padTop: cs.paddingTop,
      h: rect.height, w: rect.width, top: rect.top,
      varVal,
      titleLeft: header.firstElementChild ? header.firstElementChild.getBoundingClientRect().left : null,
    })
  })()`)
  console.log('header:', JSON.stringify(m))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}

