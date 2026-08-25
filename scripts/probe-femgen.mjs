/** 探针：femGen 视图（Fem 剧本标签）下 header 与 fab 的真实状态。 */
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
const PORT = 9371
const profile = join(process.env.TEMP ?? '.', `meow-probeC-${Date.now()}`)
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
  // 三态：fab → 竖条 → toggle 展开
  await evalJson(`JSON.stringify((function(){ document.querySelector('[data-meow-smooth-fab]').click(); return '{}' })())`)
  await sleep(700)
  await evalJson(`(function(){
    const col = document.querySelector('[data-slot="sidebar"] > *')
    const btns = col.firstElementChild.querySelectorAll('button')
    btns[btns.length - 1].click()
    return '{}'
  })()`)
  await sleep(900)
  // 点一个会话（优先 femwa 相关，退化到任意会话）；等会话树加载
  let clicked = { ok: false }
  for (let i = 0; i < 30; i++) {
    clicked = await evalJson(`(function(){
      const column = document.querySelector('[data-slot="sidebar"] > *')
      const all = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
      const rows = all.filter(b => /femwa|调试|视角|剧本/.test(b.textContent))
      const target = rows[0] ?? all[0]
      if (target === undefined) return JSON.stringify({ ok: false, total: all.length })
      target.click()
      return JSON.stringify({ ok: true, label: target.textContent.slice(0, 30) })
    })()`)
    if (clicked.ok === true) break
    await sleep(400)
  }
  console.log('clicked:', clicked)
  await sleep(1500)

  // 列出 tablist 里的所有标签（等 header 内容挂载）
  let tabs = []
  for (let i = 0; i < 20; i++) {
    tabs = await evalJson(`(function(){
      const list = document.querySelectorAll('[data-slot="conversation.session.header"] [role="tab"]')
      return JSON.stringify([...list].map(b => ({ text: b.textContent.trim().slice(0, 12), selected: b.getAttribute('aria-selected') })))
    })()`)
    if (tabs.length > 0) break
    await sleep(300)
  }
  console.log('tabs:', tabs)

  // 点「Fem 剧本」标签（或最后一个非对话/轨迹标签）
  const tabClick = await evalJson(`(function(){
    const list = [...document.querySelectorAll('[data-slot="conversation.session.header"] [role="tab"]')]
    const fem = list.find(b => /Fem|剧本/.test(b.textContent))
    if (fem === undefined) return JSON.stringify({ ok: false, tabs: list.map(b => b.textContent.trim()) })
    fem.click()
    return JSON.stringify({ ok: true, label: fem.textContent.trim() })
  })()`)
  console.log('tabClick:', tabClick)
  await sleep(1500)

  const dump = await evalJson(`(function(){
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    const fab = document.querySelector('[data-meow-smooth-fab]')
    const out = { femTheme: document.querySelector('[data-fem-theme]') !== null }
    if (header !== null) {
      const cs = getComputedStyle(header)
      const r = header.getBoundingClientRect()
      out.header = {
        display: cs.display, visibility: cs.visibility,
        h: +r.height.toFixed(1), top: +r.top.toFixed(1),
        checkVisibility: typeof header.checkVisibility === 'function' ? header.checkVisibility({ checkVisibilityCSS: true }) : 'n/a',
        children: header.children.length,
      }
      if (r.height > 0) {
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const top = document.elementFromPoint(cx, cy)
        out.headerCoveredBy = top === null ? 'null' : top.tagName + '[' + String(top.className).slice(0, 40) + ']'
        out.coveredIsHeaderChild = top !== null && header.contains(top)
      }
    } else {
      out.header = null
    }
    if (fab !== null) {
      const cs = getComputedStyle(fab)
      const r = fab.getBoundingClientRect()
      out.fab = { display: cs.display, h: +r.height.toFixed(1), w: +r.width.toFixed(1), hiddenAttr: fab.getAttribute('data-meow-smooth-header-hidden') }
      if (r.width > 0) {
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        out.fabCoveredBy = top === null ? 'null' : top.tagName + '[' + String(top.className).slice(0, 40) + ']'
      }
    }
    return JSON.stringify(out)
  })()`)
  console.log(JSON.stringify(dump, null, 1))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
