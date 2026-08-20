/**
 * meow-smooth — 通知 host 模块（需求 15：权限申请 / 提问 / 长任务完成通知）。
 *
 * 职责（零 dsh 本体改动，全部走官方扩展点）：
 *  1. 长任务完成事件：session/event 审计流里 turn/start + tool/call 计数，
 *     turn/end 且工具调用 ≥ 阈值（Config.longTaskToolCalls，默认 7）→ 完成
 *     事件入队（内存，TTL 10 分钟 / cap 20），供 /pending 路由返回
 *     （index.ts 合并进 JSON）→ client 轮询拉取。
 *  2. PWA 资源路由：manifest.json / icon PNG（zlib 手写渐变）/ sw.js
 *     （薄 SW：push → showNotification，notificationclick → 聚焦/打开窗口 +
 *     postMessage 跳转会话；`Service-Worker-Allowed: /` 头放开 scope）——
 *     iOS PWA（添加到主屏幕）与浏览器关闭场景的离线通知通道。
 *  3. Web Push 推送器：审批/提问/完成事件 → web-push 发送（VAPID 签名 +
 *     payload 加密）；404/410 清理失效订阅。VAPID keys 与订阅持久化到
 *     $DSH_HOME/.meow-smooth/（JSON 文件——重启后 VAPID 不变，订阅仍有效）。
 *
 * 结构子集 + ctx.get 动态获取（cordis 严格模式；必需服务由 index.ts 声明）。
 * web-push 为真实运行时依赖（esbuild 打进 lib/index.js，自包含）。
 */
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 一条长任务完成事件（/pending 路由 events 段的 wire 形状）。 */
export interface CompletionEvent {
  /** 稳定去重 id：`sessionId:turn`（client 用 localStorage 记录已通知）。 */
  id: string
  sessionId: string
  toolCalls: number
  at: number
}

/** 推送载荷（SW 端透传 showNotification 参数）。 */
interface PushPayload {
  kind: 'approval' | 'question' | 'completed'
  title: string
  body: string
  tag: string
  sessionId?: string
}

/** host 通知模块配置（cordis patch 的 meow-smooth config 可覆盖）。 */
export interface NotifyHostConfig {
  /** 判定"长任务"的工具调用次数阈值（turn 内 tool/call 数）。 */
  longTaskToolCalls?: number
  /** VAPID keys（不配则自动生成并持久化到 $DSH_HOME/.meow-smooth/）。 */
  vapidPublicKey?: string
  vapidPrivateKey?: string
  /** 通用 webhook 通知 URL（可选）：审批/提问/长任务完成时 POST
   *  JSON { title, body, group, kind, sessionId }。iOS Web Push 被系统 bug
   *  卡死时的替代通道——配 Bark（https://api.day.app/<key>）即可手机
   *  系统通知；任意接收同构 JSON 的服务都可用。失败静默，不影响主链路。 */
  webhookUrl?: string
  /** Bark 通知图标（https URL，如 dsh 插件图标路由）。 */
  webhookIconUrl?: string
  /** Bark 通知点击跳转地址（https URL，如 dsh 的 tailscale 入口）。 */
  webhookAppUrl?: string
}

/** notify-host 对外接口（index.ts 消费）。 */
export interface NotifyHostHandle {
  /** 当前未消费的长任务完成事件（/pending 路由合并返回）。 */
  completionEvents(): CompletionEvent[]
  /** 审批登记时调用（index.ts 的 approval/asked 投影钩子）→ 推送。 */
  pushApproval(info: { sessionId: string; approvalId: string; toolName: string; reason?: string }): void
  /** 页面聚焦上报（index.ts 的 /pending 路由读 x-meow-focus 头调用；
   *  任一页面聚焦时 deliver() 抑制系统通知推送）。 */
  noteFocus(host: string | undefined, focused: boolean): void
}

// --- 常量 ---
const EVENTS_TTL_MS = 10 * 60_000
const EVENTS_CAP = 20
const SUBSCRIPTIONS_CAP = 64
const TITLE_MAX = 20

/** 数据目录：$DSH_HOME/.meow-smooth（fallback ~/.dsh/.meow-smooth）。 */
function dataDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.meow-smooth')
}

/** 从会话事件流推导展示名：优先折叠官方 session/title 事件（last-wins，
 *  与卡片/列表一致），无则回退首个 user/message 文本截断。 */
function sessionTitleFromEvents(events: unknown[] | undefined): string {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: string; data?: { title?: unknown } } | undefined
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
      return event.data.title
    }
  }
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const data = event.data as { content?: readonly { type?: string; text?: string }[] } | undefined
    const text = data?.content
      ?.filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text !== undefined && text !== '') {
      return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text
    }
  }
  return ''
}

/** 手写 PNG（垂直渐变 180×180，indigo → deep indigo），zlib deflate。 */
function pngIcon(): Buffer {
  const size = 180
  const top = [79, 70, 229] // #4F46E5
  const bottom = [49, 46, 129] // #312E81
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1)
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t)
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t)
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t)
    const row = y * (size * 4 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const off = row + 1 + x * 4
      raw[off] = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = 255
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 图标读取：优先 assets/ 静态文件（DeepSeek Harness 官方小鲸鱼图标，
 *  白底），缺失/损坏时 fallback 到手写渐变（pngIcon）。 */
function iconPng(size: 180 | 512): Buffer {
  try {
    return readFileSync(new URL(`../assets/icon-${size}.png`, import.meta.url))
  } catch {
    return pngIcon()
  }
}

/** Service Worker 源码（push → 通知；notificationclick → 聚焦/打开 +
 *  postMessage 给页面跳转目标会话）。push 处理检查聚焦 client：浏览器
 *  窗口正聚焦在 DSH 页面（用户在看着）时不弹系统通知——页面内卡片
 *  气泡负责提醒；窗口失焦（切到其他标签/其他 app，Client.focused=false）
 *  或无可见页面才弹浏览器系统通知。 */
function swSource(): string {
  return [
    '/* meow-smooth service worker: push notification bridge */',
    "self.addEventListener('install', () => { self.skipWaiting() })",
    "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })",
    "self.addEventListener('push', (event) => {",
    '  let data = {}',
    "  try { data = event.data ? event.data.json() : {} } catch { /* non-JSON payload ignored */ }",
    "  const title = data.title || 'dsh'",
    '  event.waitUntil((async () => {',
    "    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })",
    '    const origin = new URL(self.registration.scope).origin',
    "    const focused = clients.some(c => c.focused === true && new URL(c.url).origin === origin)",
    '    if (focused) return',
    '    await self.registration.showNotification(title, {',
    "      body: data.body || '',",
    "      tag: data.tag || 'meow-' + Date.now(),",
    "      icon: '/plugins/meow-smooth/icon-180.png',",
    "      data: { sessionId: data.sessionId || null },",
    "      requireInteraction: data.kind === 'approval' || data.kind === 'question',",
    '    })',
    '  })())',
    '})',
    "self.addEventListener('notificationclick', (event) => {",
    '  event.notification.close()',
    '  const origin = new URL(self.registration.scope).origin',
    '  const sessionId = event.notification.data && event.notification.data.sessionId',
    '  event.waitUntil((async () => {',
    "    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })",
    '    for (const client of windows) {',
    '      if (new URL(client.url).origin !== origin) continue',
    '      await client.focus()',
    "      if (sessionId) client.postMessage({ type: 'meow-smooth:jump', sessionId })",
    '      return',
    '    }',
    '    const win = await self.clients.openWindow(new URL(\'/\', self.registration.scope).href)',
    "    if (sessionId && win) win.postMessage({ type: 'meow-smooth:jump', sessionId })",
    '  })())',
    '})',
  ].join('\n')
}

/** manifest.json 内容（PWA 安装必需；start_url/scope 根路径）。 */
function manifestSource(): string {
  return JSON.stringify({
    name: 'dsh meow',
    short_name: 'dsh',
    display: 'standalone',
    start_url: '/',
    scope: '/',
    icons: [
      { src: '/plugins/meow-smooth/icon-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/plugins/meow-smooth/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  })
}

/**
 * 安装 host 通知模块。
 * @param ctx - 注入的 cordis 上下文（结构子集）。
 * @param config - 插件配置（cordis patch 可覆盖）。
 * @returns 通知模块句柄。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installNotifyHost(ctx: any, config?: NotifyHostConfig): NotifyHostHandle {
  const threshold = typeof config?.longTaskToolCalls === 'number' && config.longTaskToolCalls > 0
    ? config.longTaskToolCalls
    : 7

  // --- 长任务完成事件队列（内存，TTL + cap） ---
  const completions: CompletionEvent[] = []
  /** turn 内工具调用计数：sessionId → { turn, calls }（turn/start 重置）。 */
  const turnCalls = new Map<string, { turn: number; calls: number }>()

  const completionEvents = (): CompletionEvent[] => {
    const cutoff = Date.now() - EVENTS_TTL_MS
    while (completions.length > 0 && completions[0].at < cutoff) completions.shift()
    return completions
  }

/** web-push 运行时 API（CJS 模块；ESM-CJS interop 下 API 在 default 上）。 */
interface WebPushMod {
  generateVAPIDKeys(): { publicKey: string; privateKey: string }
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void
  sendNotification(subscription: unknown, payload: string, options?: { TTL?: number }): Promise<unknown>
}

  // --- VAPID keys（config 优先，否则文件生成/读取） ---
  // web-push 是 CJS（内部 require('crypto')），esbuild 打进 ESM bundle 会
  // 产生动态 require 崩溃（实测）→ 运行时动态 import，Node 的 ESM-CJS
  // interop 在 CJS 上下文里 require 内置模块正常；API 在 default 上
  // （cjs-module-lexer 对 web-push 的导出模式不产生命名导出，实测）。
  let pushMod: WebPushMod | undefined
  let vapidPublicKey: string | undefined = config?.vapidPublicKey
  let vapidPrivateKey: string | undefined = config?.vapidPrivateKey
  let pushReady: Promise<boolean> | undefined
  const ensurePush = (): Promise<boolean> => {
    pushReady ??= (async () => {
      try {
        const imported = await import('web-push') as { default?: WebPushMod } & WebPushMod
        const mod = imported.default ?? imported
        if (vapidPublicKey === undefined || vapidPrivateKey === undefined) {
          const dir = dataDir()
          const file = join(dir, 'vapid.json')
          if (existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, 'utf8')) as { publicKey?: string; privateKey?: string }
            vapidPublicKey = saved.publicKey
            vapidPrivateKey = saved.privateKey
          }
        }
        if (vapidPublicKey === undefined || vapidPrivateKey === undefined) {
          const keys = mod.generateVAPIDKeys()
          vapidPublicKey = keys.publicKey
          vapidPrivateKey = keys.privateKey
          mkdirSync(dataDir(), { recursive: true })
          writeFileSync(join(dataDir(), 'vapid.json'), JSON.stringify(keys, null, 2), 'utf8')
        }
        // subject 不能是 localhost——Apple APNs 明确拒绝 localhost subject
        // （web-push 会 warn "will result in a BadJwtToken error"，实测 403
        // BadJwtToken）。用仓库 URL 作合法 subject（2026-08-20 实测修复）。
        mod.setVapidDetails('https://github.com/Phant0Meow/dsh-meow-smooth', vapidPublicKey, vapidPrivateKey)
        pushMod = mod
        return true
      } catch (error) {
        console.warn(`[meow-smooth] web push unavailable: ${String(error).slice(0, 160)}`)
        return false
      }
    })()
    return pushReady
  }
  const pushEnabled = (): boolean => pushMod !== undefined

  // --- 订阅持久化（文件 JSON 数组，按 endpoint 去重） ---
  const subscriptionsFile = join(dataDir(), 'subscriptions.json')
  let subscriptions: { endpoint: string; keys?: { p256dh?: string; auth?: string }; expirationTime?: number | null }[] = []
  /** 客户端诊断上报队列（iOS 真机无 console：client 权限链路状态 POST 到
   *  /diag-log，服务器侧 GET /diag 查看；上限 100 条防泄漏）。 */
  const diagLog: { at: number; msg: string }[] = []
  try {
    if (existsSync(subscriptionsFile)) {
      const parsed = JSON.parse(readFileSync(subscriptionsFile, 'utf8'))
      if (Array.isArray(parsed)) subscriptions = parsed.slice(0, SUBSCRIPTIONS_CAP)
    }
  } catch {
    subscriptions = []
  }
  const saveSubscriptions = (): void => {
    try {
      mkdirSync(dataDir(), { recursive: true })
      writeFileSync(subscriptionsFile, JSON.stringify(subscriptions.slice(0, SUBSCRIPTIONS_CAP), null, 2), 'utf8')
    } catch {
      // 持久化失败仅影响重启后的订阅复用；内存副本继续工作。
    }
  }

  /** 页面聚焦感知：client 轮询 /pending 时带 x-meow-focus 头（1=页面
   *  聚焦）。按 Host 记录（localhost 与 127.0.0.1 是不同 origin，各自
   *  上报；SW 层无法跨 origin 感知，host 层统一判定）。聚焦窗口 8s 内
   *  抑制 Web Push（用户在 DSH 页面时卡片气泡负责提醒，不弹系统通知）。 */
  const FOCUS_WINDOW_MS = 8000
  const focusedByHost = new Map<string, number>()
  const noteFocus = (host: string | undefined, focused: boolean): void => {
    if (typeof host !== 'string' || host === '') return
    if (focused) focusedByHost.set(host, Date.now())
    else focusedByHost.delete(host)
  }
  const anyFocusedRecently = (): boolean => {
    const cutoff = Date.now() - FOCUS_WINDOW_MS
    for (const [host, at] of focusedByHost) {
      if (at >= cutoff) return true
      focusedByHost.delete(host) // 过期清理
    }
    return false
  }

  /** 向全部订阅推送一条通知（payload 加密；404/410 清失效订阅）。
   *  @returns 是否至少一个订阅送达（true=有订阅且发送无异常；false=
   *  无订阅或全部失败——调用方据此决定 webhook 兜底）。 */
  const sendPush = async (payload: PushPayload): Promise<boolean> => {
    if (!(await ensurePush()) || subscriptions.length === 0) return false
    let delivered = false
    const body = JSON.stringify(payload)
    for (const sub of subscriptions) {
      try {
        await pushMod!.sendNotification(sub as never, body, { TTL: 3600 })
        delivered = true
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          subscriptions = subscriptions.filter(item => item.endpoint !== sub.endpoint)
          saveSubscriptions()
        } else {
          console.warn(`[meow-smooth] push failed (${status ?? 'unknown'}): ${String(error).slice(0, 160)}`)
        }
      }
    }
    return delivered
  }

  /** 发送决策：任一 DSH 页面聚焦（用户在看着）→ 不推 Web Push 也不发
   *  webhook（卡片气泡负责提醒，避免打扰）；无聚焦页面 → Web Push 优先，
   *  无订阅/全部失败才走 webhook（Bark 兜底）。 */
  const deliver = async (payload: PushPayload): Promise<void> => {
    if (anyFocusedRecently()) return
    const delivered = await sendPush(payload)
    if (!delivered) sendWebhook(payload)
  }

  /** 通用 webhook 通道（Bark 等）：POST { title, body, group, icon?, url?,
   *  kind, sessionId }；未配置或失败静默。group 供 Bark 通知分组折叠；
   *  icon/url 由 webhookIconUrl/webhookAppUrl 配置（Bark 支持通知图标与
   *  点击跳转）。 */
  const webhookUrl = config?.webhookUrl
  const webhookIconUrl = config?.webhookIconUrl
  const webhookAppUrl = config?.webhookAppUrl
  const sendWebhook = (payload: PushPayload): void => {
    if (typeof webhookUrl !== 'string' || webhookUrl === '') return
    try {
      const body: Record<string, unknown> = { ...payload, group: 'dsh' }
      if (typeof webhookIconUrl === 'string' && webhookIconUrl !== '') body.icon = webhookIconUrl
      if (typeof webhookAppUrl === 'string' && webhookAppUrl !== '') body.url = webhookAppUrl
      void fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => { /* webhook 失败静默 */ })
    } catch {
      // webhook 失败静默
    }
  }

  // --- 会话标题缓存（sessionId → 首个用户消息截断） ---
  const titleCache = new Map<string, string>()
  const sessionTitle = (sessionId: string): string => {
    const cached = titleCache.get(sessionId)
    if (cached !== undefined) return cached
    let title = ''
    try {
      const session = ctx?.sessions?.get?.(sessionId)
      title = sessionTitleFromEvents(session?.events)
    } catch {
      title = ''
    }
    titleCache.set(sessionId, title)
    return title
  }

/** 发送去重表（挂 globalThis：热重载会产生新旧两个模块实例，闭包级
 *  Map 各自独立互不去重——全局表让同事件 3s 内跨实例只发一次）。 */
const PUSH_DEDUP_KEY = '__meow_smooth_push_dedup__'
const recentPushes = (
  (globalThis as Record<string, unknown>)[PUSH_DEDUP_KEY] as Map<string, number> | undefined
) ?? new Map<string, number>()
;(globalThis as Record<string, unknown>)[PUSH_DEDUP_KEY] = recentPushes

/** 发送去重（防热重载残留监听器双发）：key 3s 内已发过则跳过。
 *  审批投影侧有 pending.has 防重，这里补提问/长任务的幂等。 */
const pushOnce = (key: string, fn: () => void): void => {
  const now = Date.now()
  const last = recentPushes.get(key)
  if (last !== undefined && now - last < 3000) return
  recentPushes.set(key, now)
  if (recentPushes.size > 200) {
    const cutoff = now - 60_000
    for (const [k, at] of recentPushes) {
      if (at < cutoff) recentPushes.delete(k)
    }
  }
  fn()
}

  // --- 长任务检测 + 提问检测（session/event 审计流） ---
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session: any, event: any) => {
      try {
        const sessionId: string = session?.id ?? ''
        if (sessionId === '') return
        const data = event?.data
        if (event?.type === 'turn/start') {
          turnCalls.set(sessionId, { turn: data?.turn ?? 0, calls: 0 })
          return
        }
        if (event?.type === 'tool/call') {
          const current = turnCalls.get(sessionId)
          if (current !== undefined && (data?.turn === undefined || data.turn === current.turn)) {
            current.calls += 1
          }
          // 提问检测：ask_user_question 工具调用即真实提问（question 无审计事件）。
          if (data?.name === 'ask_user_question') {
            const callId: string = data.callId ?? ''
            const title = sessionTitle(sessionId)
            const payload: PushPayload = {
              kind: 'question',
              title: title === '' ? '未命名会话' : title,
              body: '有提问待回答，点击查看…',
              tag: `q:${sessionId}:${callId}`,
              sessionId,
            }
            pushOnce(`q:${sessionId}:${callId}`, () => { void deliver(payload) })
          }
          return
        }
        if (event?.type === 'turn/end') {
          const current = turnCalls.get(sessionId)
          if (current === undefined) return
          turnCalls.delete(sessionId)
          if (current.calls < threshold) return
          const item: CompletionEvent = {
            id: `${sessionId}:${current.turn}`,
            sessionId,
            toolCalls: current.calls,
            at: Date.now(),
          }
          completions.push(item)
          if (completions.length > EVENTS_CAP) completions.shift()
          const title = sessionTitle(sessionId)
          const payload: PushPayload = {
            kind: 'completed',
            title: title === '' ? '未命名会话' : title,
            body: `任务完成（${current.calls} 次工具调用），点击查看…`,
            tag: `c:${item.id}`,
            sessionId,
          }
          pushOnce(`c:${item.id}`, () => { void deliver(payload) })
        }
      } catch {
        // 检测失败静默：不影响审批投影等既有链路。
      }
    })
  }

  // --- PWA 资源 + 订阅路由 ---
  const icon180 = iconPng(180)
  const icon512 = iconPng(512)
  const sw = swSource()
  const manifest = manifestSource()
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const routes: { kind: 'exact'; path: string; handler: (req: unknown, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string | Buffer) => void }) => void }[] = [
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/manifest.json',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(manifest)
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/icon-180.png',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
          res.end(icon180)
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/icon-512.png',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' })
          res.end(icon512)
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/sw.js',
        handler: (_req, res) => {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            // 放开 SW scope 到根路径（文件本身在 /plugins/ 下）。
            'service-worker-allowed': '/',
            'cache-control': 'no-store',
          })
          res.end(sw)
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/push-config',
        handler: (_req, res) => {
          void ensurePush().then((enabled) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(enabled && vapidPublicKey !== undefined
              ? { enabled: true, publicKey: vapidPublicKey }
              : { enabled: false }))
          })
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/push-subscribe',
        handler: (req: unknown, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if ((req as { method?: string })?.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"error":"method not allowed"}')
            return
          }
          let raw = ''
          ;(req as { on?: (event: string, cb: (chunk: Buffer) => void) => void })?.on?.('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
          ;(req as { on?: (event: string, cb: () => void) => void })?.on?.('end', () => {
            try {
              const sub = JSON.parse(raw) as { endpoint?: string }
              if (typeof sub.endpoint !== 'string' || sub.endpoint === '') {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end('{"error":"bad subscription"}')
                return
              }
              subscriptions = subscriptions.filter(item => item.endpoint !== sub.endpoint)
              subscriptions.push(sub)
              saveSubscriptions()
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"ok":true}')
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"error":"bad json"}')
            }
          })
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/diag-log',
        handler: (req: unknown, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if ((req as { method?: string })?.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"error":"method not allowed"}')
            return
          }
          let raw = ''
          ;(req as { on?: (event: string, cb: (chunk: Buffer) => void) => void })?.on?.('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
          ;(req as { on?: (event: string, cb: () => void) => void })?.on?.('end', () => {
            try {
              const body = JSON.parse(raw) as { msg?: string }
              if (typeof body.msg === 'string' && body.msg !== '') {
                diagLog.push({ at: Date.now(), msg: body.msg.slice(0, 200) })
                if (diagLog.length > 100) diagLog.splice(0, diagLog.length - 100)
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"ok":true}')
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end('{"error":"bad json"}')
            }
          })
        },
      },
      {
        kind: 'exact',
        path: '/plugins/meow-smooth/diag',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ diag: diagLog }))
        },
      },
    ]
    for (const route of routes) {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => webServer.register(route), `meow-smooth: ${route.path}`)
      } else {
        webServer.register(route)
      }
    }
    // PWA 安装链接（manifest + apple-touch-icon）注入 index.html。
    if (typeof webServer.tapIndex === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => webServer.tapIndex((html: string) => {
        const links = '<link rel="manifest" href="/plugins/meow-smooth/manifest.json">'
          + '<link rel="apple-touch-icon" href="/plugins/meow-smooth/icon-180.png">'
        // 幂等：已注入过本插件的 manifest 就不再重复。
        // 坑：官方 index.html 自带 <link rel="manifest" href="/manifest.webmanifest">
        // （仅 SVG icon，iOS 不支持 SVG 图标）——旧逻辑见 rel="manifest" 就跳过，
        // 导致插件 manifest（PNG icon + standalone）与 apple-touch-icon 从未注入，
        // iOS 添加主屏幕得到的是普通快捷方式（无 Web Push 资格、无通知授权）。
        // 修复：无条件把插件链接插到 <head> 最前（规范：首个 rel="manifest" 生效）。
        if (html.includes('/plugins/meow-smooth/manifest.json')) return html
        return html.replace('<head>', `<head>${links}`)
      }), 'meow-smooth: pwa manifest tap')
    }
  }

  return {
    completionEvents,
    noteFocus,
    pushApproval(info) {
      const title = sessionTitle(info.sessionId)
      const payload: PushPayload = {
        kind: 'approval',
        title: title === '' ? '未命名会话' : title,
        body: '有权限申请待处理，点击查看…',
        tag: `a:${info.approvalId}`,
        sessionId: info.sessionId,
      }
      pushOnce(`a:${info.approvalId}`, () => { void deliver(payload) })
    },
  }
}
