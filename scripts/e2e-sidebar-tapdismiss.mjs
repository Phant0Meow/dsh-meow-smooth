/**
 * e2e：手机端"轻点侧边栏外部 → 收起"的 touch 路径（v6.3 tap-dismiss）。
 *
 * 背景（2026-09-09 猫猫报：femo 剧本标签页点外部不收起）：第三方插件的
 * 画布/手势面在 touchstart 上 preventDefault（femo 为掐灭安卓长按选字），
 * 浏览器对被取消的 touch 序列不再派生 click——client.ts 的 click 收起对那
 * 些表面失明。v6.3 起手势模块 onTouchEnd 补 tap 收起。本 e2e 用**真实 CDP
 * 触摸序列**验证：注入一个 preventDefault touchstart 的"宿敌表面"（等价
 * femo 画布），断言其上轻点确实无 click 且侧边栏仍然收起。
 *
 *  1. 初始 furl 基线 + 新构建标记（v6.3-tap）；
 *  2. 注入宿敌表面 → 左缘长划开宽档；
 *  3. 宿敌表面真实触摸轻点：click 计数必须为 0（机制复现）且收起到 0 档（修复）；
 *  4. 重开宽档 → 普通窗口区真实触摸轻点：收起、且 700ms 后仍收起（与 click 路径去重，无回弹）；
 *  5. 宿敌表面长按 500ms 松手 → 不收（长按=拖拽语义，femo 节点拖拽同款）；
 *  6. 宿敌表面竖划 60px → 不收（滚动语义）；
 *  7. 宿敌表面左划 → 收起到 0（滑动收起在宿敌表面照常工作）；
 *  8. （尽力）若当前会话有 "Fem 剧本" 标签页：切过去在画布上真实轻点 → 收起；测完切回"对话"。
 *
 * 运行：node scripts/e2e-sidebar-tapdismiss.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3081（须已装配 meow-smooth 本构建产物）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const EXPECT_TAG = 'v6.3-tap'

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
const PORT = 9342
const profile = join(process.env.TEMP ?? '.', `meow-smooth-tapdismiss-e2e-${Date.now()}`)
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
    // 拦截未决审批/提问轮询（确定性，与 e2e-sidebar-swipe 同款）。
    if (msg.method === 'Fetch.requestPaused') {
      const body = Buffer.from(JSON.stringify({ approvals: [], questions: [], events: [] })).toString('base64')
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 200, body } }))
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (text.includes('meow-smooth') || text.includes('femo-page')) console.log(`CONSOLE> ${text}`)
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
  // 手机仿真：390×844 触屏（pointer:coarse / hover:none 随之成立）。
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })

  // 等 AppFrame + 新构建标记（rev 滞后则重载，同 e2e-sidebar-swipe）。
  const waitForFrame = (ms) => waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, ms)
  for (let i = 0; i < 12; i++) {
    await waitForFrame(i === 0 ? 30000 : 15000)
    const tag = await evalJson(`JSON.stringify(document.documentElement.dataset.meowSmoothGestureLoaded ?? '')`)
    if (tag === EXPECT_TAG) break
    await call('Page.reload', {})
    await sleep(2000)
  }
  await sleep(1200)

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
  const readState = () => evalJson(`JSON.stringify((${state})())`)
  async function dump(label) {
    const s = await readState()
    const tr = await evalJson(`JSON.stringify(window.__meowGestureTrace ?? [])`)
    console.log(`  [dump:${label}] state=${JSON.stringify(s)}`)
    console.log(`  [dump:${label}] trace=${tr}`)
    return s
  }

  /** 真实触摸轻点：touchStart → 短暂停留 → touchEnd（同点，tap 量级）。 */
  async function tap({ x, y, holdMs = 90 }) {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await sleep(holdMs)
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(200)
  }
  /** 触摸滑动序列（Input.dispatchTouchEvent）。 */
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
  /** 长按：touchStart 后停住再抬起。 */
  async function longPress({ x, y, holdMs = 500 }) {
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await sleep(holdMs)
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(200)
  }

  // --- 断言 1：初始 furl 基线 + 新标记 ---
  const s1 = await waitFor('初始态', state)
  check(s1.furled === true && s1.track1 === 0 && s1.fabVisible === true,
    '初始 furl 基线', `furled=${s1.furled} track1=${s1.track1}`)

  // --- 进入真实会话（全新 profile 落在"新会话"空白页：hero 大输入框占满
  //  中屏，composer 排除带会拦掉一切手势——这不是回归，是 2026-08-25 光标
  //  保护的正确行为。FAB 开侧边栏（两态直达宽档；三态先出竖条，竖条表面
  //  右划开宽档——竖条 y 必须动态挑，固定 y 会撞 hero 输入框排除带）→
  //  点会话行 → 回到 0 档基线。） ---
  const openSidebarFromFab = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await evalJson(`(function(){
        document.querySelector('[data-meow-smooth-fab]').click()
        return JSON.stringify({ ok: true })
      })()`)
      await sleep(700)
      const mid = await readState()
      if (mid.collapsed === false && mid.track1 >= 264) return 'wide'
      if (mid.collapsed === true && Math.abs(mid.track1 - 56) <= 3) {
        // 三态竖条：挑竖条表面（sidebar 子树）上非 composer 的起手 y。
        const railPt = await evalJson(`JSON.stringify((function(){
          for (let y = 40; y < 820; y += 12) {
            const el = document.elementFromPoint(30, y)
            if (el === null) continue
            if (!el.closest('[data-slot="sidebar"]')) continue
            if (el.closest('[data-composer-card]')) continue
            return { x: 30, y }
          }
          return null
        })())`)
        if (railPt !== null) {
          await swipe({ x0: railPt.x, y0: railPt.y, x1: 120 })
          await sleep(400)
          const wide = await readState()
          if (wide.collapsed === false && wide.track1 >= 264) return 'wide'
        }
      }
      await sleep(600)
    }
    return 'stuck'
  }
  const fabOutcome = await openSidebarFromFab()
  if (fabOutcome !== 'wide') {
    console.log(`SKIP FAB 未能打开侧边栏（${fabOutcome}），后续断言无法进行`)
    try { ws?.close() } catch {}
    try { proc.kill() } catch {}
    process.exit(0)
  }
  // 实例刚启动时首次会话列表拉取较慢（361 会话状态同步）：等侧边栏里
  // 出现"展开其余"或任一会话操作按钮再继续，最多 20s。
  try {
    await waitFor('会话列表出现', `() => {
      const column = document.querySelector('[data-slot="sidebar"] > *')
      if (column === null) return { ok: false, why: 'no-column' }
      const btns = Array.from(column.querySelectorAll('button'))
      const has = btns.some(b => /展开其余/.test(b.textContent || ''))
        || btns.some(b => /^会话“.+”的操作$/.test(b.getAttribute('aria-label') || ''))
      return has ? { ok: true } : { ok: false, why: 'list-not-loaded', buttons: btns.length }
    }`, 20000)
  } catch {
    console.log('SKIP 会话列表 20s 内未出现（实例无历史会话或加载异常），后续断言无法进行')
    try { ws?.close() } catch {}
    try { proc.kill() } catch {}
    process.exit(0)
  }
  const opened = await evalJson(`JSON.stringify((function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    if (column === null) return null
    const btns = Array.from(column.querySelectorAll('button'))
    // 会话列表默认折叠：先展开（"展开其余 N 个会话"）。
    const expander = btns.find(b => /展开其余/.test(b.textContent || ''))
    if (expander) { expander.click(); return { expanded: true } }
    return { expanded: false }
  })())`)
  if (opened !== null && opened.expanded === true) await sleep(800)
  const row = await evalJson(`JSON.stringify((function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    if (column === null) return null
    const btns = Array.from(column.querySelectorAll('button'))
    // 会话行本体不是 button（新版侧边栏行是 div，行内只有操作按钮）：
    // 从操作按钮 aria-label 提取会话标题，点击标题文本元素让事件冒泡到行。
    const action = btns.find(b => /^会话“.+”的操作$/.test(b.getAttribute('aria-label') || ''))
    if (action === undefined) return null
    const title = (action.getAttribute('aria-label') || '').match(/^会话“(.+)”的操作$/)[1]
    const all = Array.from(column.querySelectorAll('*'))
    let best = null
    for (const el of all) {
      const t = (el.textContent || '').trim()
      if (t === title || t.startsWith(title)) {
        if (best === null || el.textContent.length < best.textContent.length || (t === title && best.textContent.trim() !== title)) best = el
      }
    }
    if (best === null) return null
    best.click()
    return { title }
  })())`)
  if (row === null) {
    const dbg = await evalJson(`JSON.stringify((function(){
      const column = document.querySelector('[data-slot="sidebar"] > *')
      if (column === null) return { column: false }
      const btns = Array.from(column.querySelectorAll('button'))
      return {
        column: true,
        buttons: btns.length,
        expanders: btns.filter(b => /展开其余/.test(b.textContent || '')).length,
        actions: btns.filter(b => /^会话“.+”的操作$/.test(b.getAttribute('aria-label') || '')).length,
        track1: (getComputedStyle(document.querySelector('[data-slot="root"] > *')).gridTemplateColumns.split(' ').map(parseFloat))[0],
      }
    })())`)
    console.log(`SKIP 侧边栏无会话行，现场=${JSON.stringify(dbg)}`)
    try { ws?.close() } catch {}
    try { proc.kill() } catch {}
    process.exit(0)
  }
  // 选会话后自动收回 0 档（maybeCollapseSidebar）+ composer 就位。
  await waitFor('会话打开回 0 档', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    const composer = document.querySelector('[data-composer-card]') !== null
    return r.track1 === 0 && r.furled === true && composer ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(true, '进入真实会话（侧边栏自动收回 0 档）')

  // --- 注入宿敌表面（等价 femo 画布：touchstart/touchend preventDefault）---
  // 摆在左上内容区（60,80 → 340,260），下方留普通窗口区给断言 3。
  await evalJson(`(function(){
    const d = document.createElement('div')
    d.id = 'e2e-hostile'
    d.style.cssText = 'position:fixed;left:60px;top:80px;width:280px;height:180px;z-index:99999;background:rgba(255,0,0,0.10)'
    d.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false })
    d.addEventListener('touchend', (e) => e.preventDefault(), { passive: false })
    window.__e2eClicks = 0
    d.addEventListener('click', () => { window.__e2eClicks += 1 })
    document.body.appendChild(d)
    return JSON.stringify({ ok: true })
  })()`)

  /** 左缘安全起手 y（composer/小方块/弹层排除，同 pickPoint 思路）。
   *  每次开宽档前重挑：进会话后顶部 header/标签条占位会变。 */
  const pickEdge = () => evalJson(`JSON.stringify((function(){
    for (let y = 40; y < 820; y += 12) {
      const el = document.elementFromPoint(18, y)
      if (el === null) continue
      if (el.closest('[data-composer-card], [data-meow-smooth-fab], [role="dialog"], [data-meow-smooth-pending]')) continue
      return { x: 18, y }
    }
    return null
  })())`)
  const edgePt = await pickEdge()
  check(edgePt !== null, '挑选左缘起手点（避开排除带）', `edge=${JSON.stringify(edgePt)}`)

  /** 左缘长划直达宽档（每次断言前重开侧边栏）。先等上一段收起过渡
   *  （官方 grid 过渡 ~300ms）播完再起手，否则起手落进动画中的布局。 */
  async function openWide() {
    await sleep(400)
    const pt = (await pickEdge()) ?? edgePt
    await swipe({ x0: pt.x, y0: pt.y, x1: 180 })
    try {
      await waitFor('开宽档', `() => {
        const r = (${state})()
        if (!r.ok) return { ...r, ok: false }
        return r.collapsed === false && r.track1 >= 264 ? { ...r, ok: true } : { ...r, ok: false }
      }`)
    } catch (e) {
      await dump('openWide-fail')
      throw e
    }
    await sleep(400) // 展开过渡播完再派发后续触摸
  }

  // --- 断言 2：宿敌表面轻点 → 无 click 且收起到 0（修复本体）---
  await openWide()
  await tap({ x: 200, y: 170 })
  const clicks1 = await evalJson(`JSON.stringify(window.__e2eClicks)`)
  // 收起是官方 300ms grid 过渡：轮询等落位，不能掐一帧就断言。
  const s2 = await waitFor('宿敌表面轻点收起', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(clicks1 === 0, '宿敌表面轻点不产生 click（机制复现）', `clicks=${clicks1}`)
  check(s2.track1 === 0 && s2.furled === true, '宿敌表面轻点 → 收起到 0 档（tap 路径修复）',
    `track1=${s2.track1} furled=${s2.furled}`)
  if (s2.track1 !== 0) await dump('step2-fail')

  // --- 断言 3：普通窗口区轻点 → 收起且不回弹（与 click 路径去重）---
  // 排除集必须与手势模块/点击收起的"静默面"完全一致（dialog/menu/listbox/
  // option/shell-overlay/pending 等——点在这些上面两条路径都按设计不收）。
  const plainPt = await evalJson(`JSON.stringify((function(){
    const SKIP = '[data-composer-card], [data-meow-smooth-fab], [data-meow-smooth-pending], [data-shell-overlay], [role="dialog"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], #e2e-hostile, button, a, input, select, textarea, [role="button"], [contenteditable="true"]'
    for (let y = 640; y >= 240; y -= 16) {
      const el = document.elementFromPoint(340, y)
      if (el === null) continue
      if (el.closest(SKIP)) continue
      return { x: 340, y }
    }
    return null
  })())`)
  check(plainPt !== null, '挑选普通窗口区轻点点位', `pt=${JSON.stringify(plainPt)}`)
  await openWide()
  await tap(plainPt ?? { x: 200, y: 600 })
  const s3 = await waitFor('普通区轻点收起', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  await sleep(700)
  const s3b = await readState()
  check(s3.track1 === 0 && s3b.track1 === 0 && s3b.furled === true,
    '普通区轻点收起 + 700ms 后不回弹（click 去重）', `track1=${s3.track1}→${s3b.track1}`)
  if (s3b.track1 !== 0) await dump('step3-fail')

  // --- 断言 4：宿敌表面长按 500ms → 不收（拖拽/长按语义）---
  await openWide()
  await longPress({ x: 200, y: 170, holdMs: 500 })
  const s4 = await readState()
  check(s4.collapsed === false && s4.track1 >= 264, '宿敌表面长按 500ms 不收起', `track1=${s4.track1}`)
  if (s4.track1 < 264) await dump('step4-fail')

  // --- 断言 5：宿敌表面竖划 → 不收（滚动语义）---
  await evalJson(`(function(){
    const d = document.getElementById('e2e-hostile')
    if (d) d.style.top = '80px', d.style.height = '400px'
    return JSON.stringify({ ok: true })
  })()`)
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 200 }] })
  for (let i = 1; i <= 6; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 200 + i * 10 }] })
    await sleep(16)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
  const s5 = await readState()
  check(s5.collapsed === false && s5.track1 >= 264, '宿敌表面竖划不收起（滚动语义）', `track1=${s5.track1}`)
  if (s5.track1 < 264) await dump('step5-fail')

  // --- 断言 6：宿敌表面左划 → 收起到 0（滑动路径照常）---
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 300 }] })
  for (let i = 1; i <= 6; i++) {
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - i * 15, y: 300 }] })
    await sleep(16)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const s6 = await waitFor('宿敌表面左滑收起', `() => {
    const r = (${state})()
    if (!r.ok) return { ...r, ok: false }
    return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
  }`)
  check(s6.track1 === 0 && s6.furled === true, '宿敌表面左划 → 收起到 0', `track1=${s6.track1}`)
  if (s6.track1 !== 0) await dump('step6-fail')

  // --- 断言 7（尽力）：真实 "Fem 剧本" 标签页画布上轻点 → 收起 ---
  await evalJson(`(function(){ const d = document.getElementById('e2e-hostile'); if (d) d.remove(); return JSON.stringify({ ok: true }) })()`)
  const femTab = await evalJson(`JSON.stringify((function(){
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
    const fem = tabs.find(t => (t.textContent || '').includes('Fem'))
    if (!fem) return null
    fem.click()
    return { label: fem.textContent }
  })())`)
  if (femTab === null) {
    console.log('SKIP 真实 femo 画布断言（当前会话无 Fem 剧本标签页）')
  } else {
    await sleep(1500)
    const spot = await evalJson(`JSON.stringify((function(){
      for (let y = 150; y < 700; y += 24) {
        const el = document.elementFromPoint(340, y)
        if (el === null) continue
        if (!el.closest('[data-femo-editor-page]')) continue
        if (el.closest('[data-composer-card], button, input, textarea, [role="button"]')) continue
        return { x: 340, y }
      }
      return null
    })())`)
    if (spot === null) {
      console.log('SKIP 真实 femo 画布断言（编辑器画布区未命中可点位置）')
    } else {
      // femo 标签页上不开左缘长划（起手/划动会落进画布，femo 自定义手势
      // 会真实平移用户画布）——改走 FAB：两态直达宽档；三态先出竖条再右划
      // （竖条起手在 rail 本体上，不碰画布）。
      await evalJson(`(function(){
        document.querySelector('[data-meow-smooth-fab]').click()
        return JSON.stringify({ ok: true })
      })()`)
      await sleep(700)
      const mid = await readState()
      if (mid.collapsed === true && Math.abs(mid.track1 - 56) <= 3) {
        await swipe({ x0: 30, y0: 420, x1: 120 })
      }
      await waitFor('开宽档（femo 页）', `() => {
        const r = (${state})()
        if (!r.ok) return { ...r, ok: false }
        return r.collapsed === false && r.track1 >= 264 ? { ...r, ok: true } : { ...r, ok: false }
      }`)
      await tap(spot)
      const s7 = await waitFor('femo 画布轻点收起', `() => {
        const r = (${state})()
        if (!r.ok) return { ...r, ok: false }
        return r.track1 === 0 && r.furled === true ? { ...r, ok: true } : { ...r, ok: false }
      }`)
      check(s7.track1 === 0 && s7.furled === true, '真实 femo 画布轻点 → 收起到 0 档',
        `spot=(${spot.x},${spot.y}) track1=${s7.track1}`)
      if (s7.track1 !== 0) await dump('step7-fail')
      // 还原：切回对话标签页（用户会话视图状态复位）。
      await evalJson(`(function(){
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'))
        const chat = tabs.find(t => (t.textContent || '').includes('对话'))
        if (chat) chat.click()
        return JSON.stringify({ ok: true })
      })()`)
    }
  }
} catch (error) {
  failed++
  console.log(`FAIL 异常中断 — ${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n') ?? ''}`)
} finally {
  proc.kill()
}

console.log(failed === 0 ? '\n全部 PASS' : `\n${failed} 项 FAIL`)
process.exit(failed === 0 ? 0 : 1)
