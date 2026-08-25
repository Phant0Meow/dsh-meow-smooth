/**
 * 探针3：会话切换的两条点击路径对照。
 *  A. 合成 MouseEvent click（此前 e2e 用的方式）
 *  B. CDP Input.dispatchMouseEvent（真实输入管线，isTrusted=true）
 * 各自观察：是否真的切走了会话（hero 输入框消失？URL/标题变化？）+
 * 侧边栏是否自动收起。
 * 运行：node scripts/probe-session-switch.mjs [baseUrl]
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
const PORT = 9347
const profile = join(process.env.TEMP ?? '.', `meow-probe-sess-${Date.now()}`)
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

/** 快照：是否仍在首页（hero 容器在不在）+ 侧边栏状态 + 会话行清单。 */
const snapshot = () => evalJson(`(function(){
  const frame = document.querySelector('[data-slot="root"] > *')
  const hero = document.querySelector('[class*="_hero"]')
  const rows = [...document.querySelectorAll('div[role="treeitem"]')].map(r => (r.textContent ?? '').slice(0, 16))
  return JSON.stringify({
    furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
    collapsed: frame !== null && frame.hasAttribute('data-sidebar-collapsed'),
    track1: frame !== null ? getComputedStyle(frame).gridTemplateColumns.split(' ')[0] : null,
    onHome: hero !== null,
    rowCount: rows.length,
    rows: rows.slice(0, 5),
  })
})()`)

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

  // 展开边栏（点小方块）。
  await evalJson(`(function(){
    const fab = document.querySelector('[data-meow-smooth-fab]')
    if (fab !== null) fab.click()
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(1000)

  // ---- 路径 A：合成 click 点第一行 ----
  const rowA = await evalJson(`(function(){
    const row = document.querySelector('div[role="treeitem"]')
    if (row === null) return JSON.stringify(null)
    const r = row.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (row.textContent ?? '').slice(0, 24) })
  })()`)
  console.log('A 行位置:', rowA)
  await evalJson(`(function(){
    const row = document.querySelector('div[role="treeitem"]')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(1200)
  console.log('A 合成 click 后:', await snapshot())

  // ---- 路径 B''：展开分组 → 找真实会话行 → CDP 真实点击 ----
  // 分组头（projectRow）默认折叠、会话行不渲染：先真实点击展开分组。
  const grp = await evalJson(`(function(){
    const g = document.querySelector('div[role="treeitem"][aria-expanded="false"]')
    if (g === null) return JSON.stringify(null)
    const r = g.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (g.textContent ?? '').slice(0, 14) })
  })()`)
  console.log('展开分组:', grp)
  if (grp !== null) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: grp.x, y: grp.y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grp.x, y: grp.y, button: 'left', clickCount: 1 })
    await sleep(1000)
  }
  const target = await evalJson(`(function(){
    const rows = [...document.querySelectorAll('div[role="treeitem"]')]
    // 会话行特征：非 projectRow、无 aria-expanded。
    const sess = rows.filter(r => !String(r.className).includes('projectRow') && r.getAttribute('aria-expanded') === null)
    if (sess.length === 0) return JSON.stringify(null)
    const r = sess[0].getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (sess[0].textContent ?? '').slice(0, 24) })
  })()`)
  console.log('B 目标会话行:', target)
  if (target !== null) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await sleep(1500)
    console.log('B 真实 click 后:', await snapshot())
    console.log('B 手势轨迹尾部:', JSON.stringify(await evalJson(`JSON.stringify((window.__meowGestureTrace ?? []).slice(-4))`)))
  } else {
    console.log('B 跳过：分组展开后仍无会话行')
  }
} catch (err) {
  console.log('探针异常 —', err.message)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
