/** 探针：竖条底部区（footArea）结构——数出每个按钮的槽位归属。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9369
const profile = join(process.env.TEMP ?? '.', `meow-probeB-${Date.now()}`)
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
      return JSON.stringify({ frame: f !== null, collapsed: f !== null && f.hasAttribute('data-sidebar-collapsed') })
    })()`)
    if (r.frame === true && r.collapsed === true) break
    await sleep(300)
  }
  await sleep(1200)

  const dump = await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    if (column === null) return JSON.stringify({ noColumn: true })
    const foot = column.lastElementChild
    const describe = (el, depth) => {
      const cs = getComputedStyle(el)
      const info = {
        depth,
        tag: el.tagName,
        cls: String(el.className).slice(0, 45),
        bg: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '' : cs.backgroundColor,
        buttons: el.tagName === 'BUTTON'
          ? [{ label: el.getAttribute('aria-label') ?? '', cls: String(el.className).slice(0, 40), text: (el.textContent ?? '').trim().slice(0, 20) }]
          : [],
      }
      return info
    }
    const walk = (el, depth, out) => {
      out.push(describe(el, depth))
      if (depth >= 3) return
      for (const child of el.children) walk(child, depth + 1, out)
    }
    const out = []
    walk(foot, 0, out)
    // 汇总：footArea 直系子容器各自含几个 button
    const groups = [...foot.children].map((c, i) => ({
      index: i,
      cls: String(c.className).slice(0, 45),
      buttons: [...c.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent.trim().slice(0, 20)),
    }))
    return JSON.stringify({ footCls: String(foot.className).slice(0, 45), groups, tree: out })
  })()`)
  console.log(JSON.stringify(dump, null, 1))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
