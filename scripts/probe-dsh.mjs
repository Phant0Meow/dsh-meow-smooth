// probe-dsh.mjs — 探测 dsh 页面 DOM 锚点（会话行/侧边栏/路由），
// 供 e2e 脚本定位选择器；顺带清理遗留 pending（面板取消按钮）。
// 用法：node scripts/probe-dsh.mjs [url]
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9335
const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const PROFILE = join(tmpdir(), `meow-smooth-probe-${Date.now()}`)

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
await sleep(9000)
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

// 清理遗留 pending（若官方面板重放显示，点取消）。
const cleaned = await evalJs(`(() => {
  const panel = document.querySelector('[data-question-key], [data-plan-review-key], [data-approval-key]')
  if (!panel) return 'no-panel'
  const cancel = [...panel.querySelectorAll('button')].find(b => /取消/.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? ''))
  if (!cancel) return 'panel-no-cancel'
  cancel.click()
  return 'cancelled'
})()`)
console.log('cleanup=', cleaned)

const info = await evalJs(`(() => {
  const sidebar = document.querySelector('[data-slot="sidebar"]')
  const rows = sidebar ? [...sidebar.querySelectorAll('*')].filter(el => {
    const t = (el.textContent ?? '').trim()
    return el.children.length === 0 && t.length > 0 && t.length < 40 && el.closest('button, [role="treeitem"], [role="option"], a, [data-testid]')
  }).map(el => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 40), text: (el.textContent ?? '').trim().slice(0, 30), role: el.getAttribute('role'), tid: el.getAttribute('data-testid') })) : []
  return {
    href: location.href,
    hash: location.hash,
    hasComposer: !!document.querySelector('[data-composer-card] textarea'),
    currentTitle: document.querySelector('[data-slot="conversation.header"] [data-slot="conversation.header.title"]')?.textContent ?? '',
    sidebarRows: rows.slice(0, 20),
    buttons: [...document.querySelectorAll('[data-slot="sidebar"] button')].slice(0, 15).map(b => ({
      text: (b.textContent ?? '').trim().slice(0, 24),
      aria: b.getAttribute('aria-label'),
      tid: b.getAttribute('data-testid'),
      cls: (b.className || '').toString().slice(0, 30),
    })),
  }
})()`)
console.log(JSON.stringify(info, null, 2))
ws.close()
edge.kill()
process.exit(0)
