/**
 * 探针：手机端输入框（textarea/composer）竖划滚动复现。
 *
 * 猫猫报：输入框上下滑动突然动不了（之前是好的）。输入框在轴仲裁里是
 * 豁免区（textarea/composer 卡片起手 → move 早退放行原生），理论上不受
 * 全局化影响——本探针 headless 复现：灌 40 行草稿 → 合成触摸竖划 textarea
 * → 观测 [data-input-scroll] 窗口/textarea 的 scrollTop 变化 + 事件
 * cancelable + preventDefault 调用。
 *
 * 运行：node scripts/probe-composer-swipe.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9391
const profile = join(process.env.TEMP ?? '.', `meow-composer-swipe-${Date.now()}`)
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 25000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails).slice(0, 400)}`)
  if (typeof res.result?.value !== 'string') throw new Error(`非字符串: ${JSON.stringify(res.result).slice(0, 200)}`)
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
  throw new Error(`等待超时: ${label} — ${JSON.stringify(last)}`)
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
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 2, mobile: true })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame', `() => document.querySelector('[data-slot="root"] > *') !== null ? {ok:true} : {ok:false}`, 30000)
  await sleep(1200)

  // 灌 40 行草稿（React 受控绕行）
  const draft = await evalJson(`(function(){
    const ta = document.querySelector('[data-composer-card] textarea')
    if (ta === null) return JSON.stringify({ ok: false, why: 'no textarea' })
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const lines = []
    for (let i = 0; i < 40; i++) lines.push('第' + i + '行草稿内容 some content to make it tall')
    setter.call(ta, lines.join('\\n'))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return JSON.stringify({ ok: true })
  })()`)
  console.log(`灌草稿: ${JSON.stringify(draft)}`)
  await sleep(800)

  // 展开输入框（点卡片，composer-reveal 同款瞬时展开）
  await evalJson(`(() => {
    const card = document.querySelector('[data-composer-card]')
    const ta = card?.querySelector('textarea')
    if (card === null || ta === null) return JSON.stringify({ ok: false, why: 'no textarea' })
    const r = ta.getBoundingClientRect()
    const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: r.left + 30, clientY: Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1) })
    ta.dispatchEvent(pd)
    ta.focus()
    return JSON.stringify({ ok: document.activeElement === ta })
  })()`)
  await sleep(700)

  // 状态快照：滚动窗/textarea 几何 + pd hook
  const state = await evalJson(`(() => {
    if (window.__pdHooked !== true) {
      window.__pdHooked = true
      window.__pdCount = 0
      window.__pdStacks = []
      const orig = Event.prototype.preventDefault
      Event.prototype.preventDefault = function () {
        if (this.type === 'touchmove') {
          window.__pdCount++
          if (window.__pdStacks.length < 8) window.__pdStacks.push(String(new Error().stack || '').split('\\n').slice(1, 3).join(' <= '))
        }
        return orig.apply(this, arguments)
      }
    }
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    const ta = document.querySelector('[data-composer-card] textarea')
    const cs = scroll ? getComputedStyle(scroll) : null
    return JSON.stringify({
      ok: true,
      scroll: scroll ? { oy: cs.overflowY, sh: scroll.scrollHeight, ch: scroll.clientHeight, st: scroll.scrollTop, rect: (r => ({ y: Math.round(r.y), h: Math.round(r.height) }))(scroll.getBoundingClientRect()) } : null,
      ta: ta ? { sh: ta.scrollHeight, ch: ta.clientHeight, st: ta.scrollTop, rect: (r => ({ y: Math.round(r.y), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }))(ta.getBoundingClientRect()) } : null,
      active: document.activeElement?.tagName ?? 'null',
    })
  })()`)
  console.log(`状态: ${JSON.stringify(state)}`)

  // 合成竖划：双向（起点=滚动窗中部，上下都有余量）
  const mid = await evalJson(`(() => {
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) / 2)
    const ta = document.querySelector('[data-composer-card] textarea')
    const taTop = Math.max(ta.getBoundingClientRect().top, 60)
    const taBottom = Math.min(ta.getBoundingClientRect().bottom, 820)
    return JSON.stringify({ ok: true, st: Math.round(scroll.scrollTop), y: Math.round((taTop + taBottom) / 2) })
  })()`)
  console.log(`滚动窗拨到中部: st=${mid.st}，触点 y=${mid.y}`)
  const doSwipe = async (dir, label) => {
    await evalJson(`(() => { window.__pdCount = 0; return JSON.stringify({ok:true}) })()`)
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: mid.y }] })
    for (let i = 1; i <= 8; i++) {
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: mid.y + dir * i * 18 }] })
      await sleep(16)
    }
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(500)
    const after = await evalJson(`(() => {
      const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
      const ta = document.querySelector('[data-composer-card] textarea')
      return JSON.stringify({
        ok: true,
        scrollSt: scroll?.scrollTop ?? null,
        taSt: ta?.scrollTop ?? null,
        pd: window.__pdCount,
        stacks: window.__pdStacks?.slice(-2) ?? [],
      })
    })()`)
    console.log(`${label}: scrollSt=${after.scrollSt} taSt=${after.taSt} pd=${after.pd}${after.stacks.length > 0 ? ' stacks=' + JSON.stringify(after.stacks) : ''}`)
    return after
  }
  const up = await doSwipe(-1, '上滑(看下方)')
  await evalJson(`(() => {
    const scroll = document.querySelector('[data-composer-card] [data-input-scroll]')
    scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) / 2)
    return JSON.stringify({ ok: true })
  })()`)
  const down = await doSwipe(1, '下滑(看上方)')
  const moved = Math.abs(up.scrollSt - mid.st) > 2 || Math.abs(down.scrollSt - mid.st) > 2
  console.log(moved ? 'RESULT PASS（输入框滚动了）' : 'RESULT FAIL（双向都不滚）')
} catch (error) {
  console.log('FAIL', error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error))
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  await sleep(300)
}
