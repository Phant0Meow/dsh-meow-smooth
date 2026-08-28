/**
 * 探针：会话内 user-select:none 源头精确定位（2026-08-28 猫猫报 3081 手机
 * 端无法选中正文；触屏仿真下 3081 消息链路全部计算为 none、3080 全 auto、
 * 3081 PC 全 auto；首页扫描无全局规则 → 进会话后才出现）。
 *
 * 手机仿真进入会话后：从 documentElement 走到消息文字，逐层记录计算值；
 * 对最高一处 auto→none 的边界元素，检查 ①内联 style ②全部已加载样式表
 * 中匹配该元素且含 user-select 的规则（含 media 条件与文件来源）。
 * 运行：node scripts/probe-us-src.mjs [baseUrl] [port]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const PORT = Number(process.argv[3] ?? 9372)

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const profile = join(process.env.TEMP ?? '.', `meow-ussrc-${Date.now()}`)
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

console.log(`======== user-select 源头定位 ${BASE} ========`)
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
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('frame', `() => document.querySelector('[data-slot="root"] > *') !== null ? { ok: true } : { ok: false }`, 30000)
  await sleep(1500)

  // 进会话（与 touch-select 相同的自适应导航）
  const nav = await evalJson(`(function(){
    const frame = document.querySelector('[data-slot="root"] > *')
    const collapsed = frame?.hasAttribute('data-sidebar-collapsed') ?? true
    const furled = document.documentElement.getAttribute('data-meow-smooth-furled') === 'true'
    if (!collapsed) return JSON.stringify({ step: 'expanded' })
    if (furled) { document.querySelector('[data-meow-smooth-fab]')?.click(); return JSON.stringify({ step: 'fab' }) }
    const btns = document.querySelector('[data-slot="sidebar"] > *')?.firstElementChild?.querySelectorAll('button') ?? []
    if (btns.length === 0) return JSON.stringify({ step: 'no-toggle' })
    btns[btns.length - 1].click()
    return JSON.stringify({ step: 'toggle' })
  })()`)
  if (nav.step === 'fab' || nav.step === 'toggle') {
    await waitFor('侧边栏可用', `() => {
      const frame = document.querySelector('[data-slot="root"] > *')
      if (frame === null) return { ok: false }
      if (document.documentElement.getAttribute('data-meow-smooth-furled') === 'true') return { ok: false }
      return { ok: true, collapsed: frame.hasAttribute('data-sidebar-collapsed') }
    }`)
    const st = await evalJson(`(function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null })
    })()`)
    if (st.collapsed === true) {
      await evalJson(`(function(){
        const btns = document.querySelector('[data-slot="sidebar"] > *').firstElementChild.querySelectorAll('button')
        btns[btns.length - 1].click()
        return JSON.stringify({ ok: true })
      })()`)
      await sleep(700)
    }
  }
  await waitFor('会话树', `() => {
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...(column?.querySelectorAll('div[role="treeitem"]') ?? [])].filter(r => /分钟|小时|天/.test(r.textContent ?? ''))
    return rows.length > 0 ? { ok: true } : { ok: false }
  }`, 12000)
  await evalJson(`(function(){
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const rows = [...column.querySelectorAll('div[role="treeitem"]')].filter(r => !r.className.includes('projectRow') && /分钟|小时|天/.test(r.textContent ?? ''))
    rows[0]?.click()
    return JSON.stringify({ ok: true })
  })()`)
  await waitFor('消息', `() => document.querySelectorAll('[data-time-hover-root]').length >= 1 ? { ok: true } : { ok: false }`, 15000)
  await sleep(1200)

  const dump = await evalJson(`(function(){
    // 取一条消息文字元素
    const roots = [...document.querySelectorAll('[data-time-hover-root]')]
    let target = null
    const walker = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && (node.textContent ?? '').trim().length > 20 && target === null) target = node.parentElement
        else if (node.nodeType === 1) walker(node)
      }
    }
    for (const root of roots) walker(root)
    if (target === null) return JSON.stringify({ ok: false, why: 'no-text-target', roots: roots.length })
    // 从 html 一路向下收集链（含 html 本身）
    const chain = []
    const collect = (el) => {
      if (el === null) return
      collect(el.parentElement)
      chain.push(el)
    }
    collect(target)
    // 逐层计算值 + 找 auto→none 边界
    const rows = chain.map((el) => {
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        us: cs.userSelect,
        inlineUs: el.style.userSelect || null,
        isHtml: el === document.documentElement,
        isBody: el === document.body,
      }
    })
    // 边界：第一个（最靠上）computed==='none' 的元素
    let boundary = -1
    for (let i = 0; i < rows.length; i++) { if (rows[i].us === 'none') { boundary = i; break } }
    // 对边界元素查匹配规则
    let ruleHits = []
    if (boundary >= 0) {
      const el = chain[boundary]
      const scanSheet = (sheet, media) => {
        let rules; try { rules = sheet.cssRules } catch { return }
        for (const rule of rules) {
          if (rule.type === 4) { scanSheet(rule, rule.conditionText); continue }
          if (rule.selectorText === undefined) continue
          const css = rule.cssText ?? ''
          if (!css.includes('user-select')) continue
          let m = false
          try { m = el.matches(rule.selectorText) } catch {}
          if (m) ruleHits.push({ media: media ?? '(all)', sel: rule.selectorText.slice(0, 100), href: sheet.href ?? '(inline<style>)', decl: css.slice(css.indexOf('{') + 1, css.lastIndexOf('}')).trim().slice(0, 140) })
        }
      }
      for (const sheet of document.styleSheets) scanSheet(sheet, null)
    }
    return JSON.stringify({
      ok: true,
      sample: target.textContent.slice(0, 24),
      boundary: boundary >= 0 ? { index: boundary, ...rows[boundary] } : null,
      chainRows: rows.map(r => (r.isHtml ? 'html' : r.isBody ? 'body' : r.tag + (r.cls ? '.' + r.cls.split(/\\s+/).join('|').slice(0, 30) : '')) + '=' + r.us + (r.inlineUs ? ' INLINE!' : '')),
      ruleHits,
      styleTags: [...document.querySelectorAll('style')].map(s => ({ marker: s.getAttribute('data-meow-smooth-gesture-css') !== null ? 'meow-gesture' : (s.textContent ?? '').slice(0, 40) })).slice(0, 24),
    }, null, 1)
  })()`, true)
  console.log(dump)
} catch (e) {
  console.log(`探针异常 — ${e.message}`)
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
