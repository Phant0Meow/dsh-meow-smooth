/**
 * e2e：运行失败通知（host 端逻辑）。
 *
 * 直接加载 src/notify-host.ts（Node 22 type stripping），用 stub ctx 捕获
 * session/event 监听器，合成审计事件驱动，并起一个本地 webhook 收包验证
 * 完整投递决策链（无聚焦上报 → Web Push 无订阅 → webhook 兜底）。
 *
 * 断言：
 *  1. 长任务完成（≥阈值）→ 事件无 kind（旧 wire 形状兼容）+ webhook 'completed'
 *  2. 回合失败（无 turn/start 的未跟踪会话也算）→ kind:'failed' + message/code
 *     + webhook 'failed'（body 含摘要）
 *  3. aborted/blocked/max-tokens/interrupted 终结 → 不入队不推送
 *  4. llm/retry 事件（单步内自动重试）→ 不入队
 *  5. 超长失败消息截断到 120+…
 *  6. 失败事件 id 形如 sessionId:turn:error（client localStorage 去重键稳定）
 *
 * 运行：node --experimental-strip-types scripts/e2e-notify-error.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

process.on('unhandledRejection', e => console.log('UNHANDLED REJECTION:', e))

// 数据目录隔离：必须在 import 模块之前设置（dataDir() 每次读环境变量，
// 但提前设干净利落，绝不碰真实 ~/.dsh/.meow-smooth）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'meow-notify-e2e-'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

// --- 本地 webhook 收包 ---
const payloads = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    try { payloads.push(JSON.parse(raw)) } catch {}
    res.writeHead(200); res.end('ok')
  })
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port

// --- 加载被测模块（type stripping 直跑 TS 源） ---
const { installNotifyHost } = await import('../src/notify-host.ts')

let captured = null
const ctx = {
  on(type, fn) { if (type === 'session/event') captured = fn; return () => {} },
  effect() {},
}
const handle = installNotifyHost(ctx, {
  longTaskToolCalls: 7,
  webhookUrl: `http://127.0.0.1:${port}/bark`,
})
if (captured === null) throw new Error('session/event 监听器未被注册')

const emit = (sessionId, type, data) => captured({ id: sessionId }, { type, data })

// 1. 长任务完成（9 次调用 ≥ 阈值）
emit('s1', 'turn/start', { turn: 1 })
for (let i = 0; i < 9; i++) emit('s1', 'tool/call', { turn: 1, name: 'pwsh', callId: `c${i}` })
emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

// 2. 回合失败：没有 turn/start 的"未跟踪"回合（热重载/中途装配场景）
emit('s2', 'turn/end', {
  turn: 5,
  reason: { kind: 'error', error: { message: 'JSON error injected into SSE stream', code: 'PI_AI_ERROR' } },
})

// 3. 非错误终结：aborted / blocked / max-tokens / interrupted → 不通知
emit('s3', 'turn/start', { turn: 1 })
emit('s3', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
emit('s4', 'turn/start', { turn: 1 })
emit('s4', 'turn/end', { turn: 1, reason: { kind: 'blocked' } })
emit('s5', 'turn/start', { turn: 1 })
emit('s5', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
emit('s6', 'turn/end', { turn: 9, reason: { kind: 'interrupted' } })

// 4. 单步内自动重试：llm/retry 事件流经监听器 → 必须无感
emit('s7', 'llm/retry', { retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 800, failure: { message: 'boom', code: 'ECONNRESET' } })

// 5. 超长失败消息 → 截断 120+…
const longMsg = '很长的错误'.repeat(60)
emit('s8', 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: longMsg, code: 'UNKNOWN' } } })

// 等 deliver() 异步链走完：首次 deliver 触发 web-push 动态 import + VAPID
// 生成/加载（冷启动可超 400ms），给足余量。
for (let i = 0; i < 20 && payloads.length < 3; i++) await sleep(200)

// --- 断言 ---
let failed = 0
const check = (cond, label, detail) => {
  if (cond) console.log(`PASS ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  else { failed++; console.log(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}

const queue = handle.completionEvents()
const byId = new Map(queue.map(e => [e.id, e]))

check(queue.some(e => e.id === 's1:1' && e.kind === undefined && e.toolCalls === 9),
  '长任务完成事件保持旧 wire 形状（kind 缺省）')
check(byId.get('s2:5:error')?.kind === 'failed', '失败事件 kind=failed',
  JSON.stringify(byId.get('s2:5:error')))
check(byId.get('s2:5:error')?.message === 'JSON error injected into SSE stream'
  && byId.get('s2:5:error')?.code === 'PI_AI_ERROR', '失败事件携带 message 与 code')
check(!queue.some(e => ['s3', 's4', 's5', 's6'].some(p => e.id.startsWith(`${p}:`))),
  'aborted/blocked/max-tokens/interrupted 不入队')
check(!queue.some(e => e.id.startsWith('s7')), 'llm/retry（自动重试）不入队')

const trunc = byId.get('s8:2:error')?.message
check(typeof trunc === 'string' && trunc.length === 121 && trunc.endsWith('…'),
  '超长失败消息截断为 120 字符+省略号', `len=${trunc?.length}`)

check(payloads.some(p => p.kind === 'completed'), 'webhook 收到 completed 推送')
const failPush = payloads.find(p => p.kind === 'failed')
check(failPush !== undefined, 'webhook 收到 failed 推送', JSON.stringify(failPush))
check(failPush !== undefined && failPush.body.includes('JSON error injected into SSE stream'),
  'failed 推送 body 含失败摘要')
check(failPush !== undefined && failPush.tag === 'f:s2:5:error', 'failed 推送 tag 稳定可去重')
const longPush = payloads.find(p => p.sessionId === 's8')
check(longPush !== undefined && longPush.body.length <= 140, '超长摘要的推送 body 已受控',
  `len=${longPush?.body.length}`)

server.close()
if (failed > 0) process.exitCode = 1
else console.log('\n全部断言 PASS')
