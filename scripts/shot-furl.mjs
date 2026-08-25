/** 截图：功能⑱ v3 原生切片留档（折叠 / 展开 / 会话页折叠——验证 header 让位）。 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const OUT = join(import.meta.dirname, '..', 'shots')
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9345
const profile = join(process.env.TEMP ?? '.', `meow-shot-${Date.now()}`)
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

let ws, seq = 0
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
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails)}`)
  return JSON.parse(res.result.value)
}
async function shot(name) {
  const res = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(res.data, 'base64'))
  console.log(`saved ${name}`)
}
async function waitFurled(want) {
  for (let i = 0; i < 50; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ frame: f !== null, furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.frame === true && r.furled === want) return
    await sleep(250)
  }
  throw new Error(`等待 furled=${want} 超时`)
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Fetch.requestPaused') {
      const body = Buffer.from(JSON.stringify({ approvals: [], questions: [], events: [] })).toString('base64')
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 200, body } }))
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Fetch.enable', { patterns: [{ urlPattern: '*://*/plugins/meow-smooth/pending*' }] })
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  await sleep(2500)
  await waitFurled(true)
  await sleep(600)
  await shot('furl-v3-1-folded.png')

  // 点小方块 → 直接展开
  await evalJson(`JSON.stringify((function(){ document.querySelector('[data-meow-smooth-fab]').click(); return '{}' })())`)
  await sleep(1000)
  await shot('furl-v3-2-expanded.png')

  // 展开态点一个会话 → 进入会话页自动折回（header 让位验证）
  const clicked = await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
    if (rows.length === 0) return JSON.stringify({ ok: false })
    rows[0].click()
    return JSON.stringify({ ok: true, label: rows[0].textContent.slice(0, 30) })
  })()`)
  console.log('clicked:', clicked)
  await waitFurled(true)
  await sleep(800)
  await shot('furl-v3-3-session-folded.png')

  // 边线归属探测：header 下边线是谁画的、跨不跨色块区域（x 0-56）
  const borderInfo = await evalJson(`(function(){
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    if (header === null) return JSON.stringify({ none: true })
    const cs = getComputedStyle(header)
    const next = header.nextElementSibling
    const ncs = next !== null ? getComputedStyle(next) : null
    const parent = header.parentElement
    const pcs = parent !== null ? getComputedStyle(parent) : null
    return JSON.stringify({
      headerH: header.getBoundingClientRect().height,
      headerBB: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
      nextTag: next ? next.tagName + ' ' + String(next.className).slice(0, 50) : null,
      nextBT: ncs ? ncs.borderTopWidth + ' ' + ncs.borderTopColor : null,
      parentTag: parent ? parent.tagName + ' ' + String(parent.className).slice(0, 50) : null,
      parentBB: pcs ? pcs.borderBottomWidth + ' ' + pcs.borderBottomColor : null,
      fabH: document.querySelector('[data-meow-smooth-fab]').getBoundingClientRect().height,
    })
  })()`)
  console.log('border info:', borderInfo)
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
