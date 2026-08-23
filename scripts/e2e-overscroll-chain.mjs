/**
 * e2e：橡皮筋抑制 v2（链式判定）+ 触屏宽表常开横滚。
 *
 * 背景（2026-08-22 表格竖滑修复）：v1 只认"最近一个"可滚动祖先且排除
 * body/html ——起点落在静止态 overflow-x:hidden 的宽表包装层里时链上无
 * 可滚节点，所有 touchmove 被无脑拦截，页面竖滑被吞；代码块等 x 向容器
 * 同理误伤。v2 收集全部可滚动祖先（含 scrollingElement），任一环节能消费
 * 手势方向即放行；触屏设备宽表经 @media (hover:none) 常开横滚。
 *
 * 方法：从 ../src/client.ts 抽取真实的两个触摸处理函数（esbuild TS 转译）
 * 与 FOLD_CSS，注入含真实构建产物表格规则的测试页，CDP 发真实触摸序列：
 *   A. 表格 td 文字/td 空白/wrapper 空白 三处起手竖滑 → 页面必须滚动（v1 全吞）
 *   B. 代码块上起手竖滑 → 页面必须滚动
 *   H. 触屏模拟（hover:none）下横向滑宽表 → 表格横滚（CSS 常开生效）
 *   R. 页面顶部向下回弹手势 → scrollY 保持 0（防回弹初衷保留）
 *
 * 运行：node scripts/e2e-overscroll-chain.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.ts'), 'utf8')

// --- 抽 FOLD_CSS（同 e2e-actions-scroll 的插值法） ---
function pickConst(name) {
  const m = src.match(new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)'`))
  if (m === null) throw new Error(`client.ts 里找不到常量 ${name}`)
  return m[1].replaceAll('\\\'', '\'')
}
const CONST_NAMES = ['FOLD_ATTR', 'FOLD_COLLAPSED', 'IME_ROOT_ATTR', 'BAR_ATTR',
  'HEADER_MENU_ATTR', 'FOLDED_MAX_HEIGHT', 'PENDING_BAR_ATTR']
const CONSTS = Object.fromEntries(CONST_NAMES.map(n => [n, pickConst(n)]))
const cssStart = src.indexOf('const FOLD_CSS = `') + 'const FOLD_CSS = `'.length
const cssEnd = src.indexOf('`', cssStart)
const foldCss = src.slice(cssStart, cssEnd)
  .replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
    if (!(name in CONSTS)) throw new Error(`未知插值 ${name}`)
    return CONSTS[name]
  })
if (!foldCss.includes('@media (hover: none)')) throw new Error('FOLD_CSS 缺少宽表常开规则')

// --- 抽真实的橡皮筋抑制处理函数（TS → JS） ---
const jsStart = src.indexOf('let lastTouchX = 0')
const jsEnd = src.indexOf('/** 悬浮条元素', jsStart) // 从 jsStart 起找——头注释里也有同词
if (jsStart < 0 || jsEnd < 0 || jsEnd <= jsStart) throw new Error('client.ts 里定位不到橡皮筋函数区')
const meowJs = (await esbuild.transform(src.slice(jsStart, jsEnd), { loader: 'ts' })).code

// --- 真实构建产物里的表格规则（3080/3081 同一前端构建哈希） ---
const built = readFileSync('D:\\myFiles\\dsh\\dsh-official-npm\\node_modules\\@deepseek-ai\\dsh-web-frontend\\dist\\assets\\index-C6eRlFa6.css', 'utf8')
const m = built.match(/(\._[\w]+_\d+)\{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain\}/)
if (m === null) throw new Error('构建产物里找不到 tableScroll 规则')
const TS_CLS = m[1].slice(1)
const tableRules = [
  ...built.matchAll(new RegExp(`[^{}]*${TS_CLS}[^{}]*\\{[^}]*\\}`, 'g')),
  ...built.matchAll(/[^{}]*md-table-wide[^{}]*\{[^}]*\}/g),
].map(x => x[0])
console.log(`tableScroll=${TS_CLS}，抽规则 ${tableRules.length} 条`)

const CELLS = (rows, cols, tag) => Array.from({ length: rows }, (_, r) =>
  `<tr>${Array.from({ length: cols }, (_, i) =>
    `<td style="border:1px solid #eee" data-cell="${tag}r${r}c${i}">文${r}${i}</td>`).join('')}</tr>`).join('')
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>${tableRules.join('\n')}
${foldCss}
body{margin:0;font:14px sans-serif;height:3000px}
.wrap{width:343px;margin:16px auto}
${TS_CLS} table{border-collapse:collapse}
td,th{padding:10px 16px}
</style></head><body>
<div style="height:120px"></div>
<div class="wrap"><div id="tblA" class="${TS_CLS} md-table-wide">
<table><thead><tr>${Array.from({ length: 6 }, (_, i) => `<th>列头${i}</th>`).join('')}</tr></thead>
<tbody>${CELLS(10, 6, 'A')}</tbody></table></div></div>
<div class="wrap"><div id="tblB" class="${TS_CLS} md-table-wide">
<table style="min-width:0"><thead><tr>${Array.from({ length: 4 }, (_, i) => `<th style="min-width:56px;width:56px">列${i}</th>`).join('')}</tr></thead>
<tbody>${CELLS(4, 4, 'B')}</tbody></table></div></div>
<div class="wrap"><pre id="code" style="margin:0;overflow-x:auto;background:#f5f5f5;padding:8px">very-long-code-line-that-overflows-the-container-width-for-sure-1234567890</pre></div>
<div style="height:600px"></div>
<script>${meowJs}<\/script>
</body></html>`

// --- CDP 起 headless Edge ---
const CANDIDATES = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
const fs = await import('node:fs')
const edge = CANDIDATES.find(p => fs.existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9345
const profile = join(process.env.TEMP ?? '.', `meow-os-e2e-${Date.now()}`)
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch {}; await sleep(250) }
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let seq = 0; const pending = new Map()
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error !== undefined ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
}
const call = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)) } }, 15000)
  })
}
await call('Runtime.enable')

async function evalJson(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true })
  return JSON.parse(r.result.value)
}
async function reset() {
  await call('Runtime.evaluate', { expression: 'scrollTo(0,0); for (const id of ["tblA","tblB","code"]) document.getElementById(id).scrollLeft = 0' })
  await sleep(60)
}
async function swipe(x, y, dxStep, dyStep, steps = 8) {
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  let cx = x, cy = y
  for (let i = 0; i < steps; i++) {
    cx += dxStep; cy += dyStep
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy }] })
    await sleep(24)
  }
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(100)
}

try {
  await call('Runtime.evaluate', { expression: `(function(){document.open();document.write(${JSON.stringify(page)});document.close()})()` })
  await sleep(150)
  // 触屏模拟：让 (hover:none) 媒体查询命中（桌面 headless 默认 hover:hover）
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await sleep(100)
  const env = await evalJson(`JSON.stringify({
    vh: innerHeight,
    hoverNone: matchMedia('(hover: none)').matches,
    aRect: (() => { const r = document.getElementById('tblA').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })(),
    ovXA: getComputedStyle(document.getElementById('tblA')).overflowX,
    bW: Math.round(document.getElementById('tblB').getBoundingClientRect().width),
    bTableW: Math.round(document.querySelector('#tblB table').getBoundingClientRect().width),
  })`)
  console.log('环境:', env)

  let failed = 0
  const check = (cond, label, detail) => {
    if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
    else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
  }

  // --- A: 三处起手竖滑都必须滚页面 ---
  const cellPt = await evalJson(`JSON.stringify((() => {
    const td = document.querySelector('#tblA td');
    const r = td.getBoundingClientRect();
    return { text: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      blank: { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) } }
  })())`)
  for (const [label, pt] of [['td 文字', cellPt.text], ['td 空白', cellPt.blank]]) {
    await reset()
    const b = await evalJson('scrollY')
    await swipe(pt.x, pt.y, 0, -18)
    const a = await evalJson('scrollY')
    check(a - b > 40, `竖滑@宽表 ${label} → 页面滚动（修复主目标）`, `Δ${a - b}px`)
  }
  // wrapper 空白：tblB 表格比容器窄（56×4+边框 < 343），右侧空区直接落在 #tblB 上
  {
    await reset()
    const pt = await evalJson(`JSON.stringify((() => {
      const w = document.getElementById('tblB').getBoundingClientRect();
      const t = document.querySelector('#tblB table').getBoundingClientRect();
      return { x: Math.round(t.right + (w.right - t.right) / 2), y: Math.round(w.top + 20) }
    })())`)
    const b = await evalJson('scrollY')
    await swipe(pt.x, pt.y, 0, -18)
    const a = await evalJson('scrollY')
    check(a - b > 40, '竖滑@宽表 wrapper 空白 → 页面滚动', `Δ${a - b}px @(${pt.x},${pt.y})`)
  }
  // --- B: 代码块上竖滚 ---
  {
    await reset()
    const pt = await evalJson(`JSON.stringify((() => {
      const r = document.getElementById('code').getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }
    })())`)
    const b = await evalJson('scrollY')
    await swipe(pt.x, pt.y, 0, -18)
    const a = await evalJson('scrollY')
    check(a - b > 40, '竖滑@代码块 → 页面滚动（x 向容器不吞竖滑）', `Δ${a - b}px`)
  }
  // --- H: 触屏下横滑宽表（hover:none 常开 auto）---
  if (env.hoverNone) {
    await reset()
    const sl0 = await evalJson('document.getElementById("tblA").scrollLeft')
    await swipe(cellPt.text.x, cellPt.text.y, -18, 0)
    const sl1 = await evalJson('document.getElementById("tblA").scrollLeft')
    check(sl1 - sl0 > 40, '横滑@宽表 → 表格横滚（hover:none 常开生效）', `${sl0}→${sl1}, overflow-x=${env.ovXA}`)
    check(env.ovXA === 'auto', '静止态 overflow-x 已是 auto（不再依赖 hover）', env.ovXA)
  } else {
    console.log('SKIP 横滑断言（触屏模拟未命中 hover:none）')
  }
  // --- R: 页面顶部的回弹抑制仍在 ---
  {
    await reset()
    const b = await evalJson('scrollY')
    await swipe(env.aRect ? 200 : 200, 300, 0, 25) // 向下滑（dy>0）＝顶部越界方向
    const a = await evalJson('scrollY')
    check(a === b && a === 0, '页面顶部向下滑被拦（防回弹保留）', `scrollY=${a}`)
  }

  if (failed > 0) process.exitCode = 1
  else console.log('\n全部断言 PASS')
} finally {
  ws.close(); try { proc.kill() } catch {}
}
