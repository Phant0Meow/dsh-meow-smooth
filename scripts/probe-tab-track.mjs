/** 探针：标签行轨道线（灰线）由哪个伪元素/背景绘制、确切几何。 */
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
const PORT = 9365
const profile = join(process.env.TEMP ?? '.', `meow-probe9-${Date.now()}`)
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
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails)}`)
  return JSON.parse(res.result.value)
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
  for (let i = 0; i < 60; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ frame: f !== null, furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.frame === true && r.furled === true) break
    await sleep(300)
  }
  await evalJson(`JSON.stringify((function(){ document.querySelector('[data-meow-smooth-fab]').click(); return '{}' })())`)
  await sleep(1000)
  await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
    if (rows.length > 0) rows[0].click()
    return '{}'
  })()`)
  for (let i = 0; i < 40; i++) {
    const r = await evalJson(`(function(){
      return JSON.stringify({ furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.furled === true) break
    await sleep(300)
  }
  await sleep(800)

  const dump = await evalJson(`(function(){
    const tabs = document.querySelector('[data-slot="conversation.session.header"] > header > div[role="tablist"]')
      ?? document.querySelector('[data-slot="conversation.session.header"] > header > div:nth-child(2)')
    if (tabs === null) return JSON.stringify({ none: true })
    const r = tabs.getBoundingClientRect()
    const pseudo = (p) => {
      const cs = getComputedStyle(tabs, p)
      return {
        content: cs.content,
        position: cs.position,
        height: cs.height,
        bottom: cs.bottom,
        left: cs.left,
        right: cs.right,
        background: cs.backgroundColor,
        borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
      }
    }
    const activeTab = tabs.querySelector('[aria-selected="true"]') ?? tabs.querySelector('button')
    const activeAfter = activeTab !== null ? (() => {
      const cs = getComputedStyle(activeTab, '::after')
      return { content: cs.content, position: cs.position, height: cs.height, bottom: cs.bottom, background: cs.backgroundColor, left: cs.left, right: cs.right }
    })() : null
    return JSON.stringify({
      tabsRect: { top: r.top, bottom: r.bottom, h: r.height, w: r.width },
      tabsBg: getComputedStyle(tabs).backgroundImage.slice(0, 80),
      tabsAfter: pseudo('::after'),
      tabsBefore: pseudo('::before'),
      activeAfter,
    })
  })()`)
  console.log(JSON.stringify(dump, null, 1))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
