/**
 * e2e：输入框长草稿「选字滚动条狂跑」修复（2026-08-28 猫猫报：电脑端输入
 * 框长文本后想选中文字，滚动条自动跑到底部，选不到开头的字）。
 *
 * 根因：v5.5 的 ensureComposerVisible 量【textarea】底边判断"是否被键盘
 * 遮住"——但 textarea 被内部滚动窗 [data-input-scroll] 裁剪，草稿长、
 * 窗口停在上半段时 textarea 底边天然伸出视口底（那是"用户正要看开头"
 * 的正常态，不是被遮）；误判后沿祖先链"内层优先"滚动，第一个可滚的
 * 正是输入窗自己 → 被滚到最底。电脑端 onFocusIn/onPointerDownCapture
 * 无条件触发它（无键盘，本无合法职责）。
 *
 * 修复：量卡片底边（不受内部滚动影响）+ 祖先链排除内部滚动窗。
 *
 * 本脚本验证机制层（桌面视口、无触屏仿真）：
 *  1. 灌入长草稿，输入窗可滚；
 *  2. 聚焦后把窗口拨回顶部（模拟"用户滚上去看开头"）；
 *  3. 合成 pointerdown（= 开始选字的那一下点击），等 700ms；
 *  4. 断言窗口仍停在顶部（旧代码会被 ensureComposerVisible 拽到底）。
 *
 * 运行：node scripts/e2e-select-scroll.mjs [baseUrl]
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
const PORT = 9351
const profile = join(process.env.TEMP ?? '.', `meow-select-scroll-e2e-${Date.now()}`)
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
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
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
  // 桌面视口：不启用触屏仿真（电脑端场景，细指针）。
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1200)

  // --- 步骤 1：灌入长草稿（React 受控绕行：原生 setter + input 事件）---
  const draft = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ ok: false, why: 'no textarea' })
    const lines = Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '行草稿内容用于撑高输入框测试选字滚动行为')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, lines.join('\\n'))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`)
  check(draft.ok === true, '灌入 40 行长草稿', draft.why ?? '')

  // --- 步骤 2：等输入窗可滚（mirror 撑高 textarea，窗口被 max-height 截断）---
  const scrollable = await waitFor('输入窗可滚', `() => {
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    return scroll !== null && scroll.scrollHeight > scroll.clientHeight + 1
      ? { ok: true, sh: scroll.scrollHeight, ch: scroll.clientHeight } : { ok: false }
  }`, 6000)
  check(scrollable.ok === true, '输入窗进入可滚状态', `sh=${scrollable.sh} ch=${scrollable.ch}`)

  // --- 步骤 3：聚焦 textarea（等聚焦链路的 180/380ms 兜底跑完）---
  await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    ta.focus()
    return JSON.stringify({ ok: document.activeElement === ta })
  })()`)
  await sleep(700)

  // --- 步骤 4：把窗口拨回顶部 + 同任务发起"选字点击"（pointerdown）---
  // 旧代码时间线：pointerdown → revealSoon → 180/380ms 后
  // ensureComposerVisible 看到 textarea 底边伸出视口底 → 把窗口拽到底。
  const clicked = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    scroll.scrollTop = 0 // 模拟用户滚上去准备选开头的字
    const rect = ta.getBoundingClientRect()
    ta.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: Math.round(rect.left + 40),
      clientY: Math.round(rect.top + 20),
      pointerType: 'mouse', isPrimary: true, button: 0,
    }))
    return JSON.stringify({
      scrollTopAtClick: scroll.scrollTop,
      taBottom: Math.round(rect.bottom),
      vvBottom: Math.round((window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? 0)),
      sh: scroll.scrollHeight, ch: scroll.clientHeight,
    })
  })()`)
  check(clicked.scrollTopAtClick === 0, '点击瞬间窗口停在顶部（用户视角就位）',
    `scrollTop=${clicked.scrollTopAtClick} taBottom=${clicked.taBottom} vvBottom=${clicked.vvBottom} sh=${clicked.sh} ch=${clicked.ch}`)

  // --- 步骤 5：等 700ms（覆盖 revealSoon 的 180/380ms 两个采样点）---
  await sleep(700)
  const after = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    return JSON.stringify({ scrollTop: scroll.scrollTop, focused: document.activeElement === ta, lines: (ta.value.match(/\\n/g) ?? []).length + 1 })
  })()`)
  check(after.scrollTop === 0, '选字点击后窗口仍停在顶部（滚动条不被拽跑）',
    `scrollTop=${after.scrollTop}（旧代码此处=${clicked.sh - clicked.ch} 即被拽到最底）`)
  check(after.focused === true && after.lines === 40, 'textarea 持焦且 40 行草稿完整', `focused=${after.focused} lines=${after.lines}`)

  void proc
} catch (err) {
  failed++
  console.log(`FAIL 异常终止 — ${err.message}`)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}

console.log(failed === 0 ? '\n全部 PASS' : `\n${failed} 项 FAIL`)
process.exit(failed === 0 ? 0 : 1)
