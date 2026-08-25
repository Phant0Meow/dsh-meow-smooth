/**
 * e2e：折叠输入框「重新展开」的聚焦可视性修复（2026-08-26 猫猫报：
 * 折叠态再点输入框，有时展开后被输入法遮挡——页面没上移）。
 *
 * 根因：浏览器/iOS 的聚焦上滚与键盘让位 pan 按【聚焦瞬间】的盒子几何
 * 判定；旧实现 pointerdown 先播 150ms 展开过渡、focus 又带
 * preventScroll:true —— 聚焦瞬间盒子还是一行高，被判定"已可见"，随后
 * 长高就压在键盘下。修复：聚焦路径瞬时展开（跳过过渡）+ 去掉
 * preventScroll + 键盘就位后的滚动兜底。
 *
 * headless 无法模拟真实软键盘几何，本脚本验证机制层：
 *  1. 多行草稿 → 失焦折叠生效；
 *  2. 合成 pointerdown 点卡片内非输入区（旧版遮挡场景的入口）：
 *     同一任务内断言 ①折叠属性立即移除 ②[data-input-scroll] 的
 *     transition 被抑制（inline 'none'，瞬时到位）③textarea 已持焦；
 *  3. 双 rAF 后过渡恢复（不影响其他动画节奏）。
 *
 * 运行：node scripts/e2e-composer-reveal.mjs [baseUrl]
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
const PORT = 9349
const profile = join(process.env.TEMP ?? '.', `meow-composer-reveal-e2e-${Date.now()}`)
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
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1200)

  // --- 步骤 1：灌入多行草稿（React 受控绕行：原生 setter + input 事件）---
  const draft = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ ok: false, why: 'no textarea' })
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '第一行草稿\\n第二行草稿\\n第三行草稿\\n第四行草稿\\n第五行草稿')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`)
  check(draft.ok === true, '灌入五行草稿', draft.why ?? '')
  // React 重渲染异步：等滚动窗被 mirror 撑到多行高（远超一行 ~44px）再继续。
  const grown = await waitFor('滚动窗多行高', `() => {
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    return scroll !== null && scroll.clientHeight > 80
      ? { ok: true, ch: scroll.clientHeight } : { ok: false }
  }`, 4000)
  check(grown.ok === true, '多行草稿就位（滚动窗多行高）', `ch=${grown.ch}`)

  // --- 步骤 2：点卡片外 → 失焦/兜底折叠 ---
  await evalJson(`(function(){
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return JSON.stringify({ ok: true })
  })()`)
  const folded = await waitFor('折叠生效', `() => {
    const card = document.querySelector('[data-composer-card][data-meow-smooth="collapsed"]')
    return card !== null ? { ok: true } : { ok: false }
  }`, 4000)
  check(folded.ok === true, '点卡片外 → 折叠到一行')

  // --- 步骤 3：合成 pointerdown 点卡片内非输入区 → 同任务断言瞬时展开+持焦 ---
  const result = await evalJson(`(function(){
    const card = document.querySelector('[data-composer-card]')
    const ta = card.querySelector('textarea')
    const scroll = card.querySelector('[data-input-scroll]')
    // 找卡片内一个非交互落点：优先卡片自身的 padding 区（textarea 外）。
    let padEl = null
    const walk = (el) => {
      for (const child of el.children) {
        if (child === scroll || child.contains(scroll)) continue
        if (child.closest('button, select, input, a, [role="menuitem"], [role="menu"], [role="button"]')) continue
        padEl = child
        return true
      }
      return false
    }
    if (!walk(card)) padEl = card // 没有独立子块就落在卡片本身（capture 按 closest 命中）
    const before = {
      folded: card.getAttribute('data-meow-smooth'),
    }
    padEl.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: Math.round(padEl.getBoundingClientRect().left + 4),
      clientY: Math.round(padEl.getBoundingClientRect().top + 4),
      pointerType: 'touch', isPrimary: true,
    }))
    // 同一任务内读态：瞬时展开的证据链。
    const after = {
      foldedAttr: card.getAttribute('data-meow-smooth'),
      transitionInline: scroll.style.transition,
      transitionComputed: getComputedStyle(scroll).transitionDuration,
      focused: document.activeElement === ta,
    }
    return JSON.stringify({ before, after, padTag: padEl.tagName, padCls: String(padEl.className).slice(0, 30) })
  })()`)
  console.log('落点:', `${result.padTag}.${result.padCls} 展开前折叠态=${result.before.folded}`)
  check(result.after.foldedAttr === null, 'pointerdown 同步移除折叠属性（展开启动）', `attr=${result.after.foldedAttr}`)
  check(result.after.transitionInline === 'none', '展开为瞬时模式（inline transition:none 抑制过渡）',
    `inline=${result.after.transitionInline}`)
  check(result.after.focused === true, 'textarea 同步持焦（无 preventScroll 的编程聚焦）')

  // --- 步骤 4：双 rAF 后过渡恢复 ---
  const restored = await evalJson(`(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    return JSON.stringify({ transitionInline: scroll.style.transition })
  })()`, true)
  check(restored.transitionInline === '', '双 rAF 后过渡恢复（不污染后续动画）', `inline='${restored.transitionInline}'`)

  // --- 步骤 5：草稿仍在（受控层无竞争——v5.3 后换行/内容不被抹） ---
  const kept = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    return JSON.stringify({ lines: (ta.value.match(/\\n/g) ?? []).length + 1 })
  })()`)
  check(kept.lines === 5, '五行走原生路径完整保留', `lines=${kept.lines}`)

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
