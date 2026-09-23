// 一次性探针：进会话后 dump 会话 header corner / 右栏 seat 的实际 DOM 状态。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const TOKEN = process.env.MEOW_E2E_TOKEN ?? ''

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
const PORT = 9343
const profile = join(process.env.TEMP ?? '.', `meow-probe-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
    await sleep(250)
  }
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
  if (res.exceptionDetails !== undefined) throw new Error('页面异常: ' + res.exceptionDetails.text)
  const v = res.result.value
  return typeof v === 'string' ? JSON.parse(v) : v
}
async function waitFor(label, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(250)
  }
  throw new Error('等待超时: ' + label + ' — ' + JSON.stringify(last))
}

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
await call('Emulation.setDeviceMetricsOverride', { width: 680, height: 844, deviceScaleFactor: 2, mobile: true })
await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await call('Page.navigate', { url: TOKEN ? `${BASE}/?token=${encodeURIComponent(TOKEN)}` : `${BASE}/` })
await waitFor('frame', `() => document.querySelector('[data-slot="root"] > *') !== null ? {ok:true} : {ok:false}`, 30000)
await sleep(1500)

await evalJson(`(() => { document.querySelector('[data-meow-smooth-fab]').click(); return JSON.stringify({ok:true}) })()`)
await sleep(700)
await evalJson(`(() => {
  const col = document.querySelector('[data-slot="sidebar"] > *')
  const frame = document.querySelector('[data-slot="root"] > *')
  if (frame !== null && frame.hasAttribute('data-sidebar-collapsed')) {
    const btns = col.firstElementChild.querySelectorAll('button')
    btns[btns.length - 1].click()
  }
  return JSON.stringify({ok:true})
})()`)
await waitFor('sidebar expanded', `() => {
  const frame = document.querySelector('[data-slot="root"] > *')
  return frame !== null && !frame.hasAttribute('data-sidebar-collapsed') ? {ok:true} : {ok:false}
}`)
await sleep(400)
const clicked = await evalJson(`(() => {
  const column = document.querySelector('[data-slot="sidebar"] > *')
  const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
  if (rows.length === 0) return JSON.stringify({ ok: false, why: 'no-row' })
  rows[0].click()
  return JSON.stringify({ ok: true, label: rows[0].textContent.slice(0, 20) })
})()`)
console.log('clicked:', JSON.stringify(clicked))
await sleep(2500)

const dump = await evalJson(`(() => {
  const corner = document.querySelector('[data-conversation-header-corner]')
  const expand = document.querySelector('[data-sidebar-right-expand]')
  const header = document.querySelector('[data-slot="conversation.session.header"] > header')
  const panel = document.querySelector('[data-sidebar-right-panel]')
  const rightbarCol = document.querySelector('[data-rightbar-col]')
  return JSON.stringify({
    url: location.pathname,
    headerExists: header !== null,
    headerText: header !== null ? header.textContent.slice(0, 60) : null,
    cornerExists: corner !== null,
    cornerHTML: corner !== null ? corner.innerHTML.slice(0, 500) : null,
    expandExists: expand !== null,
    panelExists: panel !== null,
    rightbarColHTML: rightbarCol !== null ? rightbarCol.innerHTML.slice(0, 300) : null,
  })
})()`)
console.log(JSON.stringify(dump, null, 2))
proc.kill()
ws.close()
process.exit(0)
