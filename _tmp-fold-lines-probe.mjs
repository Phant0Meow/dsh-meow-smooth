/**
 * 临时探针：失焦折叠分端断言（2026-09-02 PR#6 适配，猫猫拍板桌面 3 行/手机 1 行）。
 *
 * 三阶段：
 *  A. 桌面视口（1280×800）：灌 40 行草稿 → 聚焦 → 失焦折叠 → 折叠高度 ≈ 2 行（明显大于 1 行 30px）；
 *  B. 同页切窄屏（375×667）：折叠态跨过 1024 断点 → resize 重算把已折叠卡片变量改写为 1 行；
 *  C. 窄屏下展开再重新折叠 → foldLines() 窄屏分支实测 1 行高。
 *（2026-09-02 二次拍板：桌面 3 行仍高 → 改 2 行。）
 *
 * 运行：node scripts/../_tmp-fold-lines-probe.mjs [baseUrl]（默认 3080）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const probe = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null || !probe.ok) { console.log(`FAIL client.js 不可达`); process.exit(1) }

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9371
const profile = join(process.env.TEMP ?? '.', `meow-fold-lines-probe-${Date.now()}`)
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
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
}

/** 灌 40 行草稿 + 等可滚 */
async function fillDraft() {
  const draft = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ ok: false, why: 'no textarea' })
    const lines = Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '行草稿内容用于撑高输入框测试分端折叠行为')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, lines.join('\\n'))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`)
  if (draft.ok !== true) throw new Error(`灌草稿失败: ${draft.why}`)
  await waitFor('输入窗可滚', `() => {
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    return scroll !== null && scroll.scrollHeight > scroll.clientHeight + 1 ? { ok: true } : { ok: false }
  }`, 6000)
}

/** 聚焦再失焦（失焦折叠），等折叠属性出现，返回 {maxH, varPx, collapsed} */
async function foldAndMeasure() {
  const st = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    ta.focus()
    ta.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    ta.blur()
    // CDP headless 下程序化 focus/blur 不向 document 派发焦点事件（dbg 实测
    // __meowFoldTrace 只有 ipt/sel 无 fi/fo），合成补发——onFocusOut 不查
    // isTrusted，走的是同一条折叠逻辑。
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    return JSON.stringify({ ok: true })
  })()`)
  if (st.ok !== true) throw new Error('focus/dispatch 失败')
  return waitFor('折叠态出现', `() => {
    const card = document.querySelector('[data-composer-card][data-meow-fold="collapsed"]')
    if (card === null) return { ok: false }
    const scroll = card.querySelector('[data-input-scroll]')
    const mh = parseFloat(getComputedStyle(scroll).maxHeight)
    const v = card.style.getPropertyValue('--meow-smooth-fold-height')
    return { ok: true, maxH: Math.round(mh), varPx: v, frameW: Math.round(document.querySelector('[data-slot="root"] > *').getBoundingClientRect().width) }
  }`, 6000)
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
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1200)

  // --- A. 桌面折叠 ≈ 2 行 ---
  await fillDraft()
  const desktop = await foldAndMeasure()
  check(desktop.maxH > 40 && desktop.maxH <= 68, 'A 桌面折叠高度 ≈ 2 行（40–68px）',
    `maxH=${desktop.maxH}px var=${desktop.varPx} frameW=${desktop.frameW}`)

  // --- B. 折叠态切窄屏：跨断点 resize 重算 → 1 行 ---
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true })
  const afterShrink = await waitFor('窄屏重算为 1 行', `() => {
    const card = document.querySelector('[data-composer-card][data-meow-fold="collapsed"]')
    if (card === null) return { ok: false, why: 'no collapsed card' }
    const scroll = card.querySelector('[data-input-scroll]')
    const mh = parseFloat(getComputedStyle(scroll).maxHeight)
    return mh > 0 && mh <= 45 ? { ok: true, maxH: Math.round(mh), varPx: card.style.getPropertyValue('--meow-smooth-fold-height') } : { ok: false, maxH: Math.round(mh), varPx: card.style.getPropertyValue('--meow-smooth-fold-height') }
  }`, 6000)
  check(afterShrink.ok === true, 'B 折叠态跨断点 resize → 重算为 1 行（≤45px）',
    `maxH=${afterShrink.maxH}px var=${afterShrink.varPx}`)

  // --- C. 窄屏下展开再折叠：foldLines() 窄屏分支实测 1 行 ---
  await evalJson(`(function(){
    const card = document.querySelector('[data-composer-card]')
    if (card !== null) card.removeAttribute('data-meow-fold') // 展开（还原滚动位置逻辑不参与本次断言）
    return JSON.stringify({ ok: true })
  })()`)
  await sleep(300)
  const mobile = await foldAndMeasure()
  check(mobile.maxH > 0 && mobile.maxH <= 45, 'C 窄屏重新折叠 ≈ 1 行（≤45px）',
    `maxH=${mobile.maxH}px var=${mobile.varPx} frameW=${mobile.frameW}`)

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
