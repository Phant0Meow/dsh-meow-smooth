// cleanup-pending.mjs — 清理 3080 遗留挂起提问（e2e 污染的会话 agent）。
// 桌面宽度（侧边栏展开）→ 逐会话点"放弃整组问题"→ 直到 /pending 空。
// 用法：node scripts/cleanup-pending.mjs [url]
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9337
const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const PENDING = `${URL}/plugins/meow-smooth/pending`
const PROFILE = join(tmpdir(), `meow-smooth-cleanup-${Date.now()}`)

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,800', 'about:blank',
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
await send('Page.navigate', { url: URL })
await sleep(10000)
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value
const hostPending = async () => {
  const res = await fetch(PENDING, { cache: 'no-store' })
  return res.ok ? res.json() : null
}

let rounds = 0
while (rounds < 10) {
  const data = await hostPending()
  const qs = data?.questions ?? []
  const as = data?.approvals ?? []
  if (qs.length === 0 && as.length === 0) break
  const action = await evalJs(`(() => {
    const panel = document.querySelector('[data-question-key], [data-plan-review-key], [data-approval-key]')
    if (panel) {
      const dismiss = [...panel.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? '').includes('放弃整组问题'))
      if (dismiss) { dismiss.click(); return 'dismissed' }
      const cancel = [...panel.querySelectorAll('button')].find(b => /取消/.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? ''))
      if (cancel) { cancel.click(); return 'cancelled' }
      const opt = panel.querySelector('button[role="radio"], button[role="checkbox"]')
      if (opt) { opt.click(); return 'option-clicked' }
      return 'panel-idle'
    }
    // 无面板：侧边栏找"等待回答"行（桌面宽度展开态）。
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    const node = sidebar ? [...sidebar.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent ?? '').includes('等待回答')) : null
    if (!node) return 'no-row'
    const row = node.closest('[role="treeitem"], [role="option"], li, button, a') ?? node.parentElement?.parentElement
    row?.click()
    return 'row-clicked'
  })()`)
  console.log('round=', rounds, 'qs=', qs.length, 'as=', as.length, 'action=', action)
  if (action === 'no-row') { console.log('cannot find pending row'); break }
  await sleep(4000)
  rounds += 1
}
const final = await hostPending()
console.log('finalPending=', JSON.stringify(final))
ws.close()
edge.kill()
process.exit(final && final.questions.length === 0 && final.approvals.length === 0 ? 0 : 1)
