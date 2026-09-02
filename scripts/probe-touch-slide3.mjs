/**
 * 探针 v3：验证修复假说——touch-action: pan-y 能否让"超宽表格上的竖滑"
 * 正常链滚到页面（Chrome scroll-latch 的绕开验证）。
 *
 * v2 实锤：竖滑落在 overflow-x:auto + sw>cw 的表格上 → 浏览器 latch 到表格、
 * 竖向位移丢弃且不链外层（页面 0 位移，pd=0 我们没拦）。本探针对表格分别
 * 施加 touch-action: pan-y / pan-x pan-y / auto，逐个合成竖滑+横滑，找
 * "竖滑滚页面 + 横滑可接管"的组合。
 *
 * 运行：node scripts/probe-touch-slide3.mjs [baseUrl]
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
const PORT = 9383
const profile = join(process.env.TEMP ?? '.', `meow-slide3-${Date.now()}`)
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 25000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`)
  if (typeof res.result?.value !== 'string') throw new Error(`非字符串: ${JSON.stringify(res.result).slice(0, 200)}`)
  return JSON.parse(res.result.value)
}
async function waitFor(label, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(150)
  }
  throw new Error(`等待超时: ${label} — ${JSON.stringify(last)}`)
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
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, screenWidth: 1280, screenHeight: 844, deviceScaleFactor: 2, mobile: true })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame', `() => document.querySelector('[data-slot="root"] > *') !== null ? {ok:true} : {ok:false}`, 30000)
  await sleep(800)
  await waitFor('会话行', `() => [...document.querySelectorAll('div[role=treeitem]')].some(el => !el.className.includes('projectRow') && (el.textContent || '').length > 0) ? {ok:true} : {ok:false}`, 15000)
  const pick = await evalJson(`(async () => {
    const rows = [...document.querySelectorAll('div[role=treeitem]')].filter(el => !el.className.includes('projectRow') && (el.textContent || '').trim().length > 0)
    for (const row of rows.slice(0, 8)) {
      row.click()
      await new Promise(r => setTimeout(r, 1200))
      const sc = [...document.querySelectorAll('*')].find(el => {
        const cs = getComputedStyle(el)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
      })
      if (sc !== undefined) return JSON.stringify({ ok: true })
    }
    return JSON.stringify({ ok: false })
  })()`)
  if (pick.ok !== true) throw new Error('没找到有滚动余量的会话')
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)

  await evalJson(`(() => {
    if (window.__pdHooked) return JSON.stringify({ ok: true })
    window.__pdHooked = true
    window.__pdCount = 0
    window.__pdOff = false
    window.__pdStacks = []
    const orig = Event.prototype.preventDefault
    Event.prototype.preventDefault = function () {
      if (this.type === 'touchmove' && window.__pdOff !== true) {
        window.__pdCount++
        if (window.__pdStacks.length < 10) window.__pdStacks.push(String(new Error().stack || '').split('\\n').slice(1, 4).join(' <= '))
        return orig.apply(this, arguments)
      }
      return undefined
    }
    return JSON.stringify({ ok: true })
  })()`)

  // 注入表格到"当前视口中心"对应的文档位置（上下都有滚动余量，滑动手势有语义）
  await evalJson(`(() => {
    if (document.querySelector('[data-probe-table]') !== null) return JSON.stringify({ ok: true })
    const sc = [...document.querySelectorAll('*')].find(el => {
      const cs = getComputedStyle(el)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
    })
    if (sc === undefined) return JSON.stringify({ ok: false, error: 'no scroller' })
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) / 2)
    const mid = document.elementFromPoint(195, Math.round(sc.clientHeight / 2))
    const anchor = (mid !== null && mid.parentElement !== null) ? mid.parentElement : sc.firstElementChild
    const host = document.createElement('div')
    host.setAttribute('data-probe-table', 'true')
    host.style.padding = '8px'
    const wrap = document.createElement('div')
    wrap.className = 'md-table-wide'
    let cells = ''
    for (let c = 0; c < 10; c++) cells += '<th style="padding:6px 14px;border:1px solid #8888;white-space:nowrap">列' + c + ' 标题内容加长版</th>'
    let body = ''
    for (let r2 = 0; r2 < 6; r2++) {
      let tds = ''
      for (let c = 0; c < 10; c++) tds += '<td style="padding:6px 14px;border:1px solid #6688;white-space:nowrap">R' + r2 + 'C' + c + ' 单元格内容加长版</td>'
      body += '<tr>' + tds + '</tr>'
    }
    wrap.innerHTML = '<table style="border-collapse:collapse"><thead><tr>' + cells + '</tr></thead><tbody>' + body + '</tbody></table>'
    host.appendChild(wrap)
    if (anchor !== null && anchor !== sc.firstElementChild) anchor.before(host)
    else sc.firstElementChild?.prepend(host)
    return JSON.stringify({ ok: true, scrollTop: Math.round(sc.scrollTop) })
  })()`)
  await sleep(300)

  const swipe = async (rect, dir, tilt = 0) => {
    const cx = rect.x + rect.w / 2
    const y0 = Math.min(Math.max(rect.y + rect.h / 2, 40), 800)
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: y0 }] })
    for (let i = 1; i <= 8; i++) {
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + tilt * i, y: y0 + dir * i * 18 }] })
      await sleep(16)
    }
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(400)
  }

  for (const ta of ['auto', 'pan-y', 'pan-x pan-y']) {
    // 每轮重新把表格定位到视口中部（竖滑会滚走它，坐标必须实时取）
    const parkAndRect = async () => await evalJson(`(() => {
      const el = document.querySelector('[data-probe-table] .md-table-wide')
      const sc = [...document.querySelectorAll('*')].find(x => {
        const cs = getComputedStyle(x)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
      })
      el.style.touchAction = '${ta}'
      const docTop = el.getBoundingClientRect().top + sc.scrollTop
      sc.scrollTop = Math.max(60, Math.min(Math.round(docTop - sc.clientHeight / 2 + 120), Math.round(sc.scrollHeight - sc.clientHeight - 60)))
      const r = el.getBoundingClientRect()
      window.__slBefore = Math.round(sc.scrollTop)
      window.__tblBefore = el.scrollLeft
      window.__pdCount = 0
      return JSON.stringify({ ok: true, y: Math.round(r.y), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, scrollTop: Math.round(sc.scrollTop) })
    })()`)
    const pos = await parkAndRect()
    if (pos.y < 10 || pos.y > 700) { console.log(`ta=${ta} 表格不可见 y=${pos.y} 跳过`); continue }
    // 竖直上滑（看下方）——每轮前重新定位
    await swipe(pos.rect, -1)
    const r1 = await evalJson(`(() => {
      const sc = [...document.querySelectorAll('*')].find(x => {
        const cs = getComputedStyle(x)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
      })
      const el = document.querySelector('[data-probe-table] .md-table-wide')
      return JSON.stringify({ ok: true, pageDy: Math.round(sc.scrollTop) - window.__slBefore, tblDx: el.scrollLeft - window.__tblBefore, pd: window.__pdCount })
    })()`)
    // 横滑（向左看右侧列）——重新定位
    const pos2 = await parkAndRect()
    await swipe(pos2.rect, 0, -8)
    const r2 = await evalJson(`(() => {
      const sc = [...document.querySelectorAll('*')].find(x => {
        const cs = getComputedStyle(x)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
      })
      const el = document.querySelector('[data-probe-table] .md-table-wide')
      return JSON.stringify({ ok: true, pageDy: Math.round(sc.scrollTop) - window.__slBefore, tblDx: el.scrollLeft - window.__tblBefore, pd: window.__pdCount })
    })()`)
    console.log(`ta="${ta}" 竖滑: 页面Δ=${r1.pageDy} 表格横Δ=${r1.tblDx} pd=${r1.pd} | 横滑: 页面Δ=${r2.pageDy} 表格横Δ=${r2.tblDx} pd=${r2.pd}`)
  }
  console.log('DONE')
} catch (error) {
  console.log('FAIL', error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
