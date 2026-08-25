/**
 * e2e：会话切换自动聚焦抑制（需求⑳——输入法弹起一下再收回很碍眼，
 * 程序化聚焦应在键盘弹出前被撤掉）。裸 CDP 驱动 headless Edge：
 *
 *  路径 A（抑制）：程序化 focus composer textarea（模拟官方 unlock
 *    effect）→ 300ms 后 activeElement 不再是它（被 capture 阶段 blur），
 *    且折叠卡片不被展开；
 *  路径 B（放行）：先派发 composer 卡片内 pointerdown 再 focus（模拟
 *    用户点输入框）→ 焦点保持。
 *
 * 运行：node scripts/e2e-autofocus.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const probe = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null || !probe.ok) {
  console.log(`FAIL ${BASE}/plugins/meow-smooth/client.js 不可达 — 该实例未装配 meow-smooth？`)
  process.exit(1)
}
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
const PORT = 9347
const profile = join(process.env.TEMP ?? '.', `meow-autofocus-e2e-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
    await sleep(250)
  }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  return tab.webSocketDebuggerUrl
}
let ws, seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 15000)
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
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (text.includes('meow-smooth')) console.log(`CONSOLE> ${text}`)
    }
    if (msg.method === 'Fetch.requestPaused') {
      const body = Buffer.from(JSON.stringify({ approvals: [], questions: [], events: [] })).toString('base64')
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId: msg.params.requestId, responseCode: 200, body } }))
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (text.includes('suppress')) console.log(`CONSOLE> ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`PAGE-EXC> ${d.exception?.description ?? d.text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`PAGE-EXC> ${d.exception?.description ?? d.text}`)
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
  await call('Page.navigate', { url: `${BASE}/?meow-debug` })

  async function poll(label, expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
      if (last.ok === true) return last
      await sleep(120)
    }
    throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
  }

  await poll('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  // 等最新构建标记（rev 滞后防护）
  for (let i = 0; i < 12; i++) {
    const tag = await evalJson(`JSON.stringify(document.documentElement.dataset.meowSmoothGestureLoaded ?? '')`)
    if (tag === 'v5-autofocus') break
    await call('Page.reload', {})
    await sleep(2000)
    await poll('AppFrame 挂载(reload)', `() => {
      const frame = document.querySelector('[data-slot="root"] > *')
      return frame !== null ? { ok: true } : { ok: false }
    }`, 15000)
  }
  await sleep(1200)

  // --- 路径 A：程序化聚焦（模拟官方 unlock effect）→ 被抑制 ---
  // 内联 before/after 双采样 + 抑制器 trace（awaitPromise 等待异步采样完成）。
  // 先 blur 再 focus：确保 focusin 真正派发（已聚焦元素重复 focus 是 no-op）。
  const probeA = await call('Runtime.evaluate', { expression: `(async function(){
    const read = () => ({
      active: document.activeElement?.tagName ?? null,
      supTrace: window.__meowSuppressTrace ?? [],
    })
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ err: 'no textarea' })
    window.__afTarget = ta
    ta.blur()
    await new Promise(r => setTimeout(r, 60))
    const before = read()
    ta.focus({ preventScroll: true })
    await new Promise(r => setTimeout(r, 300))
    return JSON.stringify({ before, after: read(), focusedNow: document.activeElement === window.__afTarget })
  })()`, returnByValue: true, awaitPromise: true })
  if (probeA.exceptionDetails !== undefined) throw new Error(`页面异常: ${probeA.exceptionDetails.text}`)
  const pa = JSON.parse(probeA.result.value)
  check(pa.after.active !== 'TEXTAREA', '路径 A：程序化聚焦被立即撤焦（键盘不弹）', `before=${pa.before.active} after=${pa.after.active} trace=${JSON.stringify(pa.after.supTrace)}`)

  // --- 决定性实验：手动派发合成 focusin，看抑制器是否存活 ---
  const alive = await evalJson(`(function(){
    const out = {}
    try {
      window.__syn = 0
      window.__errs = []
      window.addEventListener('error', ev => window.__errs.push(String(ev.message ?? ev.error)))
      out.before = (window.__meowSuppressTrace ?? []).join(' | ')
      const ta = document.querySelector('[data-composer-card] textarea')
      if (ta === null) { out.err = 'no ta'; return JSON.stringify(out) }
      ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      out.mid = (window.__meowSuppressTrace ?? []).join(' | ')
      out.syn = window.__syn
      out.active = document.activeElement?.tagName ?? null
    } catch (e) { out.err = String(e) }
    out.errs = JSON.stringify(window.__errs ?? [])
    return JSON.stringify(out)
  })())`)
  console.log(`alive> ${alive}`)

  // --- 路径 A2：折叠卡片不被展开（无焦点=无输入意图） ---
  const a2 = await evalJson(`JSON.stringify({
    expanded: document.querySelector('[data-composer-card]')?.hasAttribute('data-meow-smooth') ?? null,
  })`)
  check(a2.expanded !== true, '被抑制的聚焦不展开折叠卡片', `expanded=${a2.expanded}`)

  // --- 路径 B：用户点输入框（pointerdown 先行 + focus）→ 放行 ---
  await evalJson(`(function(){
    const ta = window.__afTarget
    const pd = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: 60, clientY: 800, pointerType: 'touch', isPrimary: true,
    })
    ta.dispatchEvent(pd)
    ta.focus({ preventScroll: true })
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(250)
  const b1 = await evalJson(`JSON.stringify({ focused: document.activeElement === window.__afTarget })`)
  check(b1.focused === true, '路径 B：用户点击输入框 → 聚焦正常保留', `focused=${b1.focused}`)
} catch (error) {
  failed++
  console.log(`FAIL 异常中断 — ${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n') ?? ''}`)
} finally {
  proc.kill()
}

console.log(failed === 0 ? '\n全部 PASS' : `\n${failed} 项 FAIL`)
process.exit(failed === 0 ? 0 : 1)
