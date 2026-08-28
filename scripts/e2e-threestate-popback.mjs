/**
 * e2e：三态 furl「竖条点外部收起后又立即弹回」复现/回归（2026-08-28 猫猫报，
 * 3081 独有——只有装了侧栏插件按钮的实例走三态）。
 *
 * 根因：三态 FAB 点击置 railRevealed=true（轮询不得重新折叠，竖条是中间
 * 态）；但从竖条点外部 collapseToZero 回 0 档时 data-sidebar-collapsed
 * 全程不变（竖条和 0 档都是收起态），railRevealed 的转换检测清不掉它
 * → 500ms tick 走"不得重新折叠"分支强制 setFurled(false) → 竖条弹回。
 * 3080 两态从不置 railRevealed，所以完全好的。
 *
 * 流程（390×844 触屏仿真，三态实例）：
 *  1. 初始 FAB 态（collapsed+furled+track1=0）；
 *  2. 点 FAB → 竖条（collapsed 不变、furled 解除、track1=56）；
 *  3. 点外部 → 折回 FAB（furled、track1=0）；
 *  4. 【关键】采样 2.5s：furled 必须保持 true——旧代码 ≤500ms 内被
 *     tick 强制解除（竖条弹回），修复后稳定。
 *
 * 运行：node scripts/e2e-threestate-popback.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'

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
const PORT = 9359
const profile = join(process.env.TEMP ?? '.', `meow-popback-e2e-${Date.now()}`)
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
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
  return JSON.parse(res.result.value)
}
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
  await sleep(1300)

  const state = `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame === null) return { ok: false, why: 'no-frame' }
    const cols = getComputedStyle(frame).gridTemplateColumns.split(' ').map(s => parseFloat(s))
    const fab = document.querySelector('[data-meow-smooth-fab]')
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const foot = column ? column.lastElementChild : null
    return {
      ok: true,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true',
      collapsed: frame.hasAttribute('data-sidebar-collapsed'),
      track1: cols[0],
      fabVisible: fab !== null && getComputedStyle(fab).display !== 'none',
      footButtons: foot !== null ? foot.querySelectorAll('button').length : -1,
    }
  }`

  // --- 步骤 0：确认三态实例（footButtons > 1）---
  const s0 = await waitFor('初始 FAB 态', `() => {
    const r = (${state})()
    if (r.ok && r.collapsed === true && r.furled === true && r.track1 === 0) return { ...r, ok: true }
    return { ok: false, ...r }
  }`)
  check(s0.footButtons > 1, '本实例为三态模式（竖条底部有插件按钮）', `footButtons=${s0.footButtons}`)
  if (s0.footButtons <= 1) {
    console.log('info 该实例是两态模式，本用例只覆盖三态；请在 3081 上运行')
    process.exit(0)
  }

  /** 一轮完整三态循环：FAB → 竖条 → 点外部 → 等 1s → 读态。
   *  注意不能"等 FAB 出现再断言"：旧代码的弹回发生在 ≤500ms 内，
   *  200ms 轮询根本拍不到瞬态的 FAB——所以点外部后先等 tick 作案，
   *  再读最终状态：furled=true = 收起站住了；furled=false = 被弹回。 */
  async function oneCycle(tag) {
    await evalJson(`(function(){
      document.querySelector('[data-meow-smooth-fab]').click()
      return JSON.stringify({ ok: true })
    })()`)
    const rail = await waitFor(`${tag} 点FAB出竖条`, `() => {
      const r = (${state})()
      if (r.ok && r.collapsed === true && r.furled === false && r.track1 === 56) return { ...r, ok: true }
      return { ok: false, collapsed: r.collapsed, furled: r.furled, track1: r.track1 }
    }`)
    await evalJson(`(function(){
      const conv = document.querySelector('[data-slot="conversation"]') ?? document.body
      conv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }))
      return JSON.stringify({ ok: true })
    })()`)
    await sleep(1000) // ≥1 个 500ms tick：弹回（若有）必然已发生
    const after = await evalJson(`(function(){
      const r = (${state})()
      return JSON.stringify({ furled: r.furled, track1: r.track1, fabVisible: r.fabVisible, collapsed: r.collapsed })
    })()`)
    return { rail, after }
  }

  // --- 步骤 1：第一轮循环到位 ---
  const c1 = await oneCycle('①')
  check(c1.rail.ok === true, '三态循环①：点FAB唤出竖条', `collapsed=${c1.rail.collapsed} track1=${c1.rail.track1}`)
  check(c1.after.furled === true && c1.after.fabVisible === true,
    '点外部收起后竖条不弹回（小方块站住）',
    `furled=${c1.after.furled} track1=${c1.after.track1}${c1.after.furled === false ? ' — 收起被 500ms tick 撤销（弹回复现）' : ''}`)

  // --- 步骤 2（关键）：折回后采样 2.5s，furled 必须保持 ---
  const samples = []
  for (let i = 0; i < 10; i++) {
    const s = await evalJson(`(function(){
      const r = (${state})()
      return JSON.stringify({ furled: r.furled, track1: r.track1, fabVisible: r.fabVisible })
    })()`)
    samples.push(s)
    await sleep(250)
  }
  const pops = samples.filter((s, i) => i > 0 && (s.furled !== samples[i - 1].furled || s.fabVisible !== samples[i - 1].fabVisible))
  check(samples.every(s => s.furled === true && s.fabVisible === true),
    '折回后 2.5s 内小方块稳定不被弹回（旧代码 ≤500ms 即被 tick 强制解除）',
    `翻转 ${pops.length} 次${pops.length > 0 ? ' — 首次翻转后状态 ' + JSON.stringify(samples.find(s => s.furled === false) ?? samples[1]) : ''}`)

  // --- 步骤 3：第二轮循环 + 再采样（稳定性）---
  const c2 = await oneCycle('②')
  check(c2.rail.ok === true, '三态循环②：点FAB唤出竖条', '')
  check(c2.after.furled === true && c2.after.fabVisible === true, '三态循环②：点外部收起后不弹回', `furled=${c2.after.furled}`)
  const tail = []
  for (let i = 0; i < 6; i++) {
    const s = await evalJson(`(function(){
      const r = (${state})()
      return JSON.stringify({ furled: r.furled, fabVisible: r.fabVisible })
    })()`)
    tail.push(s)
    await sleep(250)
  }
  check(tail.every(s => s.furled === true && s.fabVisible === true), '循环②折回后 1.5s 仍稳定', '')

  if (failed > 0) process.exitCode = 1
  else console.log('\n全部断言 PASS')
} catch (error) {
  console.log(`FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
