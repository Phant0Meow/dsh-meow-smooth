/**
 * e2e：手机端竖条折叠为小方块（需求⑱ 两态/三态自适应）。裸 CDP 驱动
 * headless Edge，零 npm 依赖（Node ≥22 全局 WebSocket），对**真实运行中
 * 的 dsh 实例**做手机仿真（390×844 触屏、pointer:coarse）全链路回归。
 * 流程按实例状态自适应：
 *
 *  1. 初始态（两态/三态共有）：窄屏收起 → 自动 furl——html 标记挂上、
 *     第一条 grid 轨道归 0、小方块可见且已克隆鱼 logo；
 *  2a. 两态（竖条底部 = 官方基线 1 个按钮）：点小方块**直接展开**；
 *  2b. 三态（底部区有插件按钮，如 3081 的 dsh-femwa 🎭）：点小方块先
 *      唤出细竖条（插件按钮可达）→ 点竖条顶部原生 toggle 展开；
 *  3. 点会话区（边栏外）→ 收起并立即折回小方块；
 *  4. 展开点一个会话 → 会话页自动折回 + header margin 让位（标题不被鱼挡）
 *     + 会话内展开/折回让位复位。
 *
 * 运行：node scripts/e2e-sidebar-furl.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3080（须已装配 meow-smooth）。
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
const profile = join(process.env.TEMP ?? '.', `meow-smooth-furl-e2e-${Date.now()}`)
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
/** 轮询等待页面内断言条件成立。 */
async function waitFor(label, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(200)
  }
  throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
}

let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    // 拦截 pending 轮询返回空数据：实例上真实的未决审批/提问/失败事件会
    // 弹提醒卡片，卡片按设计盖住左上角、小方块随之退场（避让规则）——
    // 断言就随实例状态漂移了。拦掉才有确定性。
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
  // 手机仿真：视口 390×844 + 触屏（pointer:coarse / hover:none 随之成立，
  // 与 DevTools 设备模式同源）。
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })

  // 等 AppFrame 挂载 + 插件首帧同步完成。
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1200) // 留给 React 稳定 + 至少一个 500ms 同步 tick

  const state = `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame === null) return { ok: false, why: 'no-frame' }
    const cols = getComputedStyle(frame).gridTemplateColumns.split(' ').map(s => parseFloat(s))
    const fab = document.querySelector('[data-meow-smooth-fab]')
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const foot = column ? column.lastElementChild : null
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    return {
      ok: true,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true',
      collapsed: frame.hasAttribute('data-sidebar-collapsed'),
      track1: cols[0],
      fabVisible: fab !== null && getComputedStyle(fab).display !== 'none',
      fabIcon: fab !== null ? fab.querySelectorAll('svg').length : -1,
      fabRect: fab !== null ? (({ left, top, width, height }) => ({ left, top, width, height }))(fab.getBoundingClientRect()) : null,
      footButtons: foot !== null ? foot.querySelectorAll('button').length : -1,
      titleMargin: header !== null ? getComputedStyle(header).marginLeft : null,
      headerH: header !== null ? header.getBoundingClientRect().height : -1,
      headerExists: header !== null,
    }
  }`

  // --- 断言 1：初始自动 furl（两态/三态共有） ---
  const s1 = await waitFor('初始 furl', state)
  const threeState = s1.footButtons > 1
  console.log(`mode: ${threeState ? '三态（竖条底部有插件按钮）' : '两态'} @ ${BASE}`)
  check(s1.collapsed === true, '初始为收起态（本体契约）', `collapsed=${s1.collapsed}`)
  check(s1.footButtons >= 1, '竖条底部区按钮数正常', `footButtons=${s1.footButtons}`)
  check(s1.furled === true, '初始自动折叠：html furl 标记已挂', `furled=${s1.furled}`)
  check(s1.track1 === 0, '第一条 grid 轨道归 0（竖条不再占宽）', `track1=${s1.track1}px`)
  check(s1.fabVisible === true, '小方块按钮可见', '')
  check(s1.fabIcon >= 1, '小方块已克隆到鱼 logo', `svg×${s1.fabIcon}`)
  check(s1.fabRect !== null && s1.fabRect.left === 0 && s1.fabRect.width === 56,
    '小方块 = 原竖条宽度 56px 贴角切片', `left=${s1.fabRect?.left} ${s1.fabRect?.width}×${s1.fabRect?.height}`)
  // 注：新会话页的 header 是空壳（无内容），让位断言在会话页阶段做。

  /** 展开侧边栏（模式自适应）：两态点小方块即展开；三态点小方块先出
   *  竖条、再点竖条顶部原生 toggle 展开。 */
  async function expandForTest() {
    await evalJson(`(function(){
      document.querySelector('[data-meow-smooth-fab]').click()
      return JSON.stringify({ ok: true })
    })()`)
    if (threeState) {
      await waitFor('三态：唤出竖条', `() => {
        const r = (${state})()
        if (!r.ok) return r
        if (r.collapsed === true && r.track1 === 56 && r.furled === false) return { ...r, ok: true }
        return { ok: false, collapsed: r.collapsed, track1: r.track1, furled: r.furled }
      }`)
      await evalJson(`(function(){
        const col = document.querySelector('[data-slot="sidebar"] > *')
        const btns = col.firstElementChild.querySelectorAll('button')
        btns[btns.length - 1].click()
        return JSON.stringify({ ok: true })
      })()`)
    }
    await waitFor('展开', `() => {
      const frame = document.querySelector('[data-slot="root"] > *')
      if (frame === null) return { ok: false }
      return frame.hasAttribute('data-sidebar-collapsed') === false && parseFloat(getComputedStyle(frame).gridTemplateColumns) >= 264
        ? { ok: true } : { ok: false }
    }`)
    await sleep(400) // grid 过渡收敛
  }

  if (!threeState) {
    // --- 断言 2a（两态）：点小方块 → 直接展开 ---
    await expandForTest()
    const s2 = await waitFor('两态展开态', state)
    check(s2.collapsed === false && s2.track1 >= 264, '两态：点小方块直接展开完整侧边栏', `track1=${s2.track1}px`)
    check(s2.furled === false, 'furl 解除', `furled=${s2.furled}`)
    check(s2.fabVisible === false, '小方块随之隐藏', '')
  } else {
    // --- 断言 2b（三态）：点小方块 → 竖条（插件按钮可达）→ 展开 ---
    await expandForTest()
    const s2 = await waitFor('三态展开态', state)
    check(s2.collapsed === false && s2.track1 >= 264, '三态：小方块→竖条→原生 toggle→展开', `track1=${s2.track1}px`)
    check(s2.furled === false && s2.fabVisible === false, '展开态 furl 解除、小方块隐藏', '')
  }

  // --- 断言 3：点边栏外 → 收起并立即折回小方块（两态/三态共有） ---
  await evalJson(`(function(){
    const conv = document.querySelector('[data-slot="conversation"]') ?? document.body
    conv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(900)
  const s3 = await waitFor('折回小方块', state)
  check(s3.collapsed === true, '点边栏外后重新收起', `collapsed=${s3.collapsed}`)
  check(s3.furled === true, '收起后自动折回 furl 态（不闪竖条）', `furled=${s3.furled}`)
  check(s3.track1 === 0, '轨道再次归 0', `track1=${s3.track1}px`)
  check(s3.fabVisible === true, '小方块重新出现', '')

  // --- 断言 4：展开 → 点一个会话 → 会话页自动折回 + header 让位 ---
  await expandForTest()
  const clicked = await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
    if (rows.length === 0) return JSON.stringify({ ok: false, why: 'no-session-row' })
    rows[0].click()
    return JSON.stringify({ ok: true, label: rows[0].textContent.slice(0, 24) })
  })()`)
  console.log(`clicked: ${JSON.stringify(clicked)}`)
  const s4 = await waitFor('会话页折回', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.furled === true && r.track1 === 0) return { ...r, ok: true }
    return { ok: false, furled: r.furled, track1: r.track1 }
  }`, 12000)
  check(clicked.ok === true, '会话行点击成功（treeitem）', `${clicked.label ?? clicked.why ?? '?'}`)
  check(s4.furled === true && s4.track1 === 0, '选会话后自动收起并折回小方块', `furled=${s4.furled} track1=${s4.track1}px`)
  // 会话页 header 有实体内容：整体 margin 让位生效 + 色块等高。
  const s5 = await waitFor('会话页 header 挂载', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.titleMargin !== null) return { ...r, ok: true }
    return { ok: false, titleMargin: r.titleMargin }
  }`)
  check(s5.titleMargin === '56px', '会话页 header margin-left=56px（标题/标签不被鱼挡）', `margin=${s5.titleMargin}`)
  const s5b = await waitFor('色块等高', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (Math.abs(r.fabRect.height - r.headerH) <= 1) return { ...r, ok: true }
    return { ok: false, fabH: r.fabRect.height, headerH: r.headerH }
  }`)
  check(Math.abs(s5b.fabRect.height - s5b.headerH) <= 1, '色块高度 = header 实高（底边与 header 底边重合）', `fab=${s5b.fabRect.height}px header=${s5b.headerH}px`)

  // --- 断言 5：会话内展开/折回，让位随之复位/恢复 ---
  await expandForTest()
  const s6 = await waitFor('会话内展开', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.collapsed === false && r.track1 >= 264) return { ...r, ok: true }
    return { ok: false, collapsed: r.collapsed, track1: r.track1 }
  }`)
  check(s6.titleMargin === '0px', '会话内展开后让位复位', `margin=${s6.titleMargin}`)
  await evalJson(`(function(){
    const conv = document.querySelector('[data-slot="conversation"]') ?? document.body
    conv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }))
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(900)
  const s7 = await waitFor('会话内折回', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.furled === true && r.track1 === 0) return { ...r, ok: true }
    return { ok: false, furled: r.furled, track1: r.track1 }
  }`)
  check(s7.titleMargin === '56px', '会话内折回后重新让位', `margin=${s7.titleMargin}`)

  // --- 断言 6（可选，dsh-femwa 装配的实例）：全屏视图盖住 header → 色块退场 ---
  // femGen 画布（Fem 编辑器标签）盖在 header 上面时，header 显示态正常
  // （display:block）但视觉上被顶掉——覆盖检测应让色块同步退场；切回
  // 对话标签后回归。
  const femTab = await evalJson(`(function(){
    const list = [...document.querySelectorAll('[data-slot="conversation.session.header"] [role="tab"]')]
    const fem = list.find(b => /Fem|剧本/.test(b.textContent))
    return JSON.stringify({ ok: fem !== undefined, label: fem?.textContent.trim() ?? '' })
  })()`)
  if (femTab.ok === true) {
    await evalJson(`(function(){
      const list = [...document.querySelectorAll('[data-slot="conversation.session.header"] [role="tab"]')]
      list.find(b => /Fem|剧本/.test(b.textContent)).click()
      return JSON.stringify({ ok: true })
    })()`)
    const s8 = await waitFor('femGen 覆盖 header → 色块退场', `() => {
      const r = (${state})()
      if (!r.ok) return r
      if (r.fabVisible === false) return { ...r, ok: true }
      return { ok: false, fabVisible: r.fabVisible }
    }`, 5000)
    check(s8.fabVisible === false, 'femGen 全屏视图盖住 header：色块同步退场（覆盖检测）', '')
    // 切回对话标签 → header 重新可见 → 色块回归
    await evalJson(`(function(){
      const list = [...document.querySelectorAll('[data-slot="conversation.session.header"] [role="tab"]')]
      const chat = list.find(b => /对话/.test(b.textContent)) ?? list[0]
      chat.click()
      return JSON.stringify({ ok: true })
    })()`)
    const s9 = await waitFor('切回对话 → 色块回归', `() => {
      const r = (${state})()
      if (!r.ok) return r
      if (r.fabVisible === true && r.furled === true) return { ...r, ok: true }
      return { ok: false, fabVisible: r.fabVisible, furled: r.furled }
    }`, 5000)
    check(s9.fabVisible === true && s9.furled === true, '切回对话视图：色块回归', `furled=${s9.furled}`)
  } else {
    console.log('info 当前会话无 Fem 编辑器标签，跳过覆盖检测断言')
  }

  // --- 断言 6：header 隐藏 ⇄ 色块同进退 ---
  // 6a. IME 路径（即时 CSS 规则）：挂 html[ime] → header 与色块同时退场
  await evalJson(`(function(){
    document.documentElement.setAttribute('data-meow-smooth-ime', 'true')
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(150)
  const s8 = await waitFor('IME 态退场', `() => {
    const r = (${state})()
    if (!r.ok) return r
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    const headerHidden = header !== null && getComputedStyle(header).display === 'none'
    if (headerHidden && r.fabVisible === false) return { ...r, ok: true }
    return { ok: false, headerHidden, fabVisible: r.fabVisible }
  }`)
  check(s8.fabVisible === false, 'IME 态（header 隐藏）：色块同步退场', '')
  // 6b. 结构性兜底：绕过 ime attr，直接 inline 隐藏 header（任何隐藏来源）
  // → 色块在 ≤500ms 轮询内退场；恢复后回归。
  await evalJson(`(function(){
    document.documentElement.removeAttribute('data-meow-smooth-ime')
    document.querySelector('[data-slot="conversation.session.header"] > header').style.display = 'none'
    return JSON.stringify({ ok: true })
  })()`)
  const s9 = await waitFor('兜底路径退场', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.fabVisible === false) return { ...r, ok: true }
    return { ok: false, fabVisible: r.fabVisible }
  }`, 3000)
  check(s9.fabVisible === false, '结构性兜底：inline 隐藏 header → 色块退场（≤500ms）', '')
  await evalJson(`(function(){
    document.querySelector('[data-slot="conversation.session.header"] > header').style.display = ''
    return JSON.stringify({ ok: true })
  })()`)
  const s10 = await waitFor('header 恢复后色块回归', `() => {
    const r = (${state})()
    if (!r.ok) return r
    if (r.fabVisible === true && r.furled === true) return { ...r, ok: true }
    return { ok: false, fabVisible: r.fabVisible, furled: r.furled }
  }`, 3000)
  check(s10.fabVisible === true && s10.furled === true, 'header 恢复显示 → 色块回归', `furled=${s10.furled}`)

  if (failed > 0) process.exitCode = 1
  else console.log('\n全部断言 PASS')
} catch (error) {
  console.log(`FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
