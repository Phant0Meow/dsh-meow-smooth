/**
 * 探针：手机仿真真实长按选字 A/B（2026-08-28 猫猫报 3081 手机端无法选中
 * 正文文字，PC 正常，修完弹回后依旧）。
 *
 * CDP 触屏仿真（390×844 + touch）对消息文字做【真实长按】：
 * touchStart 按住 900ms（iOS/Chromium 长按选字阈值 ~500ms）→ 读选区 →
 * touchEnd → 再读选区。同时dump落点的 user-select / touch-action 链与
 * elementsFromPoint——谁在拦一目了然。
 *
 * 运行：node scripts/probe-touch-select.mjs [baseUrl] [port]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const PORT = Number(process.argv[3] ?? 9363)

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const profile = join(process.env.TEMP ?? '.', `meow-touchsel-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) break } catch {}
    await sleep(250)
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  return (await created.json()).webSocketDebuggerUrl
}
let ws; let seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 25000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
  return JSON.parse(res.result.value)
}
async function waitFor(label, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(200)
  }
  throw new Error(`等待超时: ${label} — ${JSON.stringify(last)}`)
}

console.log(`======== 触屏长按选字探针 ${BASE} ========`)
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
  await waitFor('frame', `() => document.querySelector('[data-slot="root"] > *') !== null ? { ok: true } : { ok: false }`, 30000)
  await sleep(1500)

  // 进会话（自适应两态/三态：FAB→竖条→toggle；已在展开则直接点会话行）
  const nav = await evalJson(`(function(){
    const frame = document.querySelector('[data-slot="root"] > *')
    const collapsed = frame?.hasAttribute('data-sidebar-collapsed') ?? true
    const furled = document.documentElement.getAttribute('data-meow-smooth-furled') === 'true'
    if (!collapsed) return JSON.stringify({ step: 'expanded' })
    if (furled) {
      const fab = document.querySelector('[data-meow-smooth-fab]')
      if (fab === null) return JSON.stringify({ step: 'no-fab' })
      fab.click()
      return JSON.stringify({ step: 'fab' })
    }
    const col = document.querySelector('[data-slot="sidebar"] > *')
    const btns = col?.firstElementChild?.querySelectorAll('button') ?? []
    if (btns.length === 0) return JSON.stringify({ step: 'no-toggle' })
    btns[btns.length - 1].click()
    return JSON.stringify({ step: 'toggle' })
  })()`)
  if (nav.step === 'fab') {
    // 两态：FAB 点击直接展开；三态：出竖条再点 toggle。等待自适应。
    await waitFor('侧边栏可用', `() => {
      const frame = document.querySelector('[data-slot="root"] > *')
      if (frame === null) return { ok: false }
      const furled = document.documentElement.getAttribute('data-meow-smooth-furled') === 'true'
      if (furled) return { ok: false, why: 'still-furled' }
      // 两态已展开 / 三态出竖条都算"可用"，据此决定要不要补点 toggle
      return { ok: true, collapsed: frame.hasAttribute('data-sidebar-collapsed') }
    }`)
    const st = await evalJson(`(function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null })
    })()`)
    if (st.collapsed === true) {
      await evalJson(`(function(){
        const col = document.querySelector('[data-slot="sidebar"] > *')
        const btns = col.firstElementChild.querySelectorAll('button')
        btns[btns.length - 1].click()
        return JSON.stringify({ ok: true })
      })()`)
      await sleep(700)
    }
  } else if (nav.step === 'toggle') {
    await sleep(700)
  }
  await waitFor('会话树', `() => {
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...(column?.querySelectorAll('div[role="treeitem"]') ?? [])].filter(r => /分钟|小时|天/.test(r.textContent ?? ''))
    return rows.length > 0 ? { ok: true } : { ok: false }
  }`, 12000)
  const sess = await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(r => !r.className.includes('projectRow') && /分钟|小时|天/.test(r.textContent ?? ''))
    if (rows.length === 0) return JSON.stringify({ ok: false })
    rows[0].click()
    return JSON.stringify({ ok: true, label: rows[0].textContent.slice(0, 20) })
  })()`)
  console.log('会话:', JSON.stringify(sess))
  await waitFor('消息', `() => document.querySelectorAll('[data-time-hover-root]').length >= 1 ? { ok: true } : { ok: false }`, 15000)
  await sleep(1000)

  // 找消息文字：按「rect × 视口」交集取点（手机长消息比视口高，整体入带不成立）
  const finder = `(function(){
    const roots = [...document.querySelectorAll('[data-time-hover-root]')]
    let best = null
    const walker = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && (node.textContent ?? '').trim().length > 30) {
          const parent = node.parentElement
          const r = parent.getBoundingClientRect()
          const top = Math.max(r.top, 90)
          const bottom = Math.min(r.bottom, 720)
          const h = bottom - top
          if (r.width > 40 && h > 50 && (best === null || h > best.h)) best = { el: parent, h, top, bottom, r }
        } else if (node.nodeType === 1) walker(node)
      }
    }
    for (const root of roots) walker(root)
    if (best === null) return JSON.stringify({ ok: false, roots: roots.length })
    const chain = []
    let n = best.el
    while (n !== null && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      const us = cs.userSelect !== 'auto' ? 'us:' + cs.userSelect : null
      const ta = cs.touchAction !== 'auto' ? 'ta:' + cs.touchAction : null
      const tag = n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\\s+/).slice(0, 2).join('.') : '')
      const extra = [us, ta].filter(Boolean).join(' ')
      chain.push(tag + (extra ? ' [' + extra + ']' : ''))
      n = n.parentElement
    }
    return JSON.stringify({
      ok: true,
      x: Math.round(Math.min(Math.max(best.r.left + 100, 10), 370)),
      y: Math.round((best.top + best.bottom) / 2),
      sample: best.el.textContent.slice(0, 24),
      chain,
    })
  })()`
  let spot = await evalJson(finder)
  if (spot.ok !== true) {
    // 逐条滚动消息找目标（新会话可视区可能全是工具卡片）
    const nRoots = Math.min(10, (spot.roots ?? 1) - 1)
    for (let i = 0; i <= nRoots && spot.ok !== true; i++) {
      await evalJson(`(function(){
        const roots = document.querySelectorAll('[data-time-hover-root]')
        ;(roots[${i}] ?? null)?.scrollIntoView({ block: 'center' })
        return JSON.stringify({ ok: true })
      })()`)
      await sleep(550)
      spot = await evalJson(finder)
    }
  }
  console.log('长按落点:', JSON.stringify(spot))
  if (spot.ok !== true) { console.log('=> 找不到含长文本的消息节点，本实例会话内容不适合本探针'); process.exit(1) }

  // 真实长按：touchStart 按住 900ms
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x, y: spot.y, id: 1 }] })
  await sleep(900)
  const during = await evalJson(`(function(){
    const s = document.getSelection()
    return JSON.stringify({ type: s.type, text: s.toString().slice(0, 30), rangeCount: s.rangeCount })
  })()`)
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(400)
  const after = await evalJson(`(function(){
    const s = document.getSelection()
    return JSON.stringify({ type: s.type, text: s.toString().slice(0, 30) })
  })()`)
  console.log('长按中(900ms):', JSON.stringify(during))
  console.log('松手后(400ms):', JSON.stringify(after))
  console.log(during.type === 'Range' || after.type === 'Range' ? '=> 长按选字成功' : '=> 长按选字失败（有东西在拦，或 headless 不触发长按手势）')

  // 对照组：鼠标双击（验证内容本身可选性——排除 user-select 类硬拦截）
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
  await sleep(300)
  const dbl = await evalJson(`(function(){
    const s = document.getSelection()
    return JSON.stringify({ type: s.type, text: s.toString().slice(0, 30) })
  })()`)
  console.log('鼠标双击对照:', JSON.stringify(dbl))
} catch (e) {
  console.log(`探针异常 — ${e.message}`)
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}

