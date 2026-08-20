// diag-jump.mjs — 诊断"点横幅跳转"后状态（利用遗留 pending，无需 AI）。
// 用法：node scripts/diag-jump.mjs [url]
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9336
const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const PROFILE = join(tmpdir(), `meow-smooth-diag-${Date.now()}`)

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let list = null
for (let i = 0; i < 40; i += 1) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break } catch { await sleep(250) }
}
if (list === null) { console.log('FAIL: CDP not up'); edge.kill(); process.exit(1) }
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(10000)
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

const dump = async (tag) => {
  const s = await evalJs(`(() => {
    const bar = document.querySelector('[data-meow-smooth-pending]')
    const panel = document.querySelector('[data-question-key], [data-plan-review-key], [data-approval-key]')
    const sidebarTexts = [...document.querySelectorAll('[data-slot="sidebar"] *')]
      .filter(el => el.children.length === 0 && (el.textContent ?? '').trim().length > 0 && (el.textContent ?? '').trim().length < 30)
      .map(el => el.textContent.trim()).slice(0, 25)
    return {
      barVisible: bar?.getAttribute('data-visible') ?? null,
      barMode: bar?.getAttribute('data-mode') ?? null,
      barText: bar?.querySelector('.text')?.textContent ?? '',
      barDetail: bar?.querySelector('.detail')?.textContent ?? '',
      panel: panel ? (panel.getAttribute('data-question-key') ?? panel.getAttribute('data-plan-review-key') ?? panel.getAttribute('data-approval-key')) : null,
      sidebarTexts,
    }
  })()`)
  console.log(`--- ${tag} ---`)
  console.log(JSON.stringify(s, null, 1))
}
await dump('initial')
const clicked = await evalJs(`(() => {
  const row = document.querySelector('[data-meow-smooth-pending] .row')
  if (!row) return false
  row.click()
  return true
})()`)
console.log('rowClicked=', clicked)
await sleep(6000)
await dump('after-jump-6s')
await sleep(6000)
await dump('after-jump-12s')
ws.close()
edge.kill()
process.exit(0)
