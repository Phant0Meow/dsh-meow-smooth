/** 探针：header 下方横线是否延续到色块区域（x 0-56）——canvas 读截图像素。 */
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
const PORT = 9361
const profile = join(process.env.TEMP ?? '.', `meow-probe7-${Date.now()}`)
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
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails)}`)
  return JSON.parse(res.result.value)
}

try {
  ws = new WebSocket(await cdpTabUrl())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
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
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
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
  await evalJson(`JSON.stringify((function(){ document.querySelector('[data-meow-smooth-fab]').click(); return '{}' })())`)
  await sleep(1000)
  await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(b => /分钟|小时|天/.test(b.textContent))
    if (rows.length > 0) rows[0].click()
    return '{}'
  })()`)
  for (let i = 0; i < 40; i++) {
    const r = await evalJson(`(function(){
      const f = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ furled: document.documentElement.getAttribute('data-meow-smooth-furled') === 'true' })
    })()`)
    if (r.furled === true) break
    await sleep(300)
  }
  await sleep(800)

  // 截图 → 页内 canvas 读像素：header 底边 y 上，取 x=28（色块内）、x=120、x=300 三点
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  const dataUrl = `data:image/png;base64,${shot.data}`
  const pixels = await evalJson(`(function(){
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const header = document.querySelector('[data-slot="conversation.session.header"] > header')
        const dpr = img.naturalWidth / window.innerWidth
        const bottomY = Math.round(header.getBoundingClientRect().bottom * dpr)
        const px = (cssX, devY) => {
          const d = ctx.getImageData(Math.round(cssX * dpr), devY, 1, 1).data
          return d[0] + ',' + d[1] + ',' + d[2]
        }
        const rows = {}
        for (let dy = -6; dy <= 6; dy++) {
          const devY = bottomY + dy
          rows[(devY - bottomY) + 'dev'] = { x28: px(28, devY), x55: px(55, devY), x200: px(200, devY) }
        }
        resolve(JSON.stringify({ dpr, bottomY, headerBottomCss: header.getBoundingClientRect().bottom, rows }))
      }
      img.onerror = () => resolve(JSON.stringify({ imgError: true }))
      img.src = ${JSON.stringify(dataUrl)}
    })
  })()`)
  console.log(pixels)
  console.log('(x28=色块内 / x55=竖线处 / x200=header 区；灰线像素应明显暗于白底)')
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
