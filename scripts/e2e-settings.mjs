// e2e-settings.mjs — 手机端设置页改造（需求 16）验证脚本。
// 验证项（375px 手机态）：
//  1. 设置浮层全窗口显示（面板 rect = viewport，无空隙）；
//  2. 边栏收成 56px 图标竖列（宽度与主界面 rail 一致，标签隐藏）；
//  3. 点边栏图标 → 不切标签页（aria-current 不动），边栏滑出到 188px；
//  4. 展开态点边栏按钮 → 正常切换标签页；
//  5. 展开态点右侧空白 → 边栏收回 56px，不切页；
//  6. 桌面 1280px：无属性注入、面板 800px、点边栏立即切页、点空白不收。
// 用法：node scripts/e2e-settings.mjs [url]（默认 http://127.0.0.1:3081）
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const URL = process.argv[2] ?? 'http://127.0.0.1:3081'
const PROFILE = join(tmpdir(), 'meow-smooth-settings-test-profile')
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'shots')
mkdirSync(SHOTS, { recursive: true })

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
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

await send('Page.enable')
await send('Runtime.enable')

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// 轮询等待表达式为真值，返回其值；超时返回 null。
const waitFor = async (expr, timeout = 15000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = await evalJs(expr)
    if (v) return v
    await sleep(200)
  }
  return null
}

// ---------- 手机态 375x812 ----------
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: URL })
await sleep(9000) // SPA 装载 + 插件 apply

const TRIGGER = `[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]`
const PANEL = `div[role="dialog"] > nav`
const NAV = `div[role="dialog"] > nav`
const getNav = `(function(){ const n = document.querySelector('${NAV}'); return n ? n.parentElement : null })()`

check('插件注入（settings CSS style）', (await evalJs(`!!document.querySelector('style[data-meow-settings-css]')`)) === true)
const trigger = await waitFor(`!!document.querySelector('${TRIGGER}')`)
if (!trigger) { console.log('FAIL: settings trigger not found'); ws.close(); edge.kill(); process.exit(1) }
await evalJs(`document.querySelector('${TRIGGER}').click()`)
const panelOpen = await waitFor(`!!document.querySelector('${NAV}')`)
check('设置面板打开（dialog>nav 挂载）', panelOpen === true)

const m1 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  const btn = nav.querySelector('button')
  const label = btn.querySelector('span')
  const r = panel.getBoundingClientRect()
  const cs = (el, pseudo) => getComputedStyle(el, pseudo)
  const after = cs(nav, '::after')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    panelW: Math.round(r.width), panelH: Math.round(r.height),
    vw: window.innerWidth, vh: window.innerHeight,
    navW: cs(nav).width, navPad: cs(nav).padding,
    btnW: cs(btn).width, btnH: cs(btn).height, btnRadius: cs(btn).borderRadius,
    labelMaxW: cs(label).maxWidth, labelOpacity: cs(label).opacity,
    firstCurrent: nav.querySelectorAll('button')[0].getAttribute('aria-current'),
    dividerContent: after.content, dividerBg: after.backgroundColor,
  }
})()`)
console.log('mobile-state-1 =', JSON.stringify(m1))
check('1. 面板全窗口（无空隙）', m1.panelW === m1.vw && m1.panelH === m1.vh)
check('2. 默认收起态', m1.attr === 'collapsed')
check('2. 边栏 56px（主界面 rail 宽度）', m1.navW === '56px')
check('2. 按钮 36px 圆钮', m1.btnW === '36px' && m1.btnH === '36px' && m1.btnRadius === '50%')
check('2. 标签隐藏（max-width 0 + opacity 0）', m1.labelMaxW === '0px' && m1.labelOpacity === '0')
check('2. 初始激活项 = 第 1 个', m1.firstCurrent === 'true')
check('2. 右侧 1px 边线存在', m1.dividerBg !== 'rgba(0, 0, 0, 0)' && m1.dividerBg !== 'transparent')

await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  writeFileSync(join(SHOTS, 'settings-mobile-collapsed.png'), Buffer.from(r.data, 'base64'))
})

// 收起态点边栏背景（nav 元素自身 = padding/空白区）：只展开，不切页。
await evalJs(`(function(){
  const nav = document.querySelector('${NAV}')
  nav.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})()`)
await sleep(350) // 220ms 过渡
const m2 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    navW: getComputedStyle(nav).width,
    firstCurrent: nav.querySelectorAll('button')[0].getAttribute('aria-current'),
    labelOpacity: getComputedStyle(nav.querySelectorAll('button')[1].querySelector('span')).opacity,
  }
})()`)
console.log('mobile-state-2 =', JSON.stringify(m2))
check('4. 点背景 → 展开态', m2.attr === 'expanded')
check('4. 边栏滑出到 188px', m2.navW === '188px')
check('4. 标签重新显示', m2.labelOpacity === '1')
check('4. 不切换标签页（激活仍在第 1 个）', m2.firstCurrent === 'true')

await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  writeFileSync(join(SHOTS, 'settings-mobile-expanded.png'), Buffer.from(r.data, 'base64'))
})

// 展开态再点第 2 个按钮：正常切换标签页。
await evalJs(`document.querySelectorAll('${NAV} button')[1].click()`)
await sleep(200)
const m3 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    secondCurrent: nav.querySelectorAll('button')[1].getAttribute('aria-current'),
  }
})()`)
console.log('mobile-state-3 =', JSON.stringify(m3))
check('5. 展开态点按钮 → 切换标签页', m3.secondCurrent === 'true')
check('5. 切换后保持展开态', m3.attr === 'expanded')

// 展开态点右侧空白（header 区域，非交互元素）：收回，不切页。
await evalJs(`(function(){
  const panel = ${getNav}
  const header = panel.querySelector(':scope > div:last-child > div:first-child')
  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})()`)
await sleep(350)
const m4 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    navW: getComputedStyle(nav).width,
    secondCurrent: nav.querySelectorAll('button')[1].getAttribute('aria-current'),
  }
})()`)
console.log('mobile-state-4 =', JSON.stringify(m4))
check('6. 点右侧空白 → 收回 56px', m4.attr === 'collapsed' && m4.navW === '56px')
check('6. 收回不切页（激活仍在第 2 个）', m4.secondCurrent === 'true')

// 收起态点第 1 个按钮（图标点击回归）：只展开，不切页。
await evalJs(`document.querySelectorAll('${NAV} button')[0].click()`)
await sleep(350)
const m5 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    navW: getComputedStyle(nav).width,
    firstCurrent: nav.querySelectorAll('button')[0].getAttribute('aria-current'),
    secondCurrent: nav.querySelectorAll('button')[1].getAttribute('aria-current'),
  }
})()`)
console.log('mobile-state-5 =', JSON.stringify(m5))
check('4b. 点图标（回归）→ 展开态且不切页（激活仍在第 2 个）', m5.attr === 'expanded' && m5.navW === '188px' && m5.firstCurrent === null && m5.secondCurrent === 'true')

// ---------- 桌面 1280x800：官方原样 ----------
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await sleep(400)
const d1 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    navW: getComputedStyle(nav).width,
    panelW: Math.round(panel.getBoundingClientRect().width),
    firstCurrent: nav.querySelectorAll('button')[0].getAttribute('aria-current'),
  }
})()`)
console.log('desktop-state-1 =', JSON.stringify(d1))
check('桌面：无属性注入（官方原样）', d1.attr === null)
check('桌面：边栏保持 188px', d1.navW === '188px')
check('桌面：面板保持 800px 居中浮层', d1.panelW === 800)

// 桌面点第 1 个按钮：立即切换（无拦截）。
await evalJs(`document.querySelectorAll('${NAV} button')[0].click()`)
await sleep(200)
const d2 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return {
    attr: panel.getAttribute('data-meow-smooth-settings'),
    firstCurrent: nav.querySelectorAll('button')[0].getAttribute('aria-current'),
  }
})()`)
console.log('desktop-state-2 =', JSON.stringify(d2))
check('桌面：点边栏按钮立即切页', d2.firstCurrent === 'true' && d2.attr === null)

// 桌面点右侧空白：不产生任何状态变化。
await evalJs(`(function(){
  const panel = ${getNav}
  const header = panel.querySelector(':scope > div:last-child > div:first-child')
  header.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})()`)
await sleep(300)
const d3 = await evalJs(`(function(){
  const panel = ${getNav}
  const nav = document.querySelector('${NAV}')
  return { attr: panel.getAttribute('data-meow-smooth-settings'), navW: getComputedStyle(nav).width }
})()`)
console.log('desktop-state-3 =', JSON.stringify(d3))
check('桌面：点空白无收边栏行为', d3.attr === null && d3.navW === '188px')

const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').length
const consoleErrors = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
check('无 JS 异常', exceptions === 0)
check('无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

console.log('url=', URL)
console.log('screenshots=', join(SHOTS, 'settings-mobile-{collapsed,expanded}.png'))
console.log(failures.length === 0 ? 'E2E PASS' : `E2E FAIL (${failures.length}): ${failures.join('; ')}`)
ws.close()
edge.kill()
process.exit(failures.length === 0 ? 0 : 1)
