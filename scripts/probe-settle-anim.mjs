/**
 * 诊断（临时）：需求⑲ 磁吸落位动画探针。复现"拉到略超窄档松手回落"
 * 场景，touchend 后每 40ms 高频采样轨道宽/官方态/rail 内容几何——定位
 * "细边栏从右边滑出"动画的真实来源（rAF 补间？React 过渡？内容布局响应？）。
 * 运行：node scripts/probe-settle-anim.mjs [baseUrl] [x1]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const X1 = Number(process.argv[3] ?? '62') // 松手时的横坐标（稍大于窄档 56）
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
const PORT = 9345
const profile = join(process.env.TEMP ?? '.', `meow-settle-diag-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
    await sleep(250)
  }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  return tab.webSocketDebuggerUrl
}
let ws, seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 15000)
  })
}
async function evalRaw(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) return { __exc: res.exceptionDetails.text }
  return res.result.value
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const excs = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') excs.push(msg.params.exceptionDetails.text)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error !== undefined ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 40; i++) {
    if (await evalRaw(`document.querySelector('[data-slot="root"] > *') !== null`) === true) break
    await sleep(300)
  }
  // 等最新构建标记
  for (let i = 0; i < 12; i++) {
    const tag = await evalRaw(`JSON.stringify(document.documentElement.dataset.meowSmoothGestureLoaded ?? '')`)
    if (tag === 'v4-clean') break
    await call('Page.reload', {})
    await sleep(2000)
  }
  await sleep(1200)

  console.log(`--- 场景：拉到 x=${X1} 松手 ---`)
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 18, y: 420 }] })
  const steps = Math.max(4, Math.round((X1 - 18) / 6))
  for (let i = 1; i <= steps; i++) {
    const x = 18 + (X1 - 18) * (i / steps)
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 420 }] })
    await sleep(24)
  }
  const t0 = Date.now()
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  // 高频采样 900ms：轨道宽 / 官方态 / rail 内容几何（logo 行与齿轮的位置尺寸）
  for (let i = 0; i < 22; i++) {
    const s = await evalRaw(`JSON.stringify((function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      if (frame === null) return { why: 'no-frame' }
      const col = document.querySelector('[data-slot="sidebar"] > *')
      const logoRow = col ? col.firstElementChild : null
      const foot = col ? col.lastElementChild : null
      const lr = logoRow ? logoRow.getBoundingClientRect() : null
      const fr = foot ? foot.getBoundingClientRect() : null
      return {
        t: Date.now(),
        track: parseFloat(getComputedStyle(frame).gridTemplateColumns),
        inlineCols: frame.style.gridTemplateColumns || '(none)',
        collapsed: frame.hasAttribute('data-sidebar-collapsed'),
        furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
        gesture: document.documentElement.getAttribute('data-meow-smooth-gesture'),
        logoX: lr ? Math.round(lr.left * 10) / 10 : -1,
        logoW: lr ? Math.round(lr.width * 10) / 10 : -1,
        footX: fr ? Math.round(fr.left * 10) / 10 : -1,
      }
    })())`)
    console.log(`t+${Date.now() - t0}ms ${s}`)
    await sleep(40)
  }
  // 高频采样 900ms 后，再低频观察 2.5s（attr 延迟释放窗口 + 之后）
  for (let i = 0; i < 10; i++) {
    const d = await evalRaw(`JSON.stringify({
      phase: window.__meowGestureDebug?.phase ?? '?',
      attr: document.documentElement.getAttribute('data-meow-smooth-gesture'),
      track: parseFloat(getComputedStyle(document.querySelector('[data-slot="root"] > *')).gridTemplateColumns),
    })`)
    console.log(`late t+${900 + i * 250}ms ${d}`)
    await sleep(250)
  }
  console.log('--- trace ---')
  console.log(JSON.stringify(await evalRaw('window.__meowGestureTrace ?? []'), null, 1))
  if (excs.length > 0) console.log('PAGE-EXC>', excs.join(' | '))
} catch (e) {
  console.log('DIAG-ERR', e.message)
} finally {
  proc.kill()
}
