/**
 * e2e：IME 检测折叠屏/分屏半窗修复（2026-08-31 猫猫报：分屏使用时永远
 * 只显示 IME 悬浮条、原生 header 消失）。
 *
 * 根因：旧 imeActive() = screen.height − vv.height > 20% 物理屏。screen.height
 * 是整块物理屏，分屏/折叠半窗的 vv 天生 ≈ 半屏 → 差值恒超阈值 → 恒误判
 * 键盘弹出 → html[data-meow-smooth-ime] 隐藏原生 header + 悬浮条常驻。
 *
 * 修复：动态基线（无键盘态 vv 高度的滑动跟随）+ 编辑焦点伴随信号——
 * 键盘 = vv 相对基线骤缩 ≥25%（≥120px）且近期有可编辑元素聚焦。
 *
 * 用真实页面（3080）+ CDP 仿真：
 *   A. 分屏半窗（600 高）加载、从不聚焦 → 恒无 IME 态、header 可见
 *      （旧构建恒误判，本用例复现 FAIL）
 *   B. 高窗聚焦 textarea（基线建立）→ 缩窗模拟键盘弹出 → IME 态 on；
 *      恢复窗高 → IME 态 off（键盘判定的正反两向）
 *   C. 聚焦但 vv 不缩（蓝牙键盘形态）→ 无 IME 态（无遮挡不需要条）
 *
 * 运行：node scripts/e2e-ime-viewport.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'

const probe = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null || !probe.ok) {
  console.log(`FAIL ${BASE}/plugins/meow-smooth/client.js 不可达（${probe?.status ?? '网络错误'}）— 该实例未装配 meow-smooth？`)
  process.exit(1)
}

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9373
const profile = join(process.env.TEMP ?? '.', `meow-ime-viewport-e2e-${Date.now()}`)
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
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`)
  if (typeof res.result?.value !== 'string') {
    throw new Error(`非字符串返回: ${JSON.stringify(res.result).slice(0, 300)} — expr: ${expression.slice(0, 90)}`)
  }
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
  throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
}

let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

/** IME 链路快照：html 属性 / 悬浮条存在 / header 计算样式 / vv 高度。 */
const imeSnapshot = `(() => {
  const root = document.documentElement
  const header = document.querySelector('[data-slot="conversation.session.header"] > header')
  return JSON.stringify({
    ok: true,
    imeAttr: root.getAttribute('data-meow-smooth-ime'),
    bar: document.querySelector('[data-meow-smooth-bar]') !== null,
    headerDisplay: header === null ? 'absent' : getComputedStyle(header).display,
    vv: Math.round(window.visualViewport?.height ?? 0),
    active: (document.activeElement instanceof HTMLTextAreaElement) ? 'textarea' : (document.activeElement?.tagName ?? 'null'),
  })
})()`

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Fetch.requestPaused') {
      // 拦 pending 轮询防真实卡片干扰（同 e2e-sidebar-swipe）。
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
  // 触屏仿真（pointer:coarse 生效前提）先行，再设视口，后导航——
  // isCoarsePointer 首次调用在 client 初始化，缓存于加载时。
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  // ===== 用例 A：分屏/折叠半窗（视口 600、物理屏 900 固定）从不聚焦 → 恒无 IME 态 =====
  // screenWidth/Height 必须显式固定：缺省时仿真会让 screen.height 跟随视口，
  // 真机"物理屏不变、半窗只占一部分"的结构就丢了（旧判定恰好靠这个差值误判）。
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 600, screenWidth: 1280, screenHeight: 900, deviceScaleFactor: 2, mobile: true })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1700) // 跨 ≥3 个 500ms 轮询 tick，让旧判定充分暴露
  // home 新会话页的官方 header 本身就是隐藏的（空壳）——先进真实会话再断言。
  await waitFor('会话行出现', `() => {
    const row = [...document.querySelectorAll('div[role=treeitem]')].find(el => /分钟|小时|天|周/.test(el.textContent || ''))
    return row !== undefined ? { ok: true } : { ok: false }
  }`, 15000)
  await evalJson(`(() => {
    const row = [...document.querySelectorAll('div[role=treeitem]')].find(el => /分钟|小时|天|周/.test(el.textContent || ''))
    if (row !== undefined) row.click()
    return JSON.stringify({ ok: true })
  })()`)
  await waitFor('进入会话（header 可见）', `() => {
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    return header !== null && header.children.length > 0 && getComputedStyle(header).display !== 'none'
      ? { ok: true } : { ok: false }
  }`, 15000)
  const a = await evalJson(imeSnapshot)
  check(a.imeAttr === null, 'A1 半窗无聚焦 → html 无 IME 属性', `imeAttr=${a.imeAttr} vv=${a.vv}`)
  check(a.bar === false, 'A2 半窗无聚焦 → 无 IME 悬浮条', `bar=${a.bar}`)
  check(a.headerDisplay !== 'none', 'A3 半窗无聚焦 → 原生 header 可见（会话页）', `display=${a.headerDisplay} vv=${a.vv}`)

  // ===== 用例 B：高窗聚焦建立基线 → 缩窗模拟键盘 → on；恢复 → off =====
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: true })
  await sleep(900) // vv resize → 基线跟随到 900 窗态
  // 直派发 pointerdown（建立 lastComposerPointer，supFocusIn 放行）+ 聚焦。
  await evalJson(`(async () => {
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ ok: false, error: 'no textarea' })
    const rect = ta.getBoundingClientRect()
    const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch',
      clientX: rect.left + rect.width / 2, clientY: Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1) })
    ta.dispatchEvent(pd)
    ta.focus()
    await new Promise(r => setTimeout(r, 300))
    return JSON.stringify({ ok: document.activeElement === ta })
  })()`)
  const b0 = await evalJson(imeSnapshot)
  check(b0.active === 'textarea', 'B1 textarea 已聚焦', `active=${b0.active} vv=${b0.vv}`)
  check(b0.imeAttr === null && b0.bar === false, 'B2 聚焦但 vv 未缩（蓝牙键盘形态）→ 无 IME 态', `imeAttr=${b0.imeAttr} bar=${b0.bar} vv=${b0.vv}`)
  // 缩窗 900→520：模拟键盘弹出占掉 ~380px（≥25% 基线）
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 520, deviceScaleFactor: 2, mobile: true })
  await sleep(1200) // vv resize 事件 + 500ms 轮询 tick
  const b1 = await evalJson(imeSnapshot)
  check(b1.imeAttr === 'true' && b1.bar === true, 'B3 vv 骤缩+聚焦 → IME 态 on（条显示）', `imeAttr=${b1.imeAttr} bar=${b1.bar} vv=${b1.vv}`)
  check(b1.headerDisplay === 'none', 'B4 IME 态下原生 header 隐藏（设计行为）', `display=${b1.headerDisplay}`)
  // 恢复窗高：模拟键盘收起
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: true })
  await sleep(1200)
  const b2 = await evalJson(imeSnapshot)
  check(b2.imeAttr === null && b2.bar === false, 'B5 vv 恢复 → IME 态 off（条移除）', `imeAttr=${b2.imeAttr} bar=${b2.bar} vv=${b2.vv}`)
  check(b2.headerDisplay !== 'none', 'B6 header 恢复可见', `display=${b2.headerDisplay}`)

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.log('FAIL', error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
