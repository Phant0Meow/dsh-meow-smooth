/**
 * e2e：轴仲裁——表格/横滚容器上的滑动修复（2026-09-01 猫猫报：手机端落点
 * 在表格或工具调用/thinking 展开内容上滑动，页面不动）。
 *
 * 根因（probe-touch-slide3 实锤）：竖滑落在 overflow-x:auto 且 sw>cw 的容器
 * 上时，Chrome 把手势 latch 到该容器——竖向位移丢弃且不 scroll-chaining 给
 * 外层（我们没拦 pd=0，touch-action: pan-y 也救不了）。修复=femGen 仓库卡片
 * 同款仲裁（round49）：touchstart 检测"x-only 容器"在场 → move 确认主轴后，
 * 竖向主导 preventDefault + JS 手动滚 y 链（touchend 速度衰减 fling 补惯性）；
 * 横向主导放行容器自己原生横滚。
 *
 * 断言（真实页面 + CDP 合成触摸）：
 *   A. 表格竖滑 → scrollBody 滚动、表格 scrollLeft 不动
 *   B. 表格横滑 → 表格 scrollLeft 滚动、页面不动
 *   C. 表格斜滑（竖主导）→ 页面滚动
 *   D. 正文空白竖滑 → 页面滚动（原生链路回归）
 *
 * 运行：node scripts/e2e-overscroll-axis.mjs [baseUrl]
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
const PORT = 9385
const profile = join(process.env.TEMP ?? '.', `meow-axis-e2e-${Date.now()}`)
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

/** 拨主滚动容器到指定位置 + 记录基准 + 返回表格 rect（表格定位到视口中部）。 */
const park = `(() => {
  const el = document.querySelector('[data-probe-table] .md-table-wide')
  const sc = [...document.querySelectorAll('*')].find(x => {
    const cs = getComputedStyle(x)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
  })
  el.style.touchAction = 'auto'
  const docTop = el.getBoundingClientRect().top + sc.scrollTop
  sc.scrollTop = Math.max(60, Math.min(Math.round(docTop - sc.clientHeight / 2 + 120), Math.round(sc.scrollHeight - sc.clientHeight - 60)))
  const r = el.getBoundingClientRect()
  window.__slBefore = Math.round(sc.scrollTop)
  window.__tblBefore = el.scrollLeft
  return JSON.stringify({ ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
})()`
const result = `(() => {
  const sc = [...document.querySelectorAll('*')].find(x => {
    const cs = getComputedStyle(x)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
  })
  const el = document.querySelector('[data-probe-table] .md-table-wide')
  return JSON.stringify({ ok: true, pageDy: Math.round(sc.scrollTop) - window.__slBefore, tblDx: el.scrollLeft - window.__tblBefore })
})()`

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
  // 宽屏进会话（侧栏可见）→ 切窄屏保持会话（手机布局 + 手势抽屉激活）
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

  // 注入超宽表格到当前视口中心对应的文档位置（上下都有余量）
  const injected = await evalJson(`(() => {
    if (document.querySelector('[data-probe-table]') !== null) return JSON.stringify({ ok: true })
    const sc = [...document.querySelectorAll('*')].find(el => {
      const cs = getComputedStyle(el)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 300
    })
    if (sc === undefined) return JSON.stringify({ ok: false })
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
    return JSON.stringify({ ok: true })
  })()`)
  if (injected.ok !== true) throw new Error('表格注入失败')
  await sleep(300)

  /** 合成滑动：dir 竖向步进系数（-1 上滑 / +1 下滑 / 0 不动）、tilt 横向步进。 */
  const swipe = async (rect, dir, tilt = 0) => {
    const cx = rect.x + rect.w / 2
    const y0 = Math.min(Math.max(rect.y + rect.h / 2, 40), 800)
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: y0 }] })
    for (let i = 1; i <= 8; i++) {
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + tilt * i, y: y0 + dir * i * 18 }] })
      await sleep(16)
    }
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(600) // 含 fling 推进窗口
  }

  // ===== A. 表格竖滑 → 页面滚动 =====
  const a = await evalJson(park)
  await swipe(a.rect, -1)
  const ra = await evalJson(result)
  check(ra.pageDy > 50, 'A 表格竖滑 → 页面滚动（轴仲裁接管）', `页面Δ=${ra.pageDy} 表格横Δ=${ra.tblDx}`)

  // ===== B. 表格横滑 → 表格横滚、页面不动 =====
  const b = await evalJson(park)
  await swipe(b.rect, 0, -8)
  const rb = await evalJson(result)
  check(rb.tblDx > 20 && Math.abs(rb.pageDy) < 6, 'B 表格横滑 → 表格横滚、页面不动', `页面Δ=${rb.pageDy} 表格横Δ=${rb.tblDx}`)

  // ===== C. 表格斜滑（竖主导）→ 页面滚动 =====
  const c = await evalJson(park)
  await swipe(c.rect, -1, 3)
  const rc = await evalJson(result)
  check(rc.pageDy > 50, 'C 表格斜滑（竖主导）→ 页面滚动', `页面Δ=${rc.pageDy}`)

  // ===== D. 正文空白竖滑 → 页面滚动（原生链路回归）=====
  const d = await evalJson(park)
  await swipe({ x: 195, y: 760, w: 8, h: 8 }, -1)
  const rd = await evalJson(result)
  check(rd.pageDy > 50, 'D 正文空白竖滑 → 页面滚动（回归）', `页面Δ=${rd.pageDy}`)

  // ===== E. hidden 截断行（工具调用/thinking 收起态复刻）竖滑 → 页面滚动 =====
  // 工具行 = overflow:hidden + white-space:nowrap + 内容超宽（sw>cw）——
  // Chrome 合成器视为潜在滚动目标 latch 手势吞掉竖滑。
  await evalJson(`(() => {
    let host = document.querySelector('[data-probe-hiddenrow]')
    if (host !== null) { host.remove() }
    host = document.createElement('div')
    host.setAttribute('data-probe-hiddenrow', 'true')
    const sc = [...document.querySelectorAll('*')].find(x => {
      const cs = getComputedStyle(x)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
    })
    if (sc === undefined) return JSON.stringify({ ok: false })
    // 锚定到当前视口中心（与表格注入同款）——prepend 到消息流最顶会被
    // 定位钳制卡在 header 区，触点打不到。
    const mid = document.elementFromPoint(195, Math.round(sc.clientHeight / 2))
    const anchor = (mid !== null && mid.parentElement !== null) ? mid.parentElement : sc.firstElementChild
    host.innerHTML = '<div style="overflow:hidden;white-space:nowrap;height:28px;line-height:28px;border:1px solid #886;padding:0 10px">PwshRun a very long tool call command line that overflows the row width massively and keeps going</div>'
    if (anchor !== null && anchor !== sc.firstElementChild) anchor.before(host)
    else sc.firstElementChild?.prepend(host)
    return JSON.stringify({ ok: true })
  })()`)
  const e = await evalJson(`(() => {
    const el = document.querySelector('[data-probe-hiddenrow] > div')
    const sc = [...document.querySelectorAll('*')].find(x => {
      const cs = getComputedStyle(x)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
    })
    const docTop = el.getBoundingClientRect().top + sc.scrollTop
    sc.scrollTop = Math.max(60, Math.min(Math.round(docTop - sc.clientHeight / 2), Math.round(sc.scrollHeight - sc.clientHeight - 60)))
    const r = el.getBoundingClientRect()
    window.__slBefore = Math.round(sc.scrollTop)
    return JSON.stringify({ ok: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
  })()`)
  await swipe(e.rect, -1)
  const dbg = await evalJson(`(() => {
    const el = document.querySelector('[data-probe-hiddenrow] > div')
    const sc = [...document.querySelectorAll('*')].find(x => {
      const cs = getComputedStyle(x)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && x.scrollHeight > x.clientHeight + 400 && x.clientHeight > 300
    })
    return JSON.stringify({ ok: true, stillThere: el !== null, elRect: el ? (r => ({ y: Math.round(r.y), h: Math.round(r.height) }))(el.getBoundingClientRect()) : null, scNow: sc ? Math.round(sc.scrollTop) : null })
  })()`)
  console.log(`  E 诊断: ${JSON.stringify(dbg)}`)
  const re = await evalJson(result)
  check(re.pageDy > 50, 'E hidden 截断行竖滑 → 页面滚动（工具行场景）', `页面Δ=${re.pageDy}`)

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.log('FAIL', error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
