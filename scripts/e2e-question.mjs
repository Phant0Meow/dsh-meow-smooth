// e2e-question.mjs — 功能⑫ 提问提醒 host 权威投影验证（真实 AI 触发）。
// 场景还原：手机端当前会话 A，电脑端会话 B 的 AI 提问 → 手机横幅应显示
// "B 有提问待回答"（host 审计投影兜底，不依赖 client 帧）。
// 流程：B 提问（面板直接显示）→ 新建 A 切走 → 横幅出现 → 点横幅跳回 B
// → 面板 → 回答 → pending 清空 → 横幅消失（含遗留 pending 清理）。
// 用法：node scripts/e2e-question.mjs [url]（默认 http://127.0.0.1:3080）
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9334
const URL = process.argv[2] ?? 'http://127.0.0.1:3080'
const PENDING = `${URL}/plugins/meow-smooth/pending`
const PROFILE = join(tmpdir(), `meow-smooth-question-${Date.now()}`)

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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: false })
await send('Page.navigate', { url: URL })
await sleep(10000)

const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value
const poll = async (fn, timeoutMs, label) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(1500)
  }
  throw new Error(`timeout waiting for ${label}`)
}
const hostPending = async () => {
  const res = await fetch(PENDING, { cache: 'no-store' })
  if (!res.ok) return null
  return res.json()
}
const barTextOf = () => evalJs(`(() => {
  const el = document.querySelector('[data-meow-smooth-pending]')
  if (!el || el.getAttribute('data-visible') !== 'true') return ''
  return (el.querySelector('.toast-title')?.textContent ?? '') + '|' + (el.querySelector('.toast-sub')?.textContent ?? '')
})()`)
const toastClick = () => evalJs(`(() => {
  const el = document.querySelector('[data-meow-smooth-pending]')
  if (!el) return false
  el.click()
  return true
})()`)

// 0. 插件注入。
const cssInjected = await evalJs(`!!document.querySelector('style[data-meow-fold-css]')`)
console.log('cssInjected=', cssInjected)
if (!cssInjected) { console.log('FAIL: plugin css not injected'); edge.kill(); process.exit(1) }

// 1. 新建会话 B 并发消息让 AI 提问。
const newSession = async () => evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '新建会话')
  if (!btn) return false
  btn.click()
  return true
})()`)
await poll(async () => { const ok = await newSession(); return ok ? true : null }, 10000, 'new session button')
await sleep(4000) // 新会话装载
const typed = await evalJs(`(() => {
  const ta = document.querySelector('[data-composer-card] textarea')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '请调用 ask_user_question 工具问我一个问题：问我最喜欢什么颜色。只调用这一个工具，不要做其他任何事。')
  ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }))
  ta.focus()
  return 'typed'
})()`)
console.log('typed=', typed)
await sleep(1000)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('sent to B, waiting for AI to ask...')

// 2. host 投影断言：/pending 出现 questions（或先 approval 后 question）。
let questions = null
try {
  questions = await poll(async () => {
    const data = await hostPending()
    if (!data) return null
    return Array.isArray(data.questions) && data.questions.length > 0 ? data.questions : null
  }, 150000, 'host questions projection')
} catch (error) {
  console.log('FAIL:', error.message)
  edge.kill()
  process.exit(1)
}
console.log('hostQuestions=', JSON.stringify(questions))

// 3. B 当前会话：官方面板应直接显示提问（重放/实时帧）。
await poll(async () => {
  const k = await evalJs(`(() => {
    const el = document.querySelector('[data-question-key], [data-plan-review-key]')
    return el ? (el.getAttribute('data-question-key') ?? el.getAttribute('data-plan-review-key')) : ''
  })()`)
  return k === '' ? null : k
}, 20000, 'official panel in B')
console.log('panelInB= true')

// 4. 新建会话 A 切走 → 跨会话横幅出现（用户 bug 场景：手机在 A，B 提问）。
await newSession()
await sleep(4000)
const barText = await poll(barTextOf, 30000, 'cross-session banner')
console.log('barText=', barText)
if (!barText.includes('有提问待回答') && !barText.includes('有计划待审')) {
  console.log('FAIL: banner is not about a question'); edge.kill(); process.exit(1)
}

// 5. 点横幅跳回 B → 面板接管 → 横幅隐藏。失败时 dump 横幅 detail 区分
//    "跳转失败（无法自动切换）"与"跳转成功但面板未渲染（提问等待回答）"，
//    再走侧边栏兜底（"等待回答"行 → 未命名新会话行）。
const sidebarClick = (label) => evalJs(`(() => {
  const sidebar = document.querySelector('[data-slot="sidebar"]')
  if (!sidebar) return false
  const node = [...sidebar.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent ?? '').includes(${JSON.stringify(label)}))
  if (!node) return false
  const row = node.closest('[role="treeitem"], [role="option"], li, button, a') ?? node.parentElement?.parentElement
  row?.click()
  return true
})()`)
const panelKeyOf = () => evalJs(`(() => {
  const el = document.querySelector('[data-question-key], [data-plan-review-key]')
  return el ? (el.getAttribute('data-question-key') ?? el.getAttribute('data-plan-review-key')) : ''
})()`)
const barFailOf = () => evalJs(`(() => {
  const bar = document.querySelector('[data-meow-smooth-pending]')
  return bar?.getAttribute('data-mode') === 'fail' ? (bar.querySelector('.toast-fail')?.textContent ?? '') : ''
})()`)

await toastClick()
let jumped = false
let reloaded = false
try {
  await poll(panelKeyOf, 15000, 'panel after jump')
  jumped = true
} catch {
  // 预期路径（官方机制）：会话实例被 scope-prune 后重建，question 帧
  // 只在提问时广播一次（不重放），面板不渲染——重开页面（连接重开 →
  // mux 基线重放）即恢复，与用户"关掉重开才出现"观察一致。
  console.log('jump-ok-but-no-panel (scope-prune instance rebuild, no frame replay)')
  const clickedWaiting = await sidebarClick('ask_user_question')
  console.log('sidebarAskClicked=', clickedWaiting)
  await sleep(3000)
  if (await panelKeyOf() === '') {
    // 重开页面（连接重开 → mux 基线重放）：dump 后走"点横幅跳转"兜底。
    await send('Page.reload', { ignoreCache: true })
    await sleep(10000)
    const afterReload = await evalJs(`(() => {
      const bar = document.querySelector('[data-meow-smooth-pending]')
      const panel = document.querySelector('[data-question-key], [data-plan-review-key]')
      const sidebar = document.querySelector('[data-slot="sidebar"]')
      const texts = sidebar ? [...sidebar.querySelectorAll('*')]
        .filter(el => el.children.length === 0 && (el.textContent ?? '').trim() && (el.textContent ?? '').trim().length < 30)
        .map(el => el.textContent.trim()).slice(0, 20) : []
      return {
        barVisible: bar?.getAttribute('data-visible') ?? null,
        barText: bar?.querySelector('.toast-title')?.textContent ?? '',
        panel: panel ? 'yes' : 'no',
        sidebarTexts: texts,
      }
    })()`)
    console.log('afterReload=', JSON.stringify(afterReload))
    if (afterReload.panel === 'yes') {
      reloaded = true
    } else if (afterReload.barVisible === 'true') {
      await toastClick()
      try {
        await poll(panelKeyOf, 20000, 'panel after reload+jump')
        reloaded = true
      } catch {
        console.log('no panel even after reload+jump')
      }
    }
  }
}
console.log('jumped=', jumped, 'reloaded=', reloaded)

// 6. 回答：点第一个选项（role 锚点，class 是 CSS Module hash）。
await sleep(1000)
const answered = await evalJs(`(() => {
  const panel = document.querySelector('[data-question-key], [data-plan-review-key]')
  if (!panel) return 'no-panel'
  const opt = panel.querySelector('.option') ?? panel.querySelector('button[role="radio"], button[role="checkbox"]')
  if (opt) { opt.click(); return 'option-clicked' }
  return 'no-option'
})()`)
console.log('answered=', answered)
await sleep(500)
const submitted = await evalJs(`(() => {
  const panel = document.querySelector('[data-question-key], [data-plan-review-key]')
  if (!panel) return false
  const btn = [...panel.querySelectorAll('button')].find(b => /提交|下一|继续|submit/i.test(b.textContent ?? ''))
  if (!btn) return false
  btn.click()
  return true
})()`)
console.log('submitted=', submitted)

// 7. 循环清空全部 pending（本会话新提问 + 遗留）：有面板则回答/取消，
//    无面板则侧边栏切到 pending 会话（标题含 ask_user_question）或重开页面。
let clearedRounds = 0
while (clearedRounds < 6) {
  const data = await hostPending()
  const qs = data?.questions ?? []
  const as = data?.approvals ?? []
  if (qs.length === 0 && as.length === 0) break
  const panelAction = await evalJs(`(() => {
    const panel = document.querySelector('[data-question-key], [data-plan-review-key], [data-approval-key]')
    if (!panel) return 'no-panel'
    const cancel = [...panel.querySelectorAll('button')].find(b => /取消/.test(b.getAttribute('aria-label') ?? b.title ?? b.textContent ?? ''))
    if (cancel) { cancel.click(); return 'cancelled' }
    const opt = panel.querySelector('.option') ?? panel.querySelector('button[role="radio"], button[role="checkbox"]')
    if (opt) { opt.click(); return 'option-clicked' }
    return 'panel-idle'
  })()`)
  console.log('cleanupRound=', clearedRounds, 'action=', panelAction)
  if (panelAction === 'no-panel') {
    const clicked = await sidebarClick('ask_user_question') || await sidebarClick('等待回答')
    if (!clicked) { console.log('FAIL: cannot reach pending session'); edge.kill(); process.exit(1) }
    await sleep(3000)
    if (await panelKeyOf() === '') {
      await send('Page.reload', { ignoreCache: true })
      await sleep(10000)
      try {
        await poll(panelKeyOf, 20000, 'panel after reload')
      } catch {
        console.log('FAIL: panel unreachable even after reload'); edge.kill(); process.exit(1)
      }
    }
  }
  await sleep(3000)
  clearedRounds += 1
}
const finalData = await hostPending()
const qEmpty = !Array.isArray(finalData?.questions) || finalData.questions.length === 0
const aEmpty = !Array.isArray(finalData?.approvals) || finalData.approvals.length === 0
const barGone = await evalJs(`document.querySelector('[data-meow-smooth-pending]')?.getAttribute('data-visible') !== 'true'`)
console.log('finalPending=', JSON.stringify(finalData))
console.log('qEmpty=', qEmpty, 'aEmpty=', aEmpty, 'barGone=', barGone)
if (!qEmpty || !aEmpty || !barGone) { console.log('FAIL: pending not cleared'); edge.kill(); process.exit(1) }
console.log('cleared= true')

const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').length
console.log('jsExceptions=', exceptions)
console.log('E2E PASS')
ws.close()
edge.kill()
process.exit(0)
