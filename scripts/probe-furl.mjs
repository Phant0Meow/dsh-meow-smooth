/** 探针：furl 态点击小方块后，抓 fab 显示状态与样式表命中细节。 */
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
const PORT = 9343
const profile = join(process.env.TEMP ?? '.', `meow-probe-${Date.now()}`)
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

  for (let i = 0; i < 100; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ frame: f !== null, furled: document.documentElement.getAttribute('data-meow-smooth-furled') })
    })()`)
    if (r.frame === true && r.furled === 'true') break
    await sleep(300)
  }
  await sleep(1200)

  console.log('--- 初始 ---')
  console.log(await evalJson(`JSON.stringify((function(){
    const fabs = document.querySelectorAll('[data-meow-smooth-fab]')
    const fab = fabs[0]
    return {
      fabCount: fabs.length,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      display: fab ? getComputedStyle(fab).display : null,
      mediaMatch: matchMedia('(max-width:1023px)').matches,
      coarse: matchMedia('(pointer:coarse)').matches,
      ime: document.documentElement.getAttribute('data-meow-smooth-ime'),
      dialogs: document.querySelectorAll('div[role="dialog"]').length,
      pendingVisible: document.querySelector('[data-meow-smooth-pending][data-visible="true"]') !== null,
    }
  })())`))

  await evalJson(`JSON.stringify((function(){
    document.querySelector('[data-meow-smooth-fab]').click()
    return '{}'
  })())`)
  await sleep(900)

  console.log('--- 点小方块后 900ms ---')
  console.log(await evalJson(`JSON.stringify((function(){
    const fabs = document.querySelectorAll('[data-meow-smooth-fab]')
    const fab = fabs[0]
    const rules = []
    for (const sheet of document.styleSheets) {
      let list
      try { list = sheet.cssRules } catch { continue }
      const walk = (rs) => { for (const r of rs) {
        if (r.cssRules) walk(r.cssRules)
        if (r.selectorText && r.selectorText.includes('meow-smooth-fab')) {
          rules.push({ sel: r.selectorText, css: r.style?.cssText ?? '', parentMedia: r.parentRule?.conditionText ?? '' })
        }
      } }
      walk(list)
    }
    return {
      fabCount: fabs.length,
      furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      display: fab ? getComputedStyle(fab).display : null,
      collapsed: document.querySelector('[data-slot="root"] > *').hasAttribute('data-sidebar-collapsed'),
      fabHtmlHead: fab ? fab.outerHTML.slice(0, 160) : null,
      rules,
    }
  })())`))

  // 展开轨迹采样：点原生 toggle 后每 120ms 记录 (collapsed, track1)
  await evalJson(`JSON.stringify((function(){
    const col = document.querySelector('[data-slot="sidebar"] > *')
    const btns = col.firstElementChild.querySelectorAll('button')
    btns[btns.length - 1].click()
    return '{}'
  })())`)
  const samples = []
  for (let i = 0; i < 12; i++) {
    samples.push(await evalJson(`JSON.stringify((function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      return {
        collapsed: frame.hasAttribute('data-sidebar-collapsed'),
        raw: getComputedStyle(frame).gridTemplateColumns,
        t1: parseFloat(getComputedStyle(frame).gridTemplateColumns),
        inlineStyle: frame.style.gridTemplateColumns,
      }
    })())`))
    await sleep(120)
  }
  console.log('--- 展开轨迹（toggle 点击后） ---')
  for (const s of samples) console.log(JSON.stringify(s))
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
