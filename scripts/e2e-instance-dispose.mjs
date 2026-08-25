/**
 * e2e：单实例拆除协议（2026-08-25 边栏循环动画 bug 根治回归）。
 *
 * bug 回顾：dsh 模块热替换会在不刷新页面的前提下重新执行 client.js——旧
 * 实例的 500ms syncSidebarFurl 轮询此前从不拆除。旧实例带着热替换前的
 * 内部状态（railRevealed=true / 手势 hold=true），新实例全新状态，两边
 * 互踢 furl 标记 → 边栏陷入"展开到细条⇄收到 0"的永动循环。
 *
 * 本脚本在真实 dsh 页面的 ?meow-smooth-ui=off 干净态上，用页面内 fetch
 * 出的真实构建产物 + new Function 多次实例化（每次 = 一次热替换重新执
 * 行，全新模块闭包），配 mock ctx 驱动，验证：
 *
 *  1. 双实例安装后 fold 样式只有一份（入口拆除生效，不再无限堆积）；
 *  2. window.__meowSmoothClientDispose 存在、手势标记为 v5.4；
 *  3. 手势拉出细条（制造旧实例 hold 分歧态——bug 引信）后热替换：
 *     【核心】furl 属性至多回摆一次并稳定折叠，不再往复横跳；
 *  4. FAB 点击在活跃实例上恰好触发一次 toggle（接线正常）；
 *  5. dispose 后：点 FAB 零副作用（所有 fab 监听已死）+ 手动摘除 furl
 *     属性 1.3s 内无人写回（轮询写入者已死）；
 *  6. 协议可循环：再次 apply 后写入者复活。
 *
 * 运行：node scripts/e2e-instance-dispose.mjs [baseUrl]
 * 默认 baseUrl = http://127.0.0.1:3080（须已装配 meow-smooth）。
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

// --- 起 headless Edge（裸 CDP） ---
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9342
const profile = join(process.env.TEMP ?? '.', `meow-smooth-dispose-e2e-${Date.now()}`)
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
async function evalJson(expression, awaitPromise = false) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (res.exceptionDetails !== undefined) {
    const d = res.exceptionDetails
    throw new Error(`页面异常: ${d.text} ${JSON.stringify(d.exception?.description ?? d)} @line=${d.lineNumber} col=${d.columnNumber}`)
  }
  return JSON.parse(res.result.value)
}
/** 轮询等待页面内断言条件成立。 */
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
    // 拦截 pending 轮询：mock 实例的 3s 轮询打真实接口会弹卡片/刷日志，
    // 返回恒空保确定性。
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
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  // 真实页面：插件随加载自动安装（实例 R = 生产首装）。此后的 mock 实例
  // 每个都等价于一次"模块热替换重新执行"——入口拆除协议会先拆掉上一个。
  await call('Page.navigate', { url: `${BASE}/` })

  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1500) // R 首帧折叠完成（≥2 个 500ms tick）

  // --- 页面内引导（两步，报错可定位）：①fetch 真实产物并剥壳存 body；
  // ②用存的 body 构造工厂（语法错在此步被捕获回传）。 ---
  const strip = await evalJson(`(async () => {
    const src = await (await fetch('/plugins/meow-smooth/client.js?v=' + Date.now(), { cache: 'no-store' })).text()
    const marker = 'factory: (require) => {'
    const i = src.indexOf(marker)
    if (i < 0) return JSON.stringify({ ok: false, why: 'factory marker missing' })
    let body = src.slice(i + marker.length)
    // 去掉尾部 sourcemap 注释 + footer 的 "});" + factory 收尾 "}"。
    body = body.replace(/\\/\\/# sourceMappingURL=.*$/m, '').trimEnd()
    if (body.endsWith('});')) body = body.slice(0, -3)
    body = body.replace(/\\}\\s*$/, '').trimEnd()
    window.__meowBody = body
    return JSON.stringify({ ok: true, bodyLen: body.length, tail: body.slice(-80) })
  })()`, true)
  check(strip.ok === true, '引导①：产物剥壳完成', `bodyLen=${strip.bodyLen ?? strip.why} tail=${JSON.stringify(strip.tail ?? '')}`)
  if (strip.ok !== true) throw new Error('剥壳失败：' + strip.why)
  const build = await evalJson(`(function(){
    try {
      window.__meowFactory = new Function('require', window.__meowBody)
    } catch (e) {
      return JSON.stringify({ ok: false, why: String(e && e.message) })
    }
    // 每次调用 = 一次"模块热替换重新执行"：全新模块闭包；mock ctx 的
    // layout 计数器暴露在 window 上供断言读取。
    window.__meowApplyMock = () => {
      const ctx = {
        slots: { inject() {}, register(o) { return o } },
        layout: { __n: 0, toggleSidebar() { ctx.layout.__n++ } },
        sessions: {},
      }
      window.__meowFactory(() => ({})).apply(ctx)
      window.__meowLayout = ctx.layout
      return { toggles: ctx.layout.__n }
    }
    window.__meowFabClick = () => {
      const fab = document.querySelector('[data-meow-smooth-fab]')
      if (fab === null) return false
      fab.click()
      return true
    }
    // 合成触摸滑动：直派发 TouchEvent（不经浏览器输入管线——CDP 模拟触摸
    // 拖过正文会触发文本选区，selguard 守卫按设计放行导致手势无声中止）。
    window.__meowSwipe = () => {
      const el = document.elementFromPoint(10, 500)
      if (el === null) return JSON.stringify({ ok: false, why: 'elementFromPoint null' })
      const mk = (type, x) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: 500 })
        const ended = type === 'touchend'
        return new TouchEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          touches: ended ? [] : [t],
          targetTouches: ended ? [] : [t],
          changedTouches: [ended ? new Touch({ identifier: 1, target: el, clientX: x, clientY: 500 }) : t],
        })
      }
      el.dispatchEvent(mk('touchstart', 10))
      // 轻划：终位移必须 < LONG_SWIPE(110)，否则走直达宽档分支。
      for (let i = 1; i <= 10; i++) el.dispatchEvent(mk('touchmove', 10 + 6 * i))
      el.dispatchEvent(mk('touchend', 70))
      return JSON.stringify({
        ok: true,
        tag: el.tagName,
        selType: document.getSelection().type,
        collapsedFrame: (document.querySelector('[data-slot="root"] > *') ?? document.body).hasAttribute('data-sidebar-collapsed'),
      })
    }
    return JSON.stringify({ ok: true })
  })()`)
  check(build.ok === true, '引导②：工厂就绪', build.why ?? '')
  if (build.ok !== true) throw new Error('工厂构造失败：' + build.why)

  /** 页内快捷读取。 */
  const read = async () => evalJson(`(function(){
    return JSON.stringify({
      styles: document.querySelectorAll('style[data-meow-fold-css]').length,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      collapsed: (document.querySelector('[data-slot="root"] > *') ?? document.body).hasAttribute('data-sidebar-collapsed'),
      disposeFn: typeof window.__meowSmoothClientDispose,
      gestureMark: document.documentElement.dataset.meowSmoothGestureLoaded ?? '',
      toggles: (window.__meowLayout ?? { __n: -1 }).__n,
    })
  })()`)

  // --- 断言 1：基线（R=生产首装在岗）+ mock 实例 A 接管（一次"热替换"） ---
  let st = await read()
  check(st.styles === 1 && st.furled === 'true', 'R 基线：样式唯一且窄屏已折叠',
    `styles=${st.styles} furled=${st.furled}`)
  const a = await evalJson(`(function(){ return JSON.stringify(window.__meowApplyMock()) })()`)
  check(a.toggles === 0, 'A 安装完成（无多余 toggle）', `toggles=${a.toggles}`)
  await sleep(700)
  st = await read()
  check(st.styles === 1, 'A：fold 样式唯一（R 的已随协议拆除，未堆积）', `styles=${st.styles}`)
  check(st.disposeFn === 'function', '__meowSmoothClientDispose 已挂载')
  check(st.furled === 'true', 'A：窄屏收起自动折叠（写入者在岗）', `furled=${st.furled}`)

  // --- 断言 2：手势拉出细条（制造旧实例 hold 分歧态——bug 的引信） ---
  const sw = await evalJson(`(function(){ return JSON.stringify(window.__meowSwipe()) })()`)
  await sleep(300)
  st = await read()
  const trace = await evalJson(`(function(){
    return JSON.stringify({
      trace: window.__meowGestureTrace ?? [],
      inst: window.__meowGestureInstanceId ?? '',
      coarse: matchMedia('(pointer: coarse)').matches,
    })
  })()`)
  check(st.furled !== 'true', '手势右轻划：解除 furl 拉出细条（A.hold=true）',
    `furled=${st.furled} swipe=${JSON.stringify(sw)} inst=${trace.inst} coarse=${trace.coarse} trace=${JSON.stringify(trace.trace)}`)

  // --- 断言 3【核心】：热替换（B 上场，入口拆光 A）后不再横跳 ---
  const b = await evalJson(`(function(){ return JSON.stringify(window.__meowApplyMock()) })()`)
  check(b.toggles === 0, 'B 安装完成（无多余 toggle）', `toggles=${b.toggles}`)
  await sleep(120)
  st = await read()
  check(st.styles === 1, 'B：fold 样式仍唯一（A 的已随协议拆除）', `styles=${st.styles}`)
  check(st.gestureMark === 'v5.5-composer-reveal', '手势构建标记 v5.5-composer-reveal', st.gestureMark)
  // B 的首个 tick 会把 A 留下的"细条在场"折回 0（furl=true）；此后必须恒定。
  const samples = []
  for (let i = 0; i < 9; i++) {
    await sleep(200)
    samples.push((await read()).furled)
  }
  const transitions = samples.slice(1).filter((v, i) => v !== samples[i]).length
  check(transitions <= 1 && samples[samples.length - 1] === 'true',
    '热替换后 1.8s 内 furl 至多回摆一次且稳定折叠（无永动横跳）',
    `transitions=${transitions} samples=${samples.join(',')}`)

  // --- 断言 4：FAB 点击恰好一次 toggle（活跃实例接线正常） ---
  const baseToggles = (await read()).toggles
  await evalJson(`(function(){ return JSON.stringify({ clicked: window.__meowFabClick() }) })()`)
  await sleep(250)
  st = await read()
  check(st.toggles === baseToggles + 1, 'FAB 点击单发（两态路径 toggle 恰 +1）',
    `${baseToggles} → ${st.toggles}`)

  // --- 断言 5：dispose 后零监听/零写入者 ---
  // 先等 B 的 tick 把断言 4 解除的 furl 折回去，再拆。
  await waitFor('dispose 前回到折叠态', `() => {
    const f = document.documentElement.getAttribute('data-meow-smooth-furled')
    return f === 'true' ? { ok: true } : { ok: false, f }
  }`, 4000)
  await evalJson(`(function(){ window.__meowSmoothClientDispose(); return JSON.stringify({ ok: true }) })()`)
  await sleep(100)
  // 5a：点 FAB —— 若任何实例的 fab 监听存活，会 setFurled(false) → 属性消失。
  await evalJson(`(function(){ return JSON.stringify({ clicked: window.__meowFabClick() }) })()`)
  const deadSamples = []
  for (let i = 0; i < 7; i++) {
    await sleep(190)
    const s = await read()
    deadSamples.push(`${s.furled}/${s.styles}/${s.toggles}`)
  }
  const fabDead = deadSamples.every(v => v.startsWith('true/') )
  check(fabDead, 'dispose 后点 FAB：1.3s 内 furl 恒为折叠、样式不再出现（全部监听已死）',
    `samples=${deadSamples.join(',')}`)
  // 5b：手动摘除 furl —— 若轮询写入者存活，500ms 内会写回。
  await evalJson(`(function(){
    document.documentElement.removeAttribute('data-meow-smooth-furled')
    return JSON.stringify({ ok: true })
  })()`)
  const goneSamples = []
  for (let i = 0; i < 7; i++) {
    await sleep(190)
    goneSamples.push((await read()).furled)
  }
  check(goneSamples.every(v => v !== 'true'), '手动摘除 furl 后 1.3s：无人写回（轮询已死）',
    `samples=${goneSamples.join(',')}`)

  // --- 断言 6：协议可循环（再装即复活） ---
  await evalJson(`(function(){ window.__meowApplyMock(); return JSON.stringify({ ok: true }) })()`)
  const revived = await waitFor('重装后写入者复活', `() => {
    const f = document.documentElement.getAttribute('data-meow-smooth-furled')
    return f === 'true' ? { ok: true } : { ok: false, f }
  }`, 4000)
  check(revived.ok === true, '再次 apply：折叠写入者复活（协议可循环）')

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
