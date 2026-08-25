/** 探针：fab display 诊断——哪些规则命中、:has 是否误匹配。 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9359
const profile = join(process.env.TEMP ?? '.', `meow-probe6-${Date.now()}`)
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 20000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails)}`)
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
  await sleep(1200)

  const dump = await evalJson(`(function(){
    const fab = document.querySelector('[data-meow-smooth-fab]')
    if (fab === null) return JSON.stringify({ nofab: true })
    const cs = getComputedStyle(fab)
    const rules = []
    for (const sheet of document.styleSheets) {
      let list
      try { list = sheet.cssRules } catch { continue }
      const walk = (rs) => {
        for (const r of rs) {
          if (r.cssRules) walk(r.cssRules)
          if (r.selectorText && r.selectorText.includes('meow-smooth-fab')) {
            let matches = false
            try { matches = fab.matches(r.selectorText) } catch {}
            let mediaOk = true
            let parent = r.parentRule
            while (parent) {
              if (parent.conditionText) mediaOk = mediaOk && matchMedia(parent.conditionText).matches
              parent = parent.parentRule
            }
            rules.push({ sel: r.selectorText.slice(0, 90), disp: r.style?.display ?? '', matches, mediaOk })
          }
        }
      }
      walk(list)
    }
    return JSON.stringify({
      display: cs.display,
      rect: (({x,y,w,h}) => ({x,y,w,h}))({x: fab.getBoundingClientRect().x, y: fab.getBoundingClientRect().y, w: fab.getBoundingClientRect().width, h: fab.getBoundingClientRect().height}),
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      mediaMatch: matchMedia('(max-width:1023px)').matches,
      coarse: matchMedia('(pointer:coarse)').matches,
      hasDialog: document.querySelector('div[role="dialog"]') !== null,
      dialogCount: document.querySelectorAll('div[role="dialog"]').length,
      ime: document.documentElement.getAttribute('data-meow-smooth-ime'),
      rules,
    })
  })()`)
  console.log(JSON.stringify(dump, null, 1))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
