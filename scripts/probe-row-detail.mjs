/** 鎺㈤拡锛氬睍寮€鎬佷晶杈规爮 region 鍖烘寜閽粨鏋勶紙鎵句細璇濊鐨勫彲闈犻敋鐐癸級銆?*/
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('鎵句笉鍒?msedge.exe')
const PORT = 9351
const profile = join(process.env.TEMP ?? '.', `meow-probe2-${Date.now()}`)
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
let ws, seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 瓒呮椂: ${method}`)) } }, 20000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error(`椤甸潰寮傚父: ${JSON.stringify(res.exceptionDetails)}`)
  return JSON.parse(res.result.value)
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ frame: f !== null, furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.frame === true && r.furled === true) break
    await sleep(300)
  }
  // 灞曞紑
  await evalJson(`JSON.stringify((function(){ document.querySelector('[data-meow-smooth-fab]').click(); return '{}' })())`)
  await sleep(1200)

  const dump = await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const region = column.querySelector('[class*="region"], div:nth-child(3)') ?? column.children[2]
    const out = []
    const walk = (el, depth) => {
      if (out.length > 40 || depth > 14) return
      for (const child of el.children) {
        const isBtn = child.tagName === 'BUTTON'
        const text = (child.textContent ?? '').trim().replaceAll(/\\s+/g, ' ').slice(0, 30)
        out.push({
          depth,
          tag: child.tagName,
          btn: isBtn,
          cls: String(child.className).slice(0, 60),
          aria: child.getAttribute?.('aria-label') ?? '',
          text,
        })
        walk(child, depth + 1)
      }
    }
    walk(column.children[2] ?? column, 0)
    return JSON.stringify(out)
  })()`)
  console.log(JSON.stringify(dump, null, 1))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}

