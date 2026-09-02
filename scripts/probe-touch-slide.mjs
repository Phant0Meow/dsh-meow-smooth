/**
 * 探针 v2：手机端"表格/工具调用行上滑动冻结"定位。
 *
 * v1 结论：竖滑被 meow-smooth 橡皮筋 touchmove preventDefault（pd 栈实锤），
 * 但 v1 恰好测在 scrollBody 底部向上滑（防回弹的正确拦截）。v2 修正：
 *  - 滑动前把主滚动容器拨到中部，向上/向下滑分开测；
 *  - 「关闸对照」：hook 开关让 preventDefault 变 no-op——若关闸后能滚而
 *    开闸不能滚，则拦截判定有 bug；若关闸后仍不滚，则是原生/官方层问题。
 *  - 斜滑测试（真机手指很难纯竖直）。
 *  - 注入复刻表格（官方 .md-table-wide 类 + 插件 hover:none 常开规则作用
 *    同构）测表格区滑动。
 *
 * 运行：node scripts/probe-touch-slide.mjs [baseUrl]
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
const PORT = 9381
const profile = join(process.env.TEMP ?? '.', `meow-slide-probe2-${Date.now()}`)
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

let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

/** 主滚动容器 + pd 计数快照。 */
const SCROLL_EXPR = `(() => {
  const sc = [...document.querySelectorAll('*')].filter(el => {
    const cs = getComputedStyle(el)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
  })
  return JSON.stringify({ ok: true, tops: sc.map(el => Math.round(el.scrollTop)), pd: window.__pdCount, sh: sc[0]?.scrollHeight, ch: sc[0]?.clientHeight })
})()`
/** 拨主滚动容器到指定 scrollTop。 */
const SET_TOP = `(v) => {
  const sc = [...document.querySelectorAll('*')].filter(el => {
    const cs = getComputedStyle(el)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
  })
  sc.forEach(el => { el.scrollTop = v })
  return JSON.stringify({ ok: true, set: sc.length })
}`

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
  // 宽屏进会话（侧栏可见）→ 切窄屏保持会话
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, screenWidth: 1280, screenHeight: 844, deviceScaleFactor: 2, mobile: true })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame', `() => document.querySelector('[data-slot="root"] > *') !== null ? {ok:true} : {ok:false}`, 30000)
  await sleep(800)
  await waitFor('会话行', `() => [...document.querySelectorAll('div[role=treeitem]')].some(el => !el.className.includes('projectRow') && (el.textContent || '').length > 0) ? {ok:true} : {ok:false}`, 15000)
  const pickResult = await evalJson(`(async () => {
    const rows = [...document.querySelectorAll('div[role=treeitem]')].filter(el => !el.className.includes('projectRow') && (el.textContent || '').trim().length > 0)
    for (const row of rows.slice(0, 8)) {
      row.click()
      await new Promise(r => setTimeout(r, 1200))
      const sc = [...document.querySelectorAll('*')].find(el => {
        const cs = getComputedStyle(el)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
      })
      if (sc !== undefined) return JSON.stringify({ ok: true, picked: (row.textContent || '').slice(0, 30) })
    }
    return JSON.stringify({ ok: false })
  })()`)
  console.log(`会话选择: ${JSON.stringify(pickResult)}`)
  if (pickResult.ok !== true) throw new Error('没找到有足够滚动余量的会话')
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)

  // hook preventDefault（可开关）+ 观测
  await evalJson(`(() => {
    if (window.__pdHooked) return JSON.stringify({ ok: true })
    window.__pdHooked = true
    window.__pdOff = false
    window.__pdCount = 0
    const orig = Event.prototype.preventDefault
    Event.prototype.preventDefault = function () {
      if (this.type === 'touchmove' && window.__pdOff !== true) {
        window.__pdCount++
        return orig.apply(this, arguments)
      }
      return undefined
    }
    return JSON.stringify({ ok: true })
  })()`)

  /** 合成一次竖滑/斜滑。dir: -1 上滑 / +1 下滑；tilt: 每步横向位移。 */
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
  /** 完整滑动测试：中部起点、双向、开闸/关闸对照。 */
  const slideTest = async (label, rect) => {
    const results = {}
    for (const pdOff of [false, true]) {
      for (const dir of [1, -1]) {
        await evalJson(`(${SET_TOP})(900)`) // 中部（非顶非底）
        await evalJson(`(() => { window.__pdCount = 0; window.__pdOff = ${pdOff}; return JSON.stringify({ok:true}) })()`)
        await swipe(rect, dir)
        const after = await evalJson(SCROLL_EXPR)
        const moved = after.tops.some((v, i) => Math.abs(v - 900) > 4)
        results[`${pdOff ? '关闸' : '开闸'}-${dir > 0 ? '下滑' : '上滑'}`] = { moved, pd: after.pd }
      }
    }
    const openBlocked = results['开闸-下滑'].moved === false && results['开闸-上滑'].moved === false
    const offWorks = results['关闸-下滑'].moved === true || results['关闸-上滑'].moved === true
    check(!(openBlocked && offWorks), `${label}`, JSON.stringify(results))
    return { openBlocked, offWorks }
  }

  console.log('--- 折叠行/正文滑动测试（中部、双向、开关闸对照）---')
  const scan = await evalJson(`(() => {
    const out = { ok: true, rows: [], tables: [] }
    document.querySelectorAll('[aria-expanded]').forEach(el => {
      if (out.rows.length >= 3) return
      if (el.closest('[data-slot="conversation.session.header"], [data-slot="sidebar"]') !== null) return
      const r = el.getBoundingClientRect()
      if (r.width < 50 || r.height < 10 || r.bottom < 60 || r.top > innerHeight - 60) return
      out.rows.push({ tag: el.tagName, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: (el.textContent || '').slice(0, 30) })
    })
    return JSON.stringify(out)
  })()`)
  for (const r of scan.rows) await slideTest(`折叠行[${r.text.slice(0, 16)}]`, r.rect)
  await slideTest('对照[正文空白]', { x: 195, y: 500, w: 10, h: 10 })

  // 注入复刻表格（官方 .md-table-wide 类 + 官方表格结构；插件 hover:none 规则全局生效同构）
  await evalJson(`(() => {
    if (document.querySelector('[data-probe-table]') !== null) return JSON.stringify({ ok: true })
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
    const sc = [...document.querySelectorAll('*')].find(el => {
      const cs = getComputedStyle(el)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
    })
    if (sc !== undefined) sc.firstElementChild?.prepend(host)
    else document.body.appendChild(host)
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(300)
  // 拨回顶部让注入表格（消息流最顶）进入视口，再取实时 rect
  await evalJson(`(${SET_TOP})(0)`)
  await sleep(200)
  const tRect = await evalJson(`(() => {
    const el = document.querySelector('[data-probe-table] .md-table-wide')
    if (el === null) return JSON.stringify({ ok: false })
    const r = el.getBoundingClientRect()
    return JSON.stringify({ ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, ta: getComputedStyle(el).touchAction, ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth })
  })()`)
  console.log(`注入表格: ${JSON.stringify(tRect)}`)
  // 把主滚动容器拨到"表格位于视口中部"的位置（上下都有余量，双向滑都有语义）
  const parked = await evalJson(`(() => {
    const el = document.querySelector('[data-probe-table] .md-table-wide')
    const sc = [...document.querySelectorAll('*')].find(x => {
      const cs = getComputedStyle(x)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
    })
    if (el === null || sc === undefined) return JSON.stringify({ ok: false })
    const docTop = el.getBoundingClientRect().top + sc.scrollTop
    const target = Math.max(0, Math.round(docTop - sc.clientHeight / 2 + el.getBoundingClientRect().height / 2))
    sc.scrollTop = target
    const r = el.getBoundingClientRect()
    return JSON.stringify({ ok: true, scrollTop: Math.round(sc.scrollTop), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, ta: getComputedStyle(el).touchAction, ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft })
  })()`)
  console.log(`表格定位: ${JSON.stringify(parked)}`)
  if (parked.ok === true && parked.rect.y > -20 && parked.rect.y < 700) {
    for (const [label, dir, tilt] of [['上滑(看下方)', -1, 0], ['下滑(看上方)', 1, 0], ['上滑+横分量', -1, 6], ['纯横滑', 0, 8]]) {
      await evalJson(`(() => {
        const sc = [...document.querySelectorAll('*')].find(x => {
          const cs = getComputedStyle(x)
          return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
        })
        const el = document.querySelector('[data-probe-table] .md-table-wide')
        window.__slBefore = sc ? Math.round(sc.scrollTop) : -1
        window.__tblBefore = el ? el.scrollLeft : -1
        window.__pdCount = 0
        window.__pdOff = false
        return JSON.stringify({ ok: true })
      })()`)
      await swipe(parked.rect, dir, tilt)
      const diag = await evalJson(`(() => {
        const sc = [...document.querySelectorAll('*')].find(x => {
          const cs = getComputedStyle(x)
          return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
        })
        const el = document.querySelector('[data-probe-table] .md-table-wide')
        return JSON.stringify({ ok: true, pageDy: sc ? Math.round(sc.scrollTop) - window.__slBefore : null, tblDx: el ? el.scrollLeft - window.__tblBefore : null, pd: window.__pdCount })
      })()`)
      console.log(`表格${label}: 页面Δ=${diag.pageDy} 表格横Δ=${diag.tblDx} pdΔ=${diag.pd}`)
    }
  } else {
    console.log(`表格不可见，跳过: ${JSON.stringify(parked)}`)
  }

  console.log(failed === 0 ? 'DONE（全部通过）' : `DONE（${failed} FAIL）`)
} catch (error) {
  console.log('FAIL', error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
