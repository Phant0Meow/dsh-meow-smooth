/**
 * meow-smooth — 通知 client 模块（需求 15：权限申请 / 提问 / 长任务完成通知）。
 *
 * 职责：
 *  1. 页面内系统通知：首次用户手势请求 Notification 权限；pending 新增且
 *     页面 hidden → 弹通知（approval / question / plan-review）；点击 →
 *     聚焦页面 + 跳转目标会话。页面可见时不弹（横幅/官方面板已在显示）。
 *  2. 长任务完成通知：轮询拉到新完成事件且页面 hidden → 弹通知；
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

/** host /pending 路由返回的完成事件（wire 子集）。 */
export interface CompletionEventLike {
  id: string
  sessionId: string
  toolCalls: number
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

  // --- 首次用户手势请求权限（浏览器要求授权在交互上下文中更稳） ---
  const requestPermissionOnGesture = (): void => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
    document.removeEventListener('pointerdown', requestPermissionOnGesture, { capture: true })
    document.removeEventListener('keydown', requestPermissionOnGesture, { capture: true })
    void Notification.requestPermission().catch(() => { /* 拒绝/异常：横幅兜底 */ })
  }
  document.addEventListener('pointerdown', requestPermissionOnGesture, { capture: true })
  document.addEventListener('keydown', requestPermissionOnGesture, { capture: true })

  // --- PWA 桥：secure context 下注册 SW + push 订阅上报（幂等） ---
  if ('serviceWorker' in navigator && window.isSecureContext && typeof navigator.serviceWorker.register === 'function') {
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/plugins/meow-smooth/sw.js', { scope: '/' })
        const existing = await registration.pushManager.getSubscription()
        const subscription = existing ?? await (async () => {
          const res = await fetch('/plugins/meow-smooth/push-config', { cache: 'no-store' })
          if (!res.ok) return null
          const data = await res.json() as { enabled?: boolean; publicKey?: string }
          if (data.enabled !== true || typeof data.publicKey !== 'string') return null
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
        }
      } catch {
        // SW/订阅失败（权限拒绝、无推送服务等）静默：页面内通知兜底。
      }
    })()
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
