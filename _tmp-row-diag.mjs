// 临时诊断：composer 按钮行换行结构（猫猫报折叠屏半窗换行丑）。
// 视口 400px 触发极窄收缩，dump row/trailing/模型 trigger 的 DOM 与 computed 布局。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3080'
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p))
const PORT = 9377
const profile = join(process.env.TEMP, `row-diag-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const tab = await (async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch {}
    await sleep(250)
  }
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json())
})()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const pend = new Map()
ws.onmessage = ev => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id)
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
  }
}
const call = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => {
    pend.set(id, { res, rej })
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error(`to ${method}`)) } }, 20000)
  })
}
const ev = async expr => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

try {
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: `${BASE}/` })
  let mounted = false
  for (let i = 0; i < 60; i++) {
    mounted = await ev(`document.querySelector('[data-slot="root"] > *') !== null`)
    if (mounted) break
    await sleep(250)
  }
  await sleep(1500)
  const out = await ev(`(function(){
    const card = document.querySelector('[data-composer-card]')
    if (card === null) return JSON.stringify({ err: 'no card' })
    let row = null
    for (const el of card.children) {
      if (el.tagName === 'DIV' && /_row/.test(el.className) && el.querySelector('button')) { row = el; break }
    }
    if (row === null) return JSON.stringify({ err: 'no row', childClasses: [...card.children].map(c => c.className) })
    const rowCS = getComputedStyle(row)
    const children = [...row.children].map(el => {
      const cs = getComputedStyle(el)
      return {
        cls: el.className,
        tag: el.tagName,
        w: Math.round(el.getBoundingClientRect().width),
        flex: cs.flex,
        minW: cs.minWidth,
        wrap: cs.flexWrap,
      }
    })
    const trailing = row.querySelector('[class*="_trailing"]')
    const trailingKids = trailing === null ? [] : [...trailing.children].map(el => ({
      cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '(svg/el)',
      tag: el.tagName,
      slot: el.getAttribute?.('data-slot') ?? '',
      w: Math.round(el.getBoundingClientRect().width),
      flex: getComputedStyle(el).flex,
    }))
    const modelBtn = card.querySelector('[data-slot="conversation.input.model"] button')
    const modelCS = modelBtn === null ? null : (({ display, minWidth, maxWidth, overflow }) => ({ display, minWidth, maxWidth, overflow }))(getComputedStyle(modelBtn))
    const modelSpans = modelBtn === null ? [] : [...modelBtn.children].map(el => {
      const cs = getComputedStyle(el)
      return { tag: el.tagName, cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '', text: (el.textContent ?? '').slice(0, 30), minW: cs.minWidth, ov: cs.overflow, ws: cs.whiteSpace, to: cs.textOverflow, display: cs.display, w: Math.round(el.getBoundingClientRect().width) }
    })
    return JSON.stringify({
      rowWrap: rowCS.flexWrap,
      rowW: Math.round(row.getBoundingClientRect().width),
      rowScrollW: row.scrollWidth,
      rowClientW: row.clientWidth,
      children, trailingKids, modelCS, modelSpans,
    }, null, 1)
  })()`)
  console.log(out)
} catch (e) {
  console.log('ERR', e.message)
} finally {
  try { ws.close() } catch {}
  try { proc.kill() } catch {}
}
