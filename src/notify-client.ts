/**
 * meow-smooth — 通知 client 模块（需求 15：权限申请 / 提问 / 长任务完成通知）。
 *
 * 职责：
 *  1. 页面内系统通知：首次用户手势请求 Notification 权限；pending 新增且
 *     页面 hidden → 弹通知（approval / question / plan-review）；点击 →
 *     聚焦页面 + 跳转目标会话。页面可见时不弹（横幅/官方面板已在显示）。
 *  2. 长任务完成/运行失败通知：轮询拉到新事件且页面 hidden → 弹通知
 *     （kind 缺省=长任务完成；'failed'=AI 回合因错误中断，2026-08-22 加）；
 *     localStorage 去重（页面重开后，host 队列里未通知过的仍弹一次）。
 *  3. PWA 桥：HTTPS（secure context）下注册 SW + push 订阅上报——
 *     页面关闭 / iOS PWA 后台场景由 SW + Web Push 兜底（host 推送）。
 *     SW notificationclick 的 postMessage 收到 meow-smooth:jump → 跳转会话。
 *
 * 零 dsh 本体改动；纯 DOM/浏览器 API；Notification 不可用（如 iOS 普通
 *  Safari 网页）时静默降级（横幅仍在）。
 */

/** 一条待通知的 pending 项（client.ts 的合并数据转换后传入）。 */
export interface NotifyItem {
  sessionId: string
  kind: 'approval' | 'question' | 'plan-review'
  /** 去重 id：approval 用 approvalId；question/plan-review 用 sessionId:kind
   *  （后者无稳定 id，pending 消失后 id 从集合移除，重新出现可再通知）。 */
  id: string
  /** 会话展示名（列表标题；空则通知文本用"未命名会话"）。 */
  title: string
  toolName?: string
}

/** host /pending 路由返回的完成/失败事件（wire 子集）。 */
export interface CompletionEventLike {
  id: string
  sessionId: string
  toolCalls: number
  /** 'failed'=回合因错误中断；缺省=长任务完成（旧 host 兼容）。 */
  kind?: string
  /** failed 专有：失败摘要（host 已截断到 120 字符）。 */
  message?: string
}

/** 通知模块依赖（client.ts apply 闭包注入）。 */
export interface NotifyClientDeps {
  /** 跳转目标会话（横幅同款；undefined = sessions 服务不可用）。 */
  openSession?: (sessionId: string) => void
}

/** 通知模块句柄（client.ts 在轮询/横幅刷新处调用）。 */
export interface NotifyClientHandle {
  /** pending 全量变化（横幅刷新时调用；内部对比上次集合弹新增通知）。 */
  onPending(items: NotifyItem[]): void
  /** 轮询响应处理（完成事件通知；approvals 由 onPending 覆盖）。 */
  onPollResult(data: { events?: CompletionEventLike[] }): void
}

const NOTIFIED_LS_KEY = 'meow-smooth:notified-completions'
const NOTIFIED_LS_CAP = 50
const ICON_URL = '/plugins/meow-smooth/icon-180.png'

/** localStorage 已通知完成事件 id（防页面重开后重复弹）。 */
function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_LS_KEY)
    const list: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveNotified(ids: Set<string>): void {
  try {
    const list = [...ids].slice(-NOTIFIED_LS_CAP)
    localStorage.setItem(NOTIFIED_LS_KEY, JSON.stringify(list))
  } catch {
    // localStorage 不可用（隐私模式等）→ 仅本次会话去重。
  }
}

/** VAPID applicationServerKey：base64url → Uint8Array（PushManager 要求）。 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64url = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64url)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** 通知展示名（空标题 → 未命名会话）。 */
function displayName(title: string): string {
  return title === '' ? '未命名会话' : title
}

/**
 * 安装通知模块。
 * @param deps - 依赖（跳转回调）。
 * @returns 通知模块句柄。
 */
export function installNotifyClient(deps: NotifyClientDeps): NotifyClientHandle {
  const openSession = deps.openSession
  // 已通知的 pending id（pending 消失即移除 → 重新出现可再通知）。
  let lastPendingIds = new Set<string>()

  /** 弹一条系统通知（页面 hidden + 权限 granted 才弹）。 */
  const notify = (
    title: string,
    body: string,
    tag: string,
    sessionId?: string,
  ): void => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (!document.hidden) return
    try {
      const n = new Notification(title, { body, tag, icon: ICON_URL })
      n.onclick = () => {
        window.focus()
        if (sessionId !== undefined) openSession?.(sessionId)
        n.close()
      }
    } catch {
      // 通知被系统拒绝/受限：静默（横幅仍在）。
    }
  }

  // --- PWA 桥：secure context 下注册 SW + push 订阅上报（幂等重试） ---
  // 时序坑（实测：iOS 订阅从未建立）：订阅逻辑只在页面加载时跑一次，而 iOS
  // PWA 首次打开时权限弹框尚未授权，pushManager.subscribe 被拒后永不重试
  // → host subscriptions.json 恒空 → 页面关闭/被杀后无任何推送。
  // 修复：抽成 ensureSubscription()，权限授权成功与页面重新可见时都会重试
  // （getSubscription 幂等，成功即停；限次防抖）。
  // 诊断上报（2026-08-20 加）：iOS 真机无 console，把权限链路状态 POST 到
  // host /diag-log，服务器侧查 GET /diag 定位"弹窗不出现/订阅不建立"。
  let lastDiagAt = 0
  const reportDiag = (msg: string): void => {
    const now = Date.now()
    if (now - lastDiagAt < 3000) return // 防抖：重试/可见性高频场景不刷屏
    lastDiagAt = now
    try {
      void fetch('/plugins/meow-smooth/diag-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg }),
      }).catch(() => { /* 诊断上报失败静默 */ })
    } catch {
      // 诊断上报失败静默
    }
  }
  const pushSupported = 'serviceWorker' in navigator && window.isSecureContext
    && typeof navigator.serviceWorker.register === 'function'
    && typeof Notification !== 'undefined'
  let subscribeRetries = 0
  const MAX_SUBSCRIBE_RETRIES = 5

  const ensureSubscription = async (): Promise<void> => {
    if (!pushSupported || Notification.permission !== 'granted') {
      reportDiag(`sub-skip perm=${typeof Notification === 'undefined' ? 'no-Notification' : Notification.permission}`)
      return
    }
    if (subscribeRetries >= MAX_SUBSCRIBE_RETRIES) return
    subscribeRetries += 1
    try {
      const registration = await navigator.serviceWorker.register('/plugins/meow-smooth/sw.js', { scope: '/' })
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing ?? await (async () => {
        const res = await fetch('/plugins/meow-smooth/push-config', { cache: 'no-store' })
        if (!res.ok) { reportDiag('sub-config-http-err'); return null }
        const data = await res.json() as { enabled?: boolean; publicKey?: string }
        if (data.enabled !== true || typeof data.publicKey !== 'string') {
          reportDiag(`sub-config-bad enabled=${data.enabled} key=${typeof data.publicKey}`)
          return null
        }
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey),
        })
      })()
      if (subscription !== null) {
        await fetch('/plugins/meow-smooth/push-subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        })
        reportDiag(existing !== null ? 'sub-existed-report-ok' : 'sub-subscribed-report-ok')
        subscribeRetries = MAX_SUBSCRIBE_RETRIES // 上报成功即停
      } else {
        reportDiag('sub-null (no subscription produced)')
      }
    } catch (error) {
      reportDiag(`sub-error ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`)
      // SW/订阅失败（权限拒绝、无推送服务等）静默：页面内通知兜底。
    }
  }

  // --- 首次用户手势请求权限（浏览器要求授权在交互上下文中更稳）；
  //     授权成功即补订阅（覆盖"加载时未授权 → 弹框授权"的时序）。 ---
  const requestPermissionOnGesture = (): void => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
    document.removeEventListener('pointerdown', requestPermissionOnGesture, { capture: true })
    document.removeEventListener('keydown', requestPermissionOnGesture, { capture: true })
    reportDiag('request-permission-called')
    void Notification.requestPermission().then((permission) => {
      reportDiag(`perm-result ${permission}`)
      if (permission === 'granted') void ensureSubscription()
    }).catch(() => { /* 拒绝/异常：横幅兜底 */ })
  }
  document.addEventListener('pointerdown', requestPermissionOnGesture, { capture: true })
  document.addEventListener('keydown', requestPermissionOnGesture, { capture: true })

  if (pushSupported) {
    reportDiag(`boot perm=${Notification.permission} secure=${window.isSecureContext} sw=yes`)
    void ensureSubscription()
    // 页面重新可见时补订阅（PWA 后台回来 / 权限在别处打开后再回来）。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        reportDiag(`visible perm=${Notification.permission}`)
        void ensureSubscription()
      }
    })
    // SW notificationclick 的跳转指令（点通知 → 直达目标会话）。
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionId?: string } | null
      if (data?.type === 'meow-smooth:jump' && typeof data.sessionId === 'string') {
        openSession?.(data.sessionId)
      }
    })
  }

  return {
    onPending(items) {
      const next = new Set(items.map(item => item.id))
      // pending 消失的 id 从集合移除（同 id 重新出现可再通知）。
      for (const id of lastPendingIds) {
        if (!next.has(id)) lastPendingIds.delete(id)
      }
      for (const item of items) {
        if (lastPendingIds.has(item.id)) continue
        lastPendingIds.add(item.id)
        const name = displayName(item.title)
        if (item.kind === 'approval') {
          notify(
            'dsh：有权限申请待处理',
            item.toolName === undefined || item.toolName === ''
              ? `「${name}」有权限申请待处理`
              : `「${name}」工具 ${item.toolName} 请求权限`,
            `a:${item.id}`,
            item.sessionId,
          )
        } else if (item.kind === 'plan-review') {
          notify('dsh：有计划待审', `「${name}」有计划等待审批`, `p:${item.id}`, item.sessionId)
        } else {
          notify('dsh：有提问待回答', `「${name}」AI 正在等你回答问题`, `q:${item.id}`, item.sessionId)
        }
      }
    },
    onPollResult(data) {
      const events = Array.isArray(data.events) ? data.events : []
      if (events.length === 0) return
      const notified = loadNotified()
      let changed = false
      for (const event of events) {
        if (notified.has(event.id)) continue
        notified.add(event.id)
        changed = true
        if (event.kind === 'failed') {
          // 运行失败通知（2026-08-22）：AI 回合因错误中断（重试耗尽后的
          // 最终失败，host 侧保证重试链不产生中间事件）。
          notify(
            'dsh：本轮运行失败',
            event.message !== undefined && event.message !== ''
              ? `运行失败：${event.message}`
              : 'AI 回合因错误中断，点击查看…',
            `f:${event.id}`,
            event.sessionId,
          )
          continue
        }
        notify(
          'dsh：任务完成',
          `长任务完成（${event.toolCalls} 次工具调用）`,
          `c:${event.id}`,
          event.sessionId,
        )
      }
      if (changed) saveNotified(notified)
    },
  }
}
