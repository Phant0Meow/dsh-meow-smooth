/**
 * e2e：手机端侧边栏边缘手势（需求⑲ v5 状态机式——轻划/长划定义三档转换，
 * 不跟手、无自定义补间，动画全部为官方原生 grid 过渡）。裸 CDP 驱动
 * headless Edge，零 npm 依赖（Node ≥22 全局 WebSocket），对**真实运行中的
 * dsh 实例**做手机仿真（390×844 触屏、pointer:coarse）：
 *
 *  1. 初始 furl 基线（功能⑱ 无回归）；
 *  2. 左缘向右轻划 → 细条（窄档 rail：track≈56、不 furl、小方块隐、narrowHold）；
 *  3. 细条在场再向右轻划 → 宽边栏（280px 展开）；
 *  4. 右侧窗口向左滑 → 收起到 0 档（furl 小方块复活）；
 *  5. 左缘向右长划 → 直达宽边栏（跳过细条）；
 *  6. 宽边栏空白处向左滑 → 收起到 0 档；
 *  7. 左缘轻划 → 细条；右侧窗口点击 → 收起到 0（click 路径回归）；
 *  8. FAB 点击仍可用（需求⑲ 零改动约定）。
 *
 * 运行：node scripts/e2e-sidebar-swipe.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3080（须已装配 meow-smooth 本构建产物）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'

// 预检：插件 client.js 必须可达（否则实例没装配，提示后退出）。
const probe = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null || !probe.ok) {
  console.log(`FAIL ${BASE}/plugins/meow-smooth/client.js 不可达（${probe?.status ?? '网络错误'}）— 该实例未装配 meow-smooth？`)
  process.exit(1)
}

// --- 起 headless Edge（裸 CDP） ---
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9341
const profile = join(process.env.TEMP ?? '.', `meow-smooth-swipe-e2e-${Date.now()}`)
const proc = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) break
    } catch {}
    await sleep(250)
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const tab = await created.json()
  return tab.webSocketDebuggerUrl
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
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
  return JSON.parse(res.result.value)
}

let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    // 拦截 pending 轮询：实例上真实的未决审批/提问会弹提醒卡片盖住左上角，
    // 断言随实例状态漂移——拦掉才有确定性。
    if (msg.method === 'Fetch.requestPaused') {
      const body = Buffer.from(JSON.stringify({ approvals: [], questions: [], events: [] })).toString('base64')
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 200, body } }))
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (text.includes('meow-smooth')) console.log(`CONSOLE> ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`PAGE-EXC> ${d.text} ${d.exception?.description?.split('\n')[0] ?? ''}`)
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
  // 手机仿真：视口 390×844 + 触屏（pointer:coarse / hover:none 随之成立）。
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })

  // 等 AppFrame 挂载 + 插件模块为最新构建。rev 滞后会导致页面执行旧代码
  // （构建标记对不上就刷新重载）——排障期实测的伺服时序坑。
  const waitForFrame = (ms) => waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, ms)
  for (let i = 0; i < 12; i++) {
    await waitForFrame(i === 0 ? 30000 : 15000)
    const tag = await evalJson(`JSON.stringify(document.documentElement.dataset.meowSmoothGestureLoaded ?? '')`)
    if (tag === 'v5-direct-zero') break
    await call('Page.reload', {})
    await sleep(2000)
  }
  await sleep(1200) // 留给 React 稳定 + 至少一个 500ms 同步 tick

  /** 轮询等待页面内断言条件成立；要求连续两次轮询都满足才算稳定通过
   *  ——官方 grid 过渡(~300ms)的中间帧不算数。表达式"未达标"分支必须
   *  返回 ok:false（state 自带的 ok:true 不能作为通过依据）。 */
  async function waitFor(label, expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    let streak = 0
    while (Date.now() < deadline) {
      last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
      if (last.ok === true) {
        streak += 1
        if (streak >= 2) return last
      } else {
        streak = 0
      }
      await sleep(100)
    }
    throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
  }

  const state = `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame === null) return { ok: false, why: 'no-frame' }
    const cols = getComputedStyle(frame).gridTemplateColumns.split(' ').map(s => parseFloat(s))
    const fab = document.querySelector('[data-meow-smooth-fab]')
    return {
      ok: true,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true',
      collapsed: frame.hasAttribute('data-sidebar-collapsed'),
      track1: cols[0],
      fabVisible: fab !== null && getComputedStyle(fab).display !== 'none',
    }
  }`

  /** 统一状态读取。 */
  const readState = () => evalJson(`JSON.stringify((${state})())`)
  /** 步骤后诊断转储（失败归因用）。 */
  async function dump(label) {
    const s = await readState()
    const tr = await evalJson(`JSON.stringify(window.__meowGestureTrace ?? [])`)
    console.log(`  [dump:${label}] state=${JSON.stringify(s)}`)
    console.log(`  [dump:${label}] trace=${tr}`)
    return s
  }

  /** 触摸滑动序列（Input.dispatchTouchEvent；水平为主保证横向主导）。
   *  每步之间清掉文本选区：CDP 模拟拖动经过正文会真实形成 Range 选区，
   *  v5.1-selguard 守卫（选区在场一律放行）会据此无声中止手势——真机
   *  用户轻扫左缘不会拖出选区，测试里必须显式模拟"无选区"前提。 */
  async function swipe({ x0, y0 = 420, x1, steps = 10, dwellMs = 16 }) {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await evalJson(`(function(){ const s = document.getSelection(); if (s.type === 'Range') s.removeAllRanges(); return JSON.stringify({ ok: true }) })()`)
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * t, y: y0 }] })
      await sleep(dwellMs)
    }
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(150)
  }

  /** 点击右侧窗口区（挑好的非输入区点位；composer 排除带外的安全点击）。 */
  async function tapWindow() {
    await evalJson(`(function(){
      const t = document.elementFromPoint(${windowPt.x}, ${windowPt.y}) ?? document.body
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ${windowPt.x}, clientY: ${windowPt.y} }))
      return JSON.stringify({ ok: true })
    })()`)
    await sleep(500)
  }

  // --- 断言 1：初始 furl 基线 ---
  const s1 = await waitFor('初始态', state)
  check(s1.furled === true && s1.track1 === 0 && s1.fabVisible === true,
    '初始 furl 基线（功能⑱ 无回归）', `furled=${s1.furled} track1=${s1.track1} fab=${s1.fabVisible}`)

  // --- 手势起手点挑选（2026-08-25 光标 bug 修复后：composer 卡片内起手
  //  一律不参与边栏手势——新会话页 hero 输入框几乎占满左缘，固定坐标会撞
  //  进排除区。真机用户会在非输入区起手，这里按同一规则动态挑点。） ---
  const pickPoint = async (x) => evalJson(`(function(){
    for (let y = 40; y < 820; y += 12) {
      const el = document.elementFromPoint(${x}, y)
      if (el === null) continue
      if (el.closest('[data-composer-card]')) continue
      if (el.closest('[data-meow-smooth-fab], [role="dialog"], [data-meow-smooth-pending]')) continue
      return JSON.stringify({ x: ${x}, y })
    }
    return 'null'
  })()`)
  const edgePt = await pickPoint(10)
  const windowPt = await pickPoint(340)
  check(edgePt !== null && windowPt !== null, '挑选手势起手点（避开输入区排除带）',
    `edge=${JSON.stringify(edgePt)} window=${JSON.stringify(windowPt)}`)
  if (edgePt === null || windowPt === null) {
    console.log('SKIP 整屏左缘/右缘均被排除区覆盖，无法测手势（布局异常？）')
    try { ws?.close() } catch {}
    try { proc.kill() } catch {}
    process.exit(0)
  }

  // --- 断言 2：左缘轻划 → 窄档（原生 rail 停留 + narrowHold） ---
  await swipe({ x0: 8, y0: edgePt.y, x1: 50 }) // dx=42：≥识别阈值、<110 轻划
  const s2 = await waitFor('轻划落窄档', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return Math.abs(r.track1 - 56) <= 3 && r.collapsed === true && r.furled === false ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(Math.abs(s2.track1 - 56) <= 3, '左缘轻划 → 细条（窄档 rail）', `track1=${s2.track1}px`)
  check(s2.furled === false, '窄档停留不 furl', `furled=${s2.furled}`)
  check(s2.fabVisible === false, '窄档停留小方块隐藏', `fab=${s2.fabVisible}`)
  if (Math.abs(s2.track1 - 56) > 3) await dump('step2-fail')

  // narrowHold：跨两个 500ms tick，自动折回必须被豁免
  await sleep(900)
  const s2b = await readState()
  check(s2b.furled === false && Math.abs(s2b.track1 - 56) <= 3,
    'narrowHold：500ms tick 不把窄档折回小方块', `furled=${s2b.furled} track1=${s2b.track1}`)
  if (s2b.furled !== false) await dump('step2b-fail')

  // --- 断言 3：细条在场再向右轻划 → 宽边栏 ---
  await swipe({ x0: 30, y0: edgePt.y, x1: 120 }) // rail 上起手（≤86 带）右划 dx=90
  const s3 = await waitFor('轻划开宽档', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.collapsed === false && r.track1 >= 264 ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(s3.collapsed === false && s3.track1 >= 264, '细条 → 宽边栏', `W=${Math.round(s3.track1)}px`)
  if (s3.track1 < 264) await dump('step3-fail')

  // --- 断言 4：右侧窗口向左滑 → 收起到 0 档 ---
  await swipe({ x0: 340, y0: windowPt.y, x1: 260 }) // 右侧窗口内左滑 dx=-80
  const s4 = await waitFor('右窗左滑收起到 0', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.track1 === 0 && r.furled === true && r.fabVisible === true ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(s4.track1 === 0 && s4.furled === true, '宽档右窗左滑 → 收起到 0 档', `track1=${s4.track1} furled=${s4.furled}`)
  if (s4.track1 !== 0) await dump('step4-fail')

  // --- 断言 5：左缘长划 → 直达宽边栏（跳过细条） ---
  await swipe({ x0: 18, y0: edgePt.y, x1: 180 }) // dx=162 ≥ 110 长划
  const s5 = await waitFor('长划直达宽档', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.collapsed === false && r.track1 >= 264 ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(s5.collapsed === false && s5.track1 >= 264, '左缘长划 → 直达宽边栏', `W=${Math.round(s5.track1)}px`)
  if (s5.track1 < 264) await dump('step5-fail')
  const W = s5.track1

  // --- 断言 6：宽边栏空白处向左滑 → 收起到 0 档 ---
  // 探路：找 sidebar 列内非交互元素的空白点作为起手位。
  const spot = await evalJson(`JSON.stringify((function(){
    for (let y = 320; y < 760; y += 20) {
      for (let x = 120; x <= Math.min(260, Math.round(${Math.round(W)}) - 30); x += 20) {
        const el = document.elementFromPoint(x, y)
        if (el && el.closest('[data-slot="sidebar"]') && !el.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"]')) {
          return { x, y }
        }
      }
    }
    return null
  })())`)
  if (spot !== null) {
    await swipe({ x0: spot.x + 10, y0: spot.y, x1: spot.x - 70 })
    let s6
    try {
      s6 = await waitFor('空白处左滑收起', `() => {
        const r = (${state})()
        if (!r.ok) return { ...r, ok: false }
        return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
      }`)
    } catch (e) {
      await dump('step6-fail')
      throw e
    }
    check(s6.track1 === 0 && s6.furled === true, '宽边栏空白处左滑 → 收起到 0 档', `spot=(${spot.x},${spot.y}) track1=${s6.track1}`)
    if (s6.track1 !== 0) await dump('step6-fail')
  } else {
    console.log('SKIP 宽边栏空白处左滑（未找到空白点）')
  }

  // --- 断言 7：左缘轻划 → 细条；右侧窗口点击 → 收起到 0（click 路径回归） ---
  await swipe({ x0: 8, y0: edgePt.y, x1: 50 })
  const s7a = await waitFor('轻划回窄档', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return Math.abs(r.track1 - 56) <= 3 && r.furled === false ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(Math.abs(s7a.track1 - 56) <= 3, '左缘轻划再次拉出细条', `track1=${s7a.track1}px`)
  await tapWindow()
  const s7b = await waitFor('窄档点外部收起', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(s7b.track1 === 0 && s7b.furled === true, '细条在场点右侧窗口区 → 收起到 0（click 路径）', `track1=${s7b.track1}`)
  if (s7b.track1 !== 0) await dump('step7-fail')

  // --- 断言 8：FAB 点击仍可用（零改动约定） ---
  await evalJson(`(function(){
    document.querySelector('[data-meow-smooth-fab]').click()
    return JSON.stringify({ ok: true })
  })()`)
  const s8 = await waitFor('FAB 点击仍可用', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    // 两态直接展开；三态先出竖条——两种都算 FAB 活着。
    return (r.track1 >= 264 && r.collapsed === false) || (Math.abs(r.track1 - 56) <= 3 && r.collapsed === true && r.furled === false)
      ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(true, '小方块点击行为不受手势模块影响', `track1=${Math.round(s8.track1)} collapsed=${s8.collapsed}`)
} catch (error) {
  failed++
  console.log(`FAIL 异常中断 — ${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n') ?? ''}`)
} finally {
  proc.kill()
}

console.log(failed === 0 ? '\n全部 PASS' : `\n${failed} 项 FAIL`)
process.exit(failed === 0 ? 0 : 1)
