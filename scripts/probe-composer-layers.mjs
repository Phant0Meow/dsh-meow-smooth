/**
 * 探针5：composer 卡片内部层级结构——textarea/mirror/backdrop 各层的
 * transition / pointer-events / 几何。验证 v5.5 瞬时展开是否只压了一层、
 * 其他层是否残留过渡导致层间不同步（嫌疑：点文字不出光标、能选不能改）。
 * 分别 dump 展开态与折叠态。
 * 运行：node scripts/probe-composer-layers.mjs [baseUrl]
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
const PORT = 9350
const profile = join(process.env.TEMP ?? '.', `meow-probe-layers-${Date.now()}`)
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

  /** dump 卡片内所有元素的布局相关样式与几何。 */
  const dumpLayers = label => evalJson(`(function(){
    const card = document.querySelector('[data-composer-card]')
    if (card === null) return JSON.stringify({ label: '${label}', err: 'no card' })
    const rows = []
    const walk = (el, depth) => {
      if (depth > 6 || rows.length > 40) return
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      rows.push({
        d: depth,
        tag: el.tagName,
        cls: String(el.className).split(' ').map(c => c.length > 18 ? c.slice(0, 8) + '…' + c.slice(-8) : c).join(' ').slice(0, 60),
        pos: s.position, pe: s.pointerEvents,
        tr: s.transitionProperty.slice(0, 30), td: s.transitionDuration.slice(0, 20),
        mh: s.maxHeight === 'none' ? 'none' : s.maxHeight,
        h: Math.round(r.height),
      })
      for (const c of el.children) walk(c, depth + 1)
    }
    walk(card, 0)
    return JSON.stringify({ label: '${label}', foldedAttr: card.getAttribute('data-meow-smooth'), rows })
  })()`)

  // 先灌多行草稿并等 React 提交（同 composer-reveal e2e 的手法）。
  await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '第一行\\n第二行\\n第三行\\n第四行')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(600)

  console.log(JSON.stringify(await dumpLayers('展开态'), null, 1))

  // 点外面折叠后再 dump 折叠态。
  await evalJson(`(function(){
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(400)
  console.log(JSON.stringify(await dumpLayers('折叠态'), null, 1))
} catch (err) {
  console.log('探针异常 —', err.message)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
