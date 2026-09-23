/**
 * e2e：手机端返回手势接管为边栏开关（需求㉑ v2，back-guard.ts）。裸 CDP
 * 驱动 headless Edge，零 npm 依赖（Node ≥22 全局 WebSocket），对**真实
 * 运行中的 dsh 实例**做手机仿真（390×844 触屏、pointer:coarse）。系统
 * 边缘手势本身无法在 headless 里模拟（浏览器壳级行为），但其页面侧后果
 * 就是 history.back()——接管逻辑在 popstate 通道工作，用程序化 back()
 * 等价驱动：
 *
 *  1. 安装：页面加载后 history.state 即哨兵标记（粗指针仿真下才装）；
 *  2. 返回开边栏：back()（初始 0 档 furl）→ 宽档展开 + 哨兵推回；
 *  3. 返回收边栏：back() → 收起到 0 档（furl 小方块复活）；
 *  4. 循环稳定性：back() 再次开边栏；
 *  5. 全程 URL 不变、栈深恒定、AppFrame 在场（页面永不因返回退出）。
 *
 * 运行：node scripts/e2e-backguard.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3080（须已装配 meow-smooth 本构建产物）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'

// 预检：实例必须可达且已装配本构建（含哨兵代码）。
const probe = await fetch(`${BASE}/plugins/meow-smooth/client.js`).catch(() => null)
if (probe === null || !probe.ok) {
  console.log(`FAIL ${BASE}/plugins/meow-smooth/client.js 不可达（${probe?.status ?? '网络错误'}）— 该实例未装配 meow-smooth？`)
  process.exit(1)
}
if (!(await probe.text()).includes('__meowSmoothSentry')) {
  console.log('FAIL 实例伺服的 client.js 不含哨兵代码（rev 滞后？）— 请重启实例或确认静态路由指向本构建 lib/')
  process.exit(1)
}

// --- 起 headless Edge（裸 CDP） ---
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9342 + Math.floor(Math.random() * 200)
const profile = join(process.env.TEMP ?? '.', `meow-smooth-backguard-e2e-${Date.now()}`)
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
  const tab = await created.json()
  return tab.webSocketDebuggerUrl
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

let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else {
    failed++
    console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
      if (text.includes('meow-smooth')) console.log(`CONSOLE> ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`PAGE-EXC> ${d.text} ${d.exception?.description?.split('\n')[0] ?? ''}`)
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
  // 手机仿真：视口 390×844 + 触屏（pointer:coarse 随之成立，接管才安装）。
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })

  // 等哨兵安装（本构建执行的标志）。rev 滞后时页面跑旧代码，哨兵永不出
  // 现——刷新重试几轮，仍不行则按超时失败。
  let installed = false
  for (let i = 0; i < 6 && !installed; i++) {
    const deadline = Date.now() + (i === 0 ? 30000 : 15000)
    while (Date.now() < deadline) {
      const r = await evalJson(`(function(){ try { return JSON.stringify({ sentry: history.state !== null && history.state.__meowSmoothSentry === true }) } catch (e) { return JSON.stringify({ sentry: false }) } })()`)
      if (r.sentry === true) { installed = true; break }
      await sleep(250)
    }
    if (!installed) {
      await call('Page.reload', {})
      await sleep(2000)
    }
  }
  check(installed, '哨兵已安装（history.state 为哨兵标记，粗指针仿真）')

  const snap = `() => JSON.stringify((() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    const cols = frame !== null ? getComputedStyle(frame).gridTemplateColumns.split(' ').map(s => parseFloat(s)) : []
    return {
      sentry: history.state !== null && history.state.__meowSmoothSentry === true,
      url: location.href,
      depth: history.length,
      frame: frame !== null,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true',
      collapsed: frame !== null && frame.hasAttribute('data-sidebar-collapsed'),
      track1: cols[0] ?? -1,
    }
  })())`
  const read = () => evalJson(`(function(){ try { return (${snap})() } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    .catch(err => JSON.stringify({ error: String(err.message ?? err) }))
  /** 页面已离开 dsh（跨文档导航后 CDP evaluate 不可靠）→ 抛出快速失败。 */
  const assertOnApp = (s) => {
    const url = typeof s.url === 'string' ? s.url : ''
    if (url !== '' && !url.includes('127.0.0.1')) throw new Error(`页面意外离开 dsh url=${url}`)
    return s
  }
  /** 一次 back() 后轮询到期望的边栏状态（官方 grid 过渡 ~300ms，连续两次
   *  读数稳定才算到位）。 */
  async function backAndWait(label, want, timeoutMs = 6000) {
    await evalJson(`(function(){ history.back(); return 'true' })()`)
    const deadline = Date.now() + timeoutMs
    let s = assertOnApp(await read())
    while (Date.now() < deadline) {
      if (s.sentry === true
        && (want.open ? (s.collapsed === false && s.track1 >= 264) : (s.collapsed === true && s.furled === true && s.track1 === 0))) {
        check(true, label, `track1=${Math.round(s.track1)} collapsed=${s.collapsed} furled=${s.furled}`)
        return s
      }
      await sleep(150)
      s = assertOnApp(await read())
    }
    check(false, label, `超时 — track1=${Math.round(s.track1)} collapsed=${s.collapsed} furled=${s.furled} sentry=${s.sentry}`)
    const tr = await evalJson(`(function(){ try { return JSON.stringify(window.__meowBackGuardTrace ?? []) } catch (e) { return '[]' } })()`)
    console.log(`  [trace:${label}] ${tr}`)
    const gt = await evalJson(`(function(){ try { return JSON.stringify({ loaded: document.documentElement.dataset.meowSmoothGestureLoaded ?? '', gtrace: window.__meowGestureTrace ?? [] }) } catch (e) { return '{}' } })()`)
    console.log(`  [gesture:${label}] ${gt}`)
    return s
  }

  // 等 AppFrame 挂载 + 初始基线（手机端默认 0 档 furl 小方块）。
  const deadlineFrame = Date.now() + 30000
  let s1 = assertOnApp(await read())
  while (Date.now() < deadlineFrame && !(s1.frame === true && s1.track1 >= 0)) {
    await sleep(200)
    s1 = assertOnApp(await read())
  }
  check(s1.frame === true, 'AppFrame 已挂载')
  check(s1.sentry === true, '安装后当前记录即哨兵（同 URL）', s1.url)
  check(s1.url?.replace(/\/$/, '') === BASE.replace(/\/$/, ''), 'URL 未被哨兵改变', s1.url)
  const depth0 = s1.depth

  // --- 断言 2：返回 → 开边栏（0 档 → 宽档） ---
  let s = await backAndWait('返回 → 边栏打开（宽档）', { open: true })
  check(s.url === s1.url, 'URL 不变', s.url)
  check(s.depth === depth0, '栈深恒定（无导航堆叠）', `depth=${depth0}→${s.depth}`)

  // --- 断言 3：再返回 → 收边栏（→ 0 档） ---
  s = await backAndWait('返回 → 边栏收起（0 档小方块）', { open: false })
  check(s.url === s1.url, '仍未离开页面', s.url)

  // --- 断言 4：再返回 → 再开（循环稳定） ---
  s = await backAndWait('返回 → 边栏再次打开', { open: true })

  // --- 断言 5：页面安然无恙 ---
  check(s.frame === true, 'AppFrame 仍在场（React 未被 history 操作惊动）')
  check(s.depth === depth0, '栈深仍恒定', `depth=${depth0}→${s.depth}`)
} catch (error) {
  failed++
  console.log(`FAIL 异常中断 — ${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n') ?? ''}`)
} finally {
  proc.kill()
}

console.log(failed === 0 ? '\n全部 PASS' : `\n${failed} 项 FAIL`)
process.exit(failed === 0 ? 0 : 1)
