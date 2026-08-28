/**
 * 探针：定位 3081 触屏仿真下 body user-select:none 的来源规则。
 * 遍历 document.styleSheets 全部规则，找 user-select 相关声明，
 * 输出选择器 + 所属样式表 URL + media 条件；并对照 body/html 的
 * 内联样式与 class（排查 JS 动态注入）。
 * 运行：node scripts/probe-userselect.mjs [baseUrl] [port]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const PORT = Number(process.argv[3] ?? 9369)

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const profile = join(process.env.TEMP ?? '.', `meow-usel-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) break } catch {}
    await sleep(250)
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  return (await created.json()).webSocketDebuggerUrl
}
let ws; let seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 25000)
  })
}
async function evalJson(expression) {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails !== undefined) throw new Error(`页面异常: ${res.exceptionDetails.text}`)
  return JSON.parse(res.result.value)
}
async function waitFor(label, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalJson(`(function(){ try { return JSON.stringify((${expression})()) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`)
    if (last.ok === true) return last
    await sleep(200)
  }
  throw new Error(`等待超时: ${label} — ${JSON.stringify(last)}`)
}

console.log(`======== user-select 来源定位 ${BASE} ========`)
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
  await waitFor('frame', `() => document.querySelector('[data-slot="root"] > *') !== null ? { ok: true } : { ok: false }`, 30000)
  await sleep(2000)

  const dump = await evalJson(`(async function(){
    // 1. 遍历所有样式表的 user-select 规则（含 media 条件）
    const hits = []
    const scan = (sheet, media) => {
      let rules
      try { rules = sheet.cssRules } catch { hits.push({ href: sheet.href, error: 'CORS' }); return }
      for (const rule of rules) {
        if (rule.type === 4 /* MEDIA_RULE */) { scan(rule, rule.conditionText); continue }
        if (rule.type === 12 /* SUPPORTS_RULE */) { scan(rule, (media ? media + ' & ' : '') + 'supports'); continue }
        const css = rule.cssText ?? ''
        if (css.includes('user-select')) {
          hits.push({
            media: media ?? '(all)',
            sel: rule.selectorText ?? css.slice(0, 80),
            decl: css.slice(css.indexOf('{') + 1, css.lastIndexOf('}')).trim().slice(0, 120),
            href: sheet.href ?? '(inline<style>)',
          })
        }
      }
    }
    for (const sheet of document.styleSheets) scan(sheet, null)
    // 2. body/html 现场状态
    const bodyCs = getComputedStyle(document.body)
    const htmlCs = getComputedStyle(document.documentElement)
    const state = {
      body: { us: bodyCs.userSelect, inline: document.body.getAttribute('style'), cls: document.body.className.slice(0, 80) },
      html: { us: htmlCs.userSelect, inline: document.documentElement.getAttribute('style'), cls: document.documentElement.className.slice(0, 80) },
      coarse: matchMedia('(pointer: coarse)').matches,
      styleSheetCount: document.styleSheets.length,
    }
    return JSON.stringify({ hits, state }, null, 1)
  })()`, true)
  console.log(dump)
} catch (e) {
  console.log(`探针异常 — ${e.message}`)
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
