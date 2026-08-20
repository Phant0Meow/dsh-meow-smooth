/**
 * meow-smooth — 喵丝滑（host 端）。
 *
 * 纯 client 行为增强插件：浏览器端逻辑见 src/client.ts。
 * host 侧职责（需求 12：手机端 pending 权限申请任何时刻可见）：
 *
 * 1. 审批审计投影：监听会话审计流——approval/asked 登记 pending、
 *    approval/decided 移除；启动时扫描已挂会话的事件恢复未决项。
 *    覆盖 apiproxy 的覆盖盲区：它的 pending 是进程内存，host 重启即丢
 *    （mux replay 无从重放），而审计日志里"asked 无 decided"的项就是
 *    上次运行中断留下的未决审批。
 * 2. reason 观察者：approval/request waterfall 纯观察（必须 next()
 *    放行，绝不干预审批链），在 approval/asked 登记后按
 *    (sessionId, callId) 补上 reason（reason 不进审计事件）。
 * 3. 只读状态路由 GET /plugins/meow-smooth/pending：返回全部未决审批的
 *    细节（toolName/reason/callId/command/askedAt/orphan），client
 *    端轮询用。只读聚合，无任何写操作。
 */

/** 一条投影出的未决审批（结构子集，字段以 dsh-user-approval 审计事件
 *  契约为准；不 import 宿主包——esbuild 全量打进 bundle 会复制一份
 *  cordis 类导致双实例冲突）。 */
interface PendingApprovalView {
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  askedAt: number
  /** host 重启后从审计恢复的项：apiproxy 已无对应 rpcId，无法应答。 */
  orphan: boolean
}

/** 一条投影出的未决提问（key=callId）。提问无专用审计事件（只有 approval
 *  有 asked/decided 对），从 tool/call(ask_user_question) 登记、
 *  tool/result(message.source.callId 配对) 移除——审计日志持久，host
 *  重启/客户端断线重连后仍可恢复（client 帧链路的权威兜底：client 的
 *  pendingInteractions 断线清空后靠 mux 重放恢复，iOS 丢帧即永久缺失）。 */
interface PendingQuestionView {
  sessionId: string
  callId: string
  askedAt: number
  /** plan-review 呈现意图（questions 里任一 intent.kind === 'plan-review'）。 */
  planReview: boolean
  /** host 重启后从审计恢复的项：apiproxy 已无对应 rpcId，无法应答。 */
  orphan: boolean
}

import { installNotifyHost } from './notify-host.ts'
import { startCompressProxy, resolveTargetPort } from './compress-proxy.ts'

/** 插件名（loader 诊断用；与 cordis.patch.yml 的 name 一致）。 */
export const name = 'meow-smooth'

/** 必需服务声明：sessions 由 client-runtime 提供（dsh-femwa 同款声明）。
 *  实测：inject 非空时 ctx.get 才能命中服务 store（空数组/无 inject 的
 *  fiber 拿不到 webServer/sessions——cordis 装配形态差异）。webServer
 *  保持 ctx.get 动态获取（可选，未注册时降级）。 */
export const inject = ['sessions']

/** 插件配置（cordis.patch.yml 可覆盖；通知模块消费 longTaskToolCalls 与
 *  vapid keys，其余字段兼容既有配置）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Config extends Record<string, any> {
  /** 判定"长任务"的工具调用次数阈值（turn 内 tool/call 数，默认 7）。 */
  longTaskToolCalls?: number
  /** Web Push VAPID 公钥（不配则自动生成并持久化）。 */
  vapidPublicKey?: string
  /** Web Push VAPID 私钥（不配则自动生成并持久化）。 */
  vapidPrivateKey?: string
  /** 压缩代理（手机访问加速，默认关闭）：port=代理监听端口（默认 8444）；
   *  targetPort 自动从 dsh --port 解析。开启后把 tailscale serve 等反代
   *  指向 127.0.0.1:<port>。零 dsh 本体改动，见 src/compress-proxy.ts。 */
  proxy?: {
    enabled?: boolean
    port?: number
    targetPort?: number
  }
}

/** Host loader entry for the browser-only fold plugin. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any, config?: Config): void {
  // cordis 严格模式：ctx.<service> 属性必须经 inject 声明；可选服务用
  // ctx.get(name) 读全局 store（未注册返回 undefined → 对应能力降级）。
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  // 通知模块（需求 15）：长任务完成队列 + PWA 资源 + Web Push 推送器。
  const notify = installNotifyHost(ctx, config)
  // 压缩代理（config.proxy.enabled，默认关闭）：手机访问加速，零本体改动。
  // targetPort 自动从 dsh --port 解析；随插件 fiber 销毁（热重载/卸载即停）。
  const proxyCfg = config?.proxy
  if (proxyCfg?.enabled === true) {
    const server = startCompressProxy({
      port: proxyCfg.port ?? 8444,
      targetPort: proxyCfg.targetPort ?? resolveTargetPort(),
    })
    if (typeof ctx.effect === 'function') {
      // cordis effect 语义：execute 立即执行，返回的 disposer 在 fiber 卸载时
      // 调用（热重载/卸载即停）。把关闭逻辑放进返回的 disposer。
      ctx.effect(() => () => {
        server.close()
        // Node 18.2+：强制断开残留连接，避免热重载时代理端口滞留。
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      }, 'meow-smooth: compress proxy')
    }
  }
  const pending = new Map<string, PendingApprovalView>()
  const pendingQuestions = new Map<string, PendingQuestionView>()
  /** 待消费的 reason 观察记录：key = `sessionId|callId`。approval/request
   *  在 approval/asked append 后的微任务 dispatch，asked 事件先到、登记
   *  pending，随后观察者补 reason；消费即删。带时间戳，定期清理防泄漏。 */
  const reasons = new Map<string, { text: string; at: number }>()
  let requestSeen = 0

  // --- reason 观察者（waterfall 必须 next 放行）---
  if (typeof ctx.on === 'function') {
    ctx.on('approval/request', (req: any, next: () => Promise<unknown>) => {
      try {
        requestSeen++
        if (requestSeen % 50 === 0) {
          const cutoff = Date.now() - 10 * 60_000
          for (const [key, value] of reasons) {
            if (value.at < cutoff) reasons.delete(key)
          }
        }
        const sessionId: string | undefined = req?.agent?.session?.id
        const callId: string | undefined = req?.callId
        if (typeof sessionId === 'string' && typeof req?.reason === 'string' && req.reason !== '') {
          reasons.set(`${sessionId}|${callId ?? ''}`, { text: req.reason, at: Date.now() })
        }
      } catch {
        // 观察失败不影响审批链（next 照常放行）。
      }
      return next()
    })
  }

  /** 从 tool/call arguments（JSON 字符串）判定 plan-review 呈现意图：
   *  questions 里任一 intent.kind === 'plan-review'（与官方面板
   *  planReviewOf 同判定；detail 存在性不影响横幅分类）。解析失败一律
   *  按普通提问登记（跳转后官方面板显示真实内容）。 */
  const planReviewOf = (raw: unknown): boolean => {
    try {
      const args = JSON.parse(typeof raw === 'string' ? raw : '') as { questions?: Array<{ intent?: { kind?: string } }> }
      const questions = args?.questions
      return Array.isArray(questions) && questions.some(q => q?.intent?.kind === 'plan-review')
    } catch {
      return false
    }
  }

  // --- 审计投影 ---
  const onEvent = (session: any, event: any): void => {
    try {
      const data = event?.data
      if (event?.type === 'approval/asked') {
        const id: string = data?.id ?? ''
        if (id === '') return
        const sessionId: string = session?.id ?? ''
        const callId: string | undefined = data?.callId
        const reason = reasons.get(`${sessionId}|${callId ?? ''}`)
        if (reason !== undefined) reasons.delete(`${sessionId}|${callId ?? ''}`)
        pending.set(id, {
          sessionId,
          approvalId: id,
          toolName: data?.toolName ?? '',
          ...(callId !== undefined ? { callId } : {}),
          ...(reason !== undefined ? { reason: reason.text } : {}),
          askedAt: Date.now(),
          orphan: false,
        })
        // 通知钩子（需求 15）：审批登记 → Web Push（页面内通知由 client
        // 轮询 pending 触发；此处覆盖页面关闭/后台场景）。
        notify.pushApproval({
          sessionId,
          approvalId: id,
          toolName: data?.toolName ?? '',
          ...(reason !== undefined ? { reason: reason.text } : {}),
        })
      } else if (event?.type === 'approval/decided') {
        const id: string = data?.id ?? ''
        if (id !== '') pending.delete(id)
      } else if (event?.type === 'tool/call' && data?.name === 'ask_user_question') {
        const callId: string = data?.callId ?? ''
        if (callId === '' || pendingQuestions.has(callId)) return
        const sessionId: string = session?.id ?? ''
        pendingQuestions.set(callId, {
          sessionId,
          callId,
          askedAt: Date.now(),
          planReview: planReviewOf(data?.arguments),
          orphan: false,
        })
      } else if (event?.type === 'tool/result') {
        // 配对字段：tool/result 的 callId 在 message.source.callId（core
        // 契约，repair 会给中断的工具补合成 result，故最终必有配对）。
        const callId: unknown = data?.message?.source?.callId
        if (typeof callId === 'string') pendingQuestions.delete(callId)
      }
    } catch {
      // 投影失败静默：轮询接口仍返回已有数据。
    }
  }
  if (typeof ctx.on === 'function') ctx.on('session/event', onEvent)

  // --- 启动恢复：扫描已挂会话的审计流（先注册监听再扫描，旧事件不重放，
  // 无重复；孤儿项打 orphan 标记，客户端据此提示"可能已失效"）---
  try {
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        const events: unknown[] | undefined = session?.events
        if (!Array.isArray(events)) continue
        const decided = new Set<string>()
        for (const event of events) {
          if (event?.type === 'approval/decided' && typeof event.data?.id === 'string') {
            decided.add(event.data.id)
          }
        }
        for (const event of events) {
          if (event?.type !== 'approval/asked') continue
          const id: unknown = event.data?.id
          if (typeof id !== 'string' || id === '') continue
          if (decided.has(id) || pending.has(id)) continue
          const callId: unknown = event.data?.callId
          pending.set(id, {
            sessionId: session.id,
            approvalId: id,
            toolName: typeof event.data?.toolName === 'string' ? event.data.toolName : '',
            ...(typeof callId === 'string' ? { callId } : {}),
            askedAt: Date.now(),
            orphan: true,
          })
        }
        // 提问孤儿恢复：tool/call(ask_user_question) 无配对 tool/result。
        const decidedCalls = new Set<string>()
        for (const event of events) {
          const resultCallId: unknown = event?.data?.message?.source?.callId
          if (event?.type === 'tool/result' && typeof resultCallId === 'string') {
            decidedCalls.add(resultCallId)
          }
        }
        for (const event of events) {
          if (event?.type !== 'tool/call' || event.data?.name !== 'ask_user_question') continue
          const callId: unknown = event.data?.callId
          if (typeof callId !== 'string' || callId === '') continue
          if (decidedCalls.has(callId) || pendingQuestions.has(callId)) continue
          pendingQuestions.set(callId, {
            sessionId: session.id,
            callId,
            askedAt: Date.now(),
            planReview: planReviewOf(event.data?.arguments),
            orphan: true,
          })
        }
      }
    }
  } catch {
    // 恢复失败静默。
  }

  /** 按 callId 在会话事件里懒查命令文本（bash/pwsh 族 args.command；
   *  找不到省略）。轮询时现算，无常驻扫描。 */
  const commandFor = (view: PendingApprovalView): string | undefined => {
    if (view.callId === undefined) return undefined
    try {
      const session = sessions?.get?.(view.sessionId)
      const events: unknown[] | undefined = session?.events
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i] as { type?: string; data?: { callId?: unknown; arguments?: string } } | undefined
        if (event?.type !== 'tool/call' || event.data?.callId !== view.callId) continue
        try {
          const args = JSON.parse(event.data.arguments ?? '') as Record<string, unknown>
          return typeof args.command === 'string' ? args.command : undefined
        } catch {
          return undefined
        }
      }
    } catch {
      // 查不到省略。
    }
    return undefined
  }

  // --- 只读状态路由 ---
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const dispose = webServer.register({
      kind: 'exact',
      path: '/plugins/meow-smooth/pending',
      handler: (_req: unknown, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }) => {
        try {
          const approvals = [...pending.values()].map((view) => {
            const command = commandFor(view)
            return {
              sessionId: view.sessionId,
              approvalId: view.approvalId,
              toolName: view.toolName,
              ...(view.callId !== undefined ? { callId: view.callId } : {}),
              ...(view.reason !== undefined ? { reason: view.reason } : {}),
              ...(command !== undefined ? { command } : {}),
              askedAt: view.askedAt,
              orphan: view.orphan,
            }
          })
          const questions = [...pendingQuestions.values()].map((view) => ({
            sessionId: view.sessionId,
            callId: view.callId,
            planReview: view.planReview,
            askedAt: view.askedAt,
            orphan: view.orphan,
          }))
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ approvals, questions, events: notify.completionEvents() }))
        } catch {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"error":"internal"}')
        }
      },
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'meow-smooth: pending route')
    }
  }
}
