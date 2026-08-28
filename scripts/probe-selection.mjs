/**
 * 探针：3081「文字无法选中 + 细边栏自动弹出回来」对比诊断（2026-08-28 猫猫报）。
 *
 * 对指定实例做只读体检 + 真实交互测试：
 *  1. 静态状态：meow-smooth 构建标记 / furl 标记 / FAB / 侧边栏收起态 /
 *     竖条底部按钮数（三态判定）/ 手势实例 id / hold 标记；
 *  2. 侧边栏状态采样 5s（250ms 间隔）：无操作时是否自己抖动（弹出⇄收起）；
 *  3. 进入最近会话，挂 document capture 探针监听
 *     mousedown/mouseup/click/selectstart（记 target 链 + defaultPrevented），
 *     对 AI 回答段落做【真实 CDP 双击】→ 读 getSelection()：
 *     选中 = 浏览器正常；没选中 = 有谁拦了（探针日志指出元凶）；
 *  4. 采样点击点的 elementsFromPoint 前 3 层（识别透明覆盖层）。
 *
 * 运行：node scripts/probe-selection.mjs [baseUrl] [port]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const PORT = Number(process.argv[3] ?? 9353)

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = CANDIDATES.find(p => existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
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
    await sleep(150)
  }
  throw new Error(`等待超时: ${label} — 最后状态 ${JSON.stringify(last)}`)
}

console.log(`======== 探针 ${BASE} ========`)
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
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await call('Page.navigate', { url: `${BASE}/` })
  await waitFor('AppFrame 挂载', `() => {
    const frame = document.querySelector('[data-slot="root"] > *')
    return frame !== null ? { ok: true } : { ok: false }
  }`, 30000)
  await sleep(1500)

  // --- 1. 静态状态体检 ---
  const stat = await evalJson(`(function(){
    const html = document.documentElement
    const frame = document.querySelector('[data-slot="root"] > *')
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const foot = column?.lastElementChild ?? null
    const fab = document.querySelector('[data-meow-smooth-fab]')
    const fabStyle = fab !== null ? getComputedStyle(fab).display : 'absent'
    const w = window
    return JSON.stringify({
      marker: html.dataset.meowSmoothGestureLoaded ?? '(无)',
      furled: html.getAttribute('data-meow-smooth-furled'),
      collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
      frameW: Math.round(frame?.getBoundingClientRect().width ?? 0),
      footButtons: foot !== null ? foot.querySelectorAll('button').length : -1,
      footTexts: foot !== null ? [...foot.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 12)) : [],
      fabDisplay: fabStyle,
      gestureHold: w.__meowSmoothGestureHold ?? null,
      gestureInstance: w.__meowGestureInstanceId ?? null,
      foldTrace: (w.__meowFoldTrace ?? null) !== null ? w.__meowFoldTrace.length : null,
      coarse: matchMedia('(pointer: coarse)').matches,
    })
  })()`)
  console.log('静态状态:', JSON.stringify(stat, null, 2))

  // --- 2. 侧边栏状态采样 5s：无操作是否自己抖动 ---
  const samples = []
  for (let i = 0; i < 20; i++) {
    const s = await evalJson(`(function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({
        c: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
        f: document.documentElement.getAttribute('data-meow-smooth-furled'),
        w: Math.round(frame?.getBoundingClientRect().width ?? 0),
      })
    })()`)
    samples.push(s)
    await sleep(250)
  }
  const flips = samples.filter((s, i) => i > 0 && (s.c !== samples[i - 1].c || s.f !== samples[i - 1].f))
  console.log(`侧边栏采样 20 次（5s）: 抖动 ${flips.length} 次`, flips.length > 0 ? JSON.stringify(flips.slice(0, 6)) : '（稳定）')

  // --- 3. 展开侧边栏（若收起）→ 进最近会话 ---
  const expanded = await evalJson(`(function(){
    const frame = document.querySelector('[data-slot="root"] > *')
    if (frame === null) return JSON.stringify({ ok: false })
    if (!frame.hasAttribute('data-sidebar-collapsed')) return JSON.stringify({ ok: true, already: true })
    const column = document.querySelector('[data-slot="sidebar"] > *')
    const logoRow = column?.firstElementChild ?? null
    const btns = logoRow?.querySelectorAll('button') ?? []
    const toggle = btns.length > 0 ? btns[btns.length - 1] : null
    if (toggle === null) return JSON.stringify({ ok: false, why: 'no rail toggle' })
    toggle.click()
    return JSON.stringify({ ok: true, clicked: 'rail-toggle' })
  })()`)
  if (expanded.ok && !expanded.already) await sleep(800)

  const sess = await evalJson(`(function(){
    const rows = [...document.querySelectorAll('div[role="treeitem"]')]
      .filter(r => !r.className.includes('projectRow'))
      .filter(r => /分钟|小时|天/.test(r.textContent ?? ''))
    if (rows.length === 0) return JSON.stringify({ ok: false, why: 'no session rows', total: document.querySelectorAll('div[role="treeitem"]').length })
    rows[0].click()
    return JSON.stringify({ ok: true, title: (rows[0].textContent ?? '').slice(0, 24) })
  })()`)
  console.log('进会话:', JSON.stringify(sess))
  if (sess.ok) {
    await waitFor('消息渲染', `() => {
      const roots = document.querySelectorAll('[data-time-hover-root]')
      return roots.length >= 1 ? { ok: true, n: roots.length } : { ok: false }
    }`, 15000)
    await sleep(800)

    // --- 4. 挂事件探针 → 真实双击 AI 回答文字 → 读选区 ---
    await evalJson(`(function(){
      const log = []
      w = window
      w.__probeLog = log
      const desc = (el) => {
        if (el === null || !(el instanceof Element)) return String(el)
        const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(/\\s+/).slice(0, 2).join('.')
        return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (el.closest('[data-slot]') !== null ? '@' + el.closest('[data-slot]').getAttribute('data-slot') : '')
      }
      for (const type of ['mousedown', 'mouseup', 'click', 'selectstart', 'dblclick']) {
        document.addEventListener(type, (e) => {
          log.push({ t: type, target: desc(e.target), dp: e.defaultPrevented })
        }, { capture: true, passive: true })
      }
      return JSON.stringify({ ok: true })
    })()`)

    const spot = await evalJson(`(function(){
      // 找 AI 回答（TurnTailNodeView root = 助手行）里最长的带文字叶子：
      // 不假设标签（rc.2 消息体不是 p/li），直接扫文本节点。
      const roots = [...document.querySelectorAll('[data-time-hover-root]')]
      let best = null
      const walker = (el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && (node.textContent ?? '').trim().length > 30) {
            const parent = node.parentElement
            const r = parent.getBoundingClientRect()
            if (r.width > 40 && r.height > 10 && (best === null || r.width * r.height > best.area)) {
              best = { el: parent, area: r.width * r.height }
            }
          } else if (node.nodeType === 1) {
            walker(node)
          }
        }
      }
      for (const root of roots) walker(root)
      if (best === null) return JSON.stringify({ ok: false, roots: roots.length })
      // 滚进视口再量（长会话里最长文本可能在视口外几千 px）
      best.el.scrollIntoView({ block: 'center' })
      return JSON.stringify({ ok: true, pending: true })
    })()`)
    if (spot.pending === true) {
      await sleep(400)
      const spot2 = await evalJson(`(function(){
        // 滚动后重找视口内的目标：取视口内带文字且最宽的叶子
        const roots = [...document.querySelectorAll('[data-time-hover-root]')]
        let best = null
        const walker = (el) => {
          for (const node of el.childNodes) {
            if (node.nodeType === 3 && (node.textContent ?? '').trim().length > 30) {
              const parent = node.parentElement
              const r = parent.getBoundingClientRect()
              if (r.width > 40 && r.height > 10 && r.top > 60 && r.bottom < 740 && (best === null || r.width > best.w)) {
                best = { el: parent, w: r.width }
              }
            } else if (node.nodeType === 1) walker(node)
          }
        }
        for (const root of roots) walker(root)
        if (best === null) return JSON.stringify({ ok: false, why: 'no in-viewport target' })
        const r = best.el.getBoundingClientRect()
        const chain = []
        let n = best.el
        while (n !== null && n !== document.documentElement) {
          const us = getComputedStyle(n).userSelect
          if (us && us !== 'auto') chain.push(n.tagName + ':' + us)
          n = n.parentElement
        }
        return JSON.stringify({
          ok: true,
          x: Math.round(r.left + Math.min(120, r.width / 2)),
          y: Math.round(r.top + r.height / 2),
          userSelectChain: chain,
          sample: best.el.textContent.slice(0, 30),
        })
      })()`)
      Object.assign(spot, spot2)
    }
    console.log('双击落点:', JSON.stringify(spot))

    if (spot.ok) {
      // 挂 selectstart 探针后真实双击
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
      await sleep(60)
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
      await sleep(300)
      const sel = await evalJson(`(function(){
        const s = document.getSelection()
        const stack = document.elementsFromPoint(${spot.x}, ${spot.y}).slice(0, 4).map(el => {
          const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(/\\s+/).slice(0, 2).join('.')
          return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
        })
        return JSON.stringify({
          type: s.type,
          text: s.toString().slice(0, 40),
          stack,
          probeLog: (window.__probeLog ?? []).slice(0, 20),
        })
      })()`)
      console.log('双击选区结果:', JSON.stringify(sel, null, 2))
    }

    // --- 5. 点空白处收侧边栏 → 观察 2s 是否弹回 ---
    const sb = await evalJson(`(function(){
      const frame = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({ collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null })
    })()`)
    if (sb.collapsed === false) {
      // 侧边栏展开中：真实点击右侧空白（x=900, y=400）
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 400, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 400, button: 'left', clickCount: 1 })
      await sleep(300)
      const states = []
      for (let i = 0; i < 10; i++) {
        const s = await evalJson(`(function(){
          const frame = document.querySelector('[data-slot="root"] > *')
          return JSON.stringify({
            c: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
            f: document.documentElement.getAttribute('data-meow-smooth-furled'),
            w: Math.round(frame?.getBoundingClientRect().width ?? 0),
          })
        })()`)
        states.push(s)
        await sleep(200)
      }
      console.log('点空白收起后 2s 采样:', JSON.stringify(states))
    }
  }

  void proc
} catch (err) {
  console.log(`探针异常 — ${err.message}`)
} finally {
  try { ws?.close() } catch {}
  try { proc.kill() } catch {}
}
