// e2e-zoomtest.mjs — 电脑端缩放拦截（需求 15）验证脚本。
// 验证项：
//  1. 页面加载后插件注入正常、无 JS 异常、无提示条残留；
//  2. 拦截层：Ctrl+滚轮（wheel ctrlKey）与 Ctrl+±/0（keydown）被
//     preventDefault；普通滚轮与普通按键、其他 Ctrl 组合不受影响。
// 用法：node scripts/e2e-zoomtest.mjs [url]（默认 http://127.0.0.1:3080）
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const PROFILE = join(tmpdir(), 'meow-smooth-zoomtest-profile')

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
const events = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m)
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(9000) // SPA 装载 + 插件 apply

const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value

// 1. 注入检查：CSS 在、无 zoomtoast 残留（提示层已移除）。
const cssInjected = await evalJs(`!!document.querySelector('style[data-meow-fold-css]')`)
const noToastCss = await evalJs(`![...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.cssText.includes('meow-smooth-zoomtoast')) } catch { return false } })`)
const noToastEl = await evalJs(`document.querySelector('[data-meow-smooth-zoomtoast]') === null`)

// 2. 拦截层：派发合成事件看 defaultPrevented。
//    注意：capture 监听器在 document，dispatch 到 body 会先经过 document capture。
const results = await evalJs(`(function () {
  const body = document.body
  const fire = (type, init) => {
    const ev = new (type === 'wheel' ? WheelEvent : KeyboardEvent)(type, { cancelable: true, bubbles: true, ...init })
    body.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  return {
    wheelCtrl: fire('wheel', { ctrlKey: true }),
    wheelPlain: fire('wheel', {}),
    keyCtrlPlus: fire('keydown', { ctrlKey: true, code: 'Equal', key: '+' }),
    keyCtrlMinus: fire('keydown', { ctrlKey: true, code: 'Minus', key: '-' }),
    keyCtrlZero: fire('keydown', { ctrlKey: true, code: 'Digit0', key: '0' }),
    keyMetaPlus: fire('keydown', { metaKey: true, code: 'Equal', key: '+' }),
    keyCtrlK: fire('keydown', { ctrlKey: true, code: 'KeyK', key: 'k' }),
    keyPlain: fire('keydown', { code: 'Enter', key: 'Enter' }),
  }
})()`)

const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').length
const consoleErrors = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))

console.log('url=', URL)
console.log('cssInjected=', cssInjected)
console.log('noToastCss=', noToastCss, 'noToastEl=', noToastEl)
console.log('intercept=', JSON.stringify(results))
console.log('jsExceptions=', exceptions)
console.log('consoleErrors=', consoleErrors.length ? consoleErrors.slice(0, 5) : 'none')

const pass = cssInjected && noToastCss && noToastEl
  && results.wheelCtrl === true && results.wheelPlain === false
  && results.keyCtrlPlus === true && results.keyCtrlMinus === true && results.keyCtrlZero === true
  && results.keyMetaPlus === true
  && results.keyCtrlK === false && results.keyPlain === false
  && exceptions === 0
console.log(pass ? 'E2E PASS' : 'E2E FAIL')
ws.close()
edge.kill()
process.exit(pass ? 0 : 1)
