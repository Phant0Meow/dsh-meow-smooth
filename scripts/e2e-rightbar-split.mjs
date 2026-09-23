/**
 * e2e：宽手机右侧面板半屏分栏（功能⑲，2026-09-19 猫猫需求）。裸 CDP 驱动
 * headless Edge，零 npm 依赖（Node ≥22 全局 WebSocket），对**真实运行中的
 * dsh 实例**做三档视口仿真，验证 560–767px 宽度带内右侧面板（sidebar-right，
 * 顶栏右缘按钮打开的文件面板）从官方"全屏覆盖"变为"屏幕中分"：
 *
 *  1. 680×844（折叠屏内屏档，分栏带内）：进会话 → 点右上角
 *     [data-sidebar-right-expand] 开面板 → 断言
 *       - 面板钉右半屏（position:fixed、left=宽/2、width=宽/2）；
 *       - 会话列 padding 让位、内容右缘钉在屏幕正中（furl 态分支 calc(100% - 50vw)）；
 *       - 手摘 furl 标记 → padding 即刻变为 +56px 分支（calc(100% + 56px - 50vw)，
 *         同一 eval 内同步取值，赶在 tick 重挂标记之前）；
 *       - 点 [data-sidebar-right-toggle] 关面板 → padding 归 0。
 *  2. 390×844（普通手机档，带外）：面板保持官方全屏（left=0、width=全宽），
 *     会话列零 padding——普通手机行为不变。
 *  3. 820×1180（平板档，≥768 官方断点）：官方原生轨道分栏
 *     （data-sidebar-right-panel="push"、第三轨 >300px）——带外不干预。
 *
 * 运行：node scripts/e2e-rightbar-split.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3081（须已装配 meow-smooth ≥0.8.0）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
// dsh web 认证：启动令牌（start-meow 日志里 `dsh web: http://...?token=…`）。
// 首次带 token 的 GET / 会铸 dsh-auth cookie，后续同源请求自动携带。
const TOKEN = process.env.MEOW_E2E_TOKEN ?? ''

// 预检：插件 client.js 必须可达（否则实例没装配，提示后退出）。
// 未带 token 时实例会以 401 挡下（登录墙优先于资源路由），不视为"未装配"。
const probe = await fetch(TOKEN ? `${BASE}/?token=${encodeURIComponent(TOKEN)}` : `${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null) {
  console.log(`FAIL ${BASE} 不可达（网络错误）— 实例没起？`)
  process.exit(1)
}
const probeAssets = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probeAssets !== null && probeAssets.status === 404 && !TOKEN) {
  console.log(`FAIL ${BASE}/plugins/meow-smooth/client.js 不可达（404）— 该实例未装配 meow-smooth？`)
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
const profile = join(process.env.TEMP ?? '.', `meow-smooth-split-e2e-${Date.now()}`)
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
  const v = res.result.value
  return typeof v === 'string' ? JSON.parse(v) : v
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
    // 弹提醒卡片干扰断言（与 furl e2e 同款去噪）。
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

  /** 页内量测：面板与会话列的几何。 */
  const geo = `() => {
    const panel = document.querySelector('[data-sidebar-right-panel]')
    const center = document.querySelector('[class*="_centerCol"]')
    const expandBtn = document.querySelector('[data-sidebar-right-expand]')
    const vw = window.innerWidth
    if (panel === null) return { ok: true, vw, panel: null, expandBtn: expandBtn !== null, center: null }
    const pr = panel.getBoundingClientRect()
    const cs = getComputedStyle(panel)
    let c = null
    if (center !== null) {
      const cr = center.getBoundingClientRect()
      const ccs = getComputedStyle(center)
      c = {
        padRight: parseFloat(ccs.paddingRight),
        // 内容右缘 = 列右缘 - padding（对话实际可用的右边界）
        contentRight: cr.right - parseFloat(ccs.paddingRight),
        left: cr.left,
        width: cr.width,
      }
    }
    return {
      ok: true,
      vw,
      expandBtn: expandBtn !== null,
      panel: {
        mode: panel.getAttribute('data-sidebar-right-panel'),
        open: panel.hasAttribute('data-sidebar-right-open'),
        position: cs.position,
        left: pr.left, width: pr.width, right: pr.right,
      },
      center: c,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true',
    }
  }`

  // ============ 阶段 1：680×844（分栏带内，furl 态分支） ============
  await call('Emulation.setDeviceMetricsOverride', { width: 680, height: 844, deviceScaleFactor: 2, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: TOKEN ? `${BASE}/?token=${encodeURIComponent(TOKEN)}` : `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1500) // React 稳定 + furl 首帧同步

  // 进会话：小方块唤出侧边栏（三态自适应）→ 点一个会话行。
  const fab = await evalJson(`(() => {
    const f = document.querySelector('[data-meow-smooth-fab]')
    if (f === null) return JSON.stringify({ ok: false, why: 'no-fab' })
    const display = getComputedStyle(f).display
    if (display === 'none') return JSON.stringify({ ok: false, why: 'fab-hidden' })
    f.click()
    return JSON.stringify({ ok: true })
  })()`)
  check(fab.ok === true, '小方块可见且点击成功', `${fab.why ?? ''}`)
  if (!fab.ok) throw new Error('小方块不可用，无法继续（' + (fab.why ?? '?') + '）')
  await sleep(700)
  // 三态自适应：侧边栏仍是收起竖条（有底部插件按钮的实例）→ 点顶部原生 toggle 展开。
  await evalJson(`(() => {
    const col = document.querySelector('[data-slot="sidebar"] > *')
    if (col === null) return JSON.stringify({ ok: false, why: 'no-column' })
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame !== null && frame.hasAttribute('data-sidebar-collapsed')) {
      const btns = col.firstElementChild.querySelectorAll('button')
      btns[btns.length - 1].click()
    }
    return JSON.stringify({ ok: true })
  })()`)
  await waitFor('侧边栏展开', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame === null) return { ok: false }
    return frame.hasAttribute('data-sidebar-collapsed') === false ? { ok: true } : { ok: false }
  }`)
  await sleep(400)
  const clicked = await evalJson(`(() => {
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
    if (rows.length === 0) return JSON.stringify({ ok: false, why: 'no-session-row' })
    rows[0].click()
    return JSON.stringify({ ok: true, label: rows[0].textContent.slice(0, 24) })
  })()`)
  check(clicked.ok === true, '会话行点击成功', `${clicked.label ?? clicked.why ?? '?'}`)
  if (!clicked.ok) throw new Error('没有可点击的会话行')
  // 等"会话页就绪"= 右上角面板按钮在场（新会话空壳页也有 header，不能只等
  // header；corner 槽随会话数据绑定异步挂载，实测 ~2.5s 内到位）。
  await waitFor('右上角面板按钮挂载', `() => {
    const expand = document.querySelector('[data-sidebar-right-expand]')
    const toggle = document.querySelector('[data-sidebar-right-toggle]')
    if (expand !== null || toggle !== null) return { ok: true, expand: expand !== null }
    return { ok: false }
  }`, 15000)
  await sleep(800) // 选会话自动收起 + 折回 furl 的 settle

  // 面板开合是按会话持久化的（layout envelope）——此前运行/真人操作可能
  // 留下展开态：expand 按钮只在该会话收起时在场，已开则面板内 toggle 在场。
  const g0 = await evalJson(`(${geo})()`)
  check(g0.expandBtn === true || (g0.panel != null && g0.panel.open === true),
    '面板控制按钮在场（收起=expand / 展开=面板已开）', `expand=${g0.expandBtn} open=${g0.panel?.open}`)
  if (g0.expandBtn === true) {
    await evalJson(`(() => { const b = document.querySelector('[data-sidebar-right-expand]'); if (b !== null) b.click(); return JSON.stringify({ ok: b !== null }) })()`)
  }
  const g1 = await waitFor('面板打开', `() => {
    const r = (${geo})()
    if (!r.ok) return r
    if (r.panel !== null && r.panel.open === true) return { ...r, ok: true }
    return { ok: false, panel: r.panel }
  }`)
  await sleep(500) // padding 过渡 + 滑入动画收敛
  const g2 = await evalJson(`(${geo})()`)
  check(g2.panel.mode === 'fullscreen', '官方判定全屏模式（autoFullscreen <768）', `mode=${g2.panel.mode}`)
  check(g2.panel.position === 'fixed', '面板 fixed 定位（官方契约）', `position=${g2.panel.position}`)
  check(Math.abs(g2.panel.left - g2.vw / 2) <= 2, '面板钉在右半屏（left=50vw）', `left=${g2.panel.left.toFixed(1)} 期望 ${g2.vw / 2}`)
  check(Math.abs(g2.panel.width - g2.vw / 2) <= 2, '面板宽 = 半屏', `width=${g2.panel.width.toFixed(1)} 期望 ${g2.vw / 2}`)
  const expectPad = g2.furled ? (g2.vw - g2.vw / 2) : (g2.vw + 56 - g2.vw / 2)
  check(Math.abs(g2.center.padRight - expectPad) <= 3, `会话列让位 padding（${g2.furled ? 'furl 分支' : 'rail+56 分支'}）`, `pad=${g2.center.padRight.toFixed(1)} 期望 ${expectPad}`)
  const expectRight = g2.vw / 2
  check(Math.abs(g2.center.contentRight - expectRight) <= 4, '对话内容右缘 = 屏幕正中', `contentRight=${g2.center.contentRight.toFixed(1)} 期望 ${expectRight}`)

  // +56px 分支：摘掉 furl 标记 → furl 的 grid 归零规则同时失效，第一轨回到
  // inline 的 56px rail，非 furl 公式 calc(100% + 56px - 50vw) 的 100% 随之
  // 变小——两个分支殊途同归，padding 都收敛到 vw/2。furl tick ≤500ms 会把
  // 标记重挂回去，所以整个实验压进同一个 eval：注入 transition:none 实现
  // jump-cut（属性一改计算样式即终值），量完即拆，tick 无从插手。
  const g3 = await evalJson(`(() => {
    const st = document.createElement('style')
    st.textContent = '[class*="_centerCol"]{transition:none!important}[data-slot="root"] > *{transition:none!important}'
    document.head.appendChild(st)
    document.documentElement.removeAttribute('data-meow-smooth-furled')
    const center = document.querySelector('[class*="_centerCol"]')
    const frame = document.querySelector('[data-slot="root"] > *')
    const cs = getComputedStyle(center)
    const out = {
      pad: parseFloat(cs.paddingRight),
      contentRight: center.getBoundingClientRect().right - parseFloat(cs.paddingRight),
      track1: parseFloat(getComputedStyle(frame).gridTemplateColumns),
    }
    document.documentElement.setAttribute('data-meow-smooth-furled', 'true')
    st.remove()
    return JSON.stringify({ ok: true, ...out })
  })()`)
  check(Math.abs(g3.track1 - 56) <= 1, '摘 furl 后第一轨回到 56px rail', `track1=${g3.track1}`)
  check(Math.abs(g3.pad - g2.vw / 2) <= 3, '非 furl（56px rail）分支收敛到 vw/2', `pad=${g3.pad.toFixed(1)} 期望 ${g2.vw / 2}`)
  check(Math.abs(g3.contentRight - g2.vw / 2) <= 4, '非 furl 分支：内容右缘仍在屏幕正中', `contentRight=${g3.contentRight.toFixed(1)} 期望 ${g2.vw / 2}`)

  // 关面板 → 让位收回。
  await evalJson(`(() => { document.querySelector('[data-sidebar-right-toggle]').click(); return JSON.stringify({ ok: true }) })()`)
  const g4 = await waitFor('面板关闭', `() => {
    const r = (${geo})()
    if (!r.ok) return r
    if (r.panel === null || r.panel.open === false) return { ...r, ok: true }
    return { ok: false, panel: r.panel }
  }`)
  await sleep(500)
  const g5 = await evalJson(`(${geo})()`)
  check(g5.center.padRight <= 2, '关面板后会话列 padding 归零', `pad=${g5.center.padRight.toFixed(1)}`)

  // ============ 阶段 2：390×844（普通手机，带外 = 官方全屏不变） ============
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await sleep(900) // ResizeObserver → setViewportWidth → React 重解
  await evalJson(`(() => { const b = document.querySelector('[data-sidebar-right-expand]'); if (b) b.click(); return JSON.stringify({ ok: b !== null }) })()`)
  const p1 = await waitFor('普通手机面板打开', `() => {
    const r = (${geo})()
    if (!r.ok) return r
    if (r.panel !== null && r.panel.open === true) return { ...r, ok: true }
    return { ok: false }
  }`)
  await sleep(500)
  const p2 = await evalJson(`(${geo})()`)
  check(Math.abs(p2.panel.left) <= 2, '普通手机：面板仍全屏（left≈0）', `left=${p2.panel.left.toFixed(1)}`)
  check(Math.abs(p2.panel.width - p2.vw) <= 2, '普通手机：面板全宽', `width=${p2.panel.width.toFixed(1)} vw=${p2.vw}`)
  check(p2.center.padRight <= 2, '普通手机：会话列零让位', `pad=${p2.center.padRight.toFixed(1)}`)
  await evalJson(`(() => { const b = document.querySelector('[data-sidebar-right-toggle]'); if (b) b.click(); return JSON.stringify({ ok: true }) })()`)
  await sleep(400)

  // ============ 阶段 3：820×1180（平板，≥768 官方原生轨道分栏） ============
  await call('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  await evalJson(`(() => { const b = document.querySelector('[data-sidebar-right-expand]'); if (b) b.click(); return JSON.stringify({ ok: b !== null }) })()`)
  const t1 = await waitFor('平板面板打开', `() => {
    const r = (${geo})()
    if (!r.ok) return r
    if (r.panel !== null && r.panel.open === true) return { ...r, ok: true }
    return { ok: false }
  }`)
  await sleep(500)
  const t2 = await evalJson(`(${geo})()`)
  check(t2.panel.mode === 'push', '平板：官方原生轨道分栏（push，非全屏）', `mode=${t2.panel.mode}`)
  check(t2.panel.left > 300, '平板：面板占据右侧轨道（不盖满）', `left=${t2.panel.left.toFixed(1)} vw=${t2.vw}`)
  check(t2.center.padRight <= 2, '平板：插件不注入额外让位', `pad=${t2.center.padRight.toFixed(1)}`)

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
} catch (e) {
  failed++
  console.log('FAIL 异常 —', e.message)
} finally {
  try { proc.kill() } catch {}
  try { ws?.close() } catch {}
}
process.exit(failed === 0 ? 0 : 1)
