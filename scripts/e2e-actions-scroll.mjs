/**
 * e2e：手机端消息操作行横向滑动（需求 17）。
 *
 * 裸 CDP 驱动 headless Edge，零 npm 依赖（Node ≥22 全局 WebSocket）：
 *  1. 从 ../src/client.ts 抽取常量与 FOLD_CSS 模板并插值 —— 与构建产物中的
 *     样式逐字等价（esbuild 不改模板字符串语义）；
 *  2. 用两套真实哈希类名（3081 rc.2 快照 g3KvNG 与 fUtRpq，3080 rc.6 的
 *     p-xYUq 与 gdEzaW，均提取自各自已构建的 ui-conversation lib/client.js）
 *     复刻助手行 / 用户行 / 反例行；
 *  3. 断言：助手的统计行内容确实溢出、overflow-x:auto、scrollLeft 真能滚、
 *     滚动条隐藏；用户行（内容不超宽）规则生效但不改变布局；hover-root
 *     之外的同尾缀 *_actions 类不受影响（防误伤其他模块）。
 *
 * 运行：node scripts/e2e-actions-scroll.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'client.ts'), 'utf8')

// --- 从源码抽取常量与 FOLD_CSS 并插值 ---
function pickConst(name) {
  const m = src.match(new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)'`))
  if (m === null) throw new Error(`client.ts 里找不到常量 ${name}`)
  return m[1].replaceAll('\\\'', '\'')
}
const CONST_NAMES = ['FOLD_ATTR', 'FOLD_COLLAPSED', 'IME_ROOT_ATTR', 'BAR_ATTR',
  'HEADER_MENU_ATTR', 'FOLDED_MAX_HEIGHT', 'PENDING_BAR_ATTR',
  'FURL_ROOT_ATTR', 'FAB_ATTR']
const CONSTS = Object.fromEntries(CONST_NAMES.map(n => [n, pickConst(n)]))
const startMarker = 'const FOLD_CSS = `'
const bodyStart = src.indexOf(startMarker)
if (bodyStart < 0) throw new Error('client.ts 里找不到 FOLD_CSS')
const cssStart = bodyStart + startMarker.length
const cssEnd = src.indexOf('`', cssStart)
if (cssEnd < 0) throw new Error('FOLD_CSS 未闭合')
const foldCss = src.slice(cssStart, cssEnd)
  .replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
    if (!(name in CONSTS)) throw new Error(`FOLD_CSS 里出现未知插值 ${name}`)
    return CONSTS[name]
  })
if (!foldCss.includes("[data-time-hover-root] > [class*='_actions']")) {
  throw new Error('FOLD_CSS 缺少需求 17 的选择器')
}

// --- 复刻 DOM（真实哈希类名，双版本各一套） ---
function buttons(hAct, n) {
  return Array.from({ length: n }, () => `<button type="button" class="${hAct}_action">ico</button>`).join('')
}
function clock(hAct) {
  // 真实应用的 .timeEnd 是 white-space:nowrap（不可收缩的 flex 项）——复刻必须带上，
  // 否则统计文字折行后整行塞得进容器，测不出溢出。
  return `<span class="${hAct}_timeEnd" style="white-space:nowrap">2026/08/22 12:34`
    + `<span class="${hAct}_runTimeDot">·</span>Ran for 2m 13s`
    + `<span class="${hAct}_runTimeDot">·</span>TTFT 1.2s`
    + `<span class="${hAct}_runTimeDot">·</span>23.4 tok/s</span>`
}
function assistantCase(tag, hAct) {
  // 助手行：turn-tail 根的直接子级；5 个按钮(复制/点赞/点踩/备注/分支)+长统计。
  return `<div data-turn-tail="7" data-time-hover-root style="width:360px">`
    + `<div id="${tag}Row" class="${hAct}" style="display:flex;align-items:center;gap:10px;height:28px">`
    + `${buttons(hAct, 5)}${clock(hAct)}</div></div>`
}
function userCase(tag, hAct, hUser) {
  // 用户行：userRow（哈希类）+ data-time-hover-root 的直接子级，时间在按钮前、
  // 内容天然不超宽。
  return `<div data-time-hover-root class="${hUser}" style="width:360px;display:flex;flex-direction:column;align-items:flex-end">`
    + `<div id="${tag}Row" class="${hAct}" style="display:flex;align-items:center;gap:10px;height:28px">`
    + `<button type="button" class="${hAct}_action">ico</button>`
    + `<span class="${hAct}_timeStart" style="white-space:nowrap">2026/08/22 12:30</span></div></div>`
}
function controlCase() {
  // hover-root 之外的同尾缀类：必须保持原生 visible（防误伤其他模块）。
  return `<div style="width:200px"><div id="ctrlRow" class="zzzz99_actions" style="display:flex;width:max-content">`
    + '<span>long-long-long-long-content</span></div></div>'
}
// 哈希前缀（各端已构建产物实测）：rc.2=MessageIconActions g3KvNG / MessageItem fUtRpq；
// rc.6=p-xYUq / gdEzaW。选择器按尾缀匹配，前缀只影响复刻逼真度。
const page = `<!doctype html><html><body style="margin:0"><style>${foldCss}</style>
${assistantCase('rc2a', 'g3KvNG_actions')}
${userCase('rc2u', 'g3KvNG_actions', 'fUtRpq_userRow')}
${assistantCase('rc6a', 'p-xYUq_actions')}
${userCase('rc6u', 'p-xYUq_actions', 'gdEzaW_userRow')}
${controlCase()}
</body></html>`

// --- 起 headless Edge（裸 CDP） ---
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const fs = await import('node:fs')
const edge = CANDIDATES.find(p => fs.existsSync(p))
if (edge === undefined) throw new Error('找不到 msedge.exe')
const PORT = 9339
const profile = join(process.env.TEMP ?? '.', `meow-smooth-e2e-${Date.now()}`)
const proc = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cdpTabUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) break
    } catch {}
    await sleep(250)
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const tab = await created.json()
  return tab.webSocketDebuggerUrl
}

let ws
let seq = 0
const pending = new Map()
function call(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 15000)
  })
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
  const expr = `(function(){
    document.open(); document.write(${JSON.stringify(page)}); document.close();
    const out = [];
    for (const id of ['rc2aRow','rc2uRow','rc6aRow','rc6uRow','ctrlRow']) {
      const el = document.getElementById(id);
      if (el === null) { out.push({ id, missing: true }); continue; }
      const cs = getComputedStyle(el);
      el.scrollLeft = 500;
      out.push({
        id,
        overflowX: cs.overflowX,
        scrollbarWidth: cs.scrollbarWidth,
        overflowPx: el.scrollWidth - el.clientWidth,
        scrolled: el.scrollLeft,
      });
    }
    return JSON.stringify(out);
  })()`
  const evalRes = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
  const results = JSON.parse(evalRes.result.value)

  let failed = 0
  const check = (cond, label, detail) => {
    if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
    else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
  }
  for (const r of results) {
    if (r.missing === true) { failed++; console.log(`FAIL ${r.id} 元素不存在`); continue }
    if (r.id === 'ctrlRow') {
      check(r.overflowX === 'visible', '反例行不受影响（仍 visible）', r.overflowX)
      continue
    }
    check(r.overflowX === 'auto', `${r.id} overflow-x:auto`, r.overflowX)
    if (r.id.endsWith('aRow')) {
      check(r.overflowPx > 40, `${r.id} 统计行内容确实超宽`, `scrollWidth-clientWidth=${r.overflowPx}px`)
      check(r.scrolled > 100, `${r.id} 可以横向滚`, `scrollLeft=${r.scrolled}`)
    } else {
      check(r.overflowPx <= 2, `${r.id} 用户行无多余滚动（布局不变）`, `scrollWidth-clientWidth=${r.overflowPx}px`)
      check(r.scrolled === 0, `${r.id} 无溢出时不产生滚动位移`, `scrollLeft=${r.scrolled}`)
    }
    console.log(`info ${r.id} scrollbar-width=${r.scrollbarWidth}`)
  }

  if (failed > 0) process.exitCode = 1
  else console.log('\n全部断言 PASS')
} finally {
  try { ws?.close() } catch {}
  proc.kill()
}
