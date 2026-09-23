/**
 * meow-smooth — 手机端返回手势接管为边栏开关（需求㉑，2026-09-12 定稿 v2）。
 *
 * 问题：dsh 是单页应用且不用 history 路由（本体 bundle 无 pushState/
 * popstate 业务调用，实测）。浏览器网页模式里，屏幕左缘的系统返回手势
 * 发生在页面收到触摸事件之前（W3C pointerevents#358：网页无暴露途径）
 * ——浏览器把它直接换成 history 后退，sidebar-gesture.ts 的边缘热区永远
 * 收不到这批触摸，边栏在浏览器模式里无法用边缘手势打开。
 *
 * 方案（v1"吞返回+双退退出"已废弃，猫猫实测否决：第一次弹提示、第二次
 * 真退出、边栏一次都没开——用户要的是"返回手势当抽屉用"）：history
 * 哨兵 + 语义翻译。在当前记录之上推入同 URL 哨兵记录，把"后退一格"变成
 * "落在同页哨兵上"（URL 不变、无导航、React 不动），popstate 通道收到
 * 这次返回后不再吞掉了事，而是**翻译成边栏开关**：
 *
 *  - 返回 + 边栏关闭（0 档 furl 小方块）→ 打开宽档（会话列表直接可用，
 *    与 FAB 两态点击同款官方过渡链）；
 *  - 返回 + 边栏在场（窄档/宽档）→ 收起到 0 档（collapseToZero）；
 *  - 全程 re-push 哨兵恢复防护，页面永不因返回退出——与 PWA standalone
 *    模式（本插件主场景）的体验一致，离开页面走系统多任务/标签切换。
 *
 * 与手势模块天然互斥：浏览器抢走的滑动页面收到 touchcancel，手势模块
 * 不会提交动作；没被抢走的滑动不产生 popstate。残余竞态用 busy() 兜住
 * （手势拖拽中到达的返回只恢复哨兵、不切换边栏）。桌面宽度（≥1024）
 * 与 fine pointer 不参与（open/close 自身按宽度无操作，此处仍恢复哨兵）。
 */

/** 哨兵记录的 history.state 标记。 */
const SENTRY_FLAG = '__meowSmoothSentry'

/** 返回接管依赖的手势能力（GestureApi 的结构子集，避免模块耦合）。 */
export interface BackGuardGesture {
  /** 手势识别/收起序列进行中——此刻到达的返回不切换边栏。 */
  busy(): boolean
  /** 边栏是否在场（宽档或窄档；0 档 furl = 关）。 */
  isOpen(): boolean
  /** 打开宽档（桌面宽度自行无操作）。 */
  open(): void
  /** 收起到 0 档（桌面宽度自行返回 false）。 */
  collapseToZero(): boolean
}

/** 安装依赖。 */
export interface BackGuardDeps {
  /** 手势模块句柄（懒取：apply 中本模块可与手势模块同批安装）。 */
  gesture(): BackGuardGesture | undefined
}

/**
 * 安装返回手势接管（手机端）。热替换单实例协议同手势模块：window 挂
 * 拆除函数，新实例先拆旧的。
 * @returns 拆除函数。
 */
export function installBackGuard(deps: BackGuardDeps): () => void {
  const w = window as unknown as Record<string, unknown>
  ;(w.__meowSmoothBackGuardDispose as (() => void) | undefined)?.()

  const isSentryState = (state: unknown): boolean =>
    state !== null && typeof state === 'object'
      && (state as Record<string, unknown>)[SENTRY_FLAG] === true

  /** 推入哨兵记录（同 URL，视觉零变化）。 */
  const pushSentry = (): void => {
    history.pushState({ [SENTRY_FLAG]: true }, '', location.href)
  }

  // 排障轨迹（环形 16 条）：真机无 console，返回接管分派问题靠
  // window.__meowBackGuardTrace 定位（与手势模块 __meowGestureTrace 同款）。
  const trace: string[] = []
  ;(w).__meowBackGuardTrace = trace
  const note = (msg: string): void => {
    trace.push(`${Date.now() % 100000} ${msg}`)
    if (trace.length > 16) trace.shift()
  }

  /** 一次返回到达：恢复哨兵防护 + 翻译成边栏开关（手势忙时只恢复防护）。 */
  const onPopState = (event: PopStateEvent): void => {
    if (isSentryState(event.state)) return // 落回哨兵：无视觉变化，不动
    pushSentry()
    const g = deps.gesture()
    if (g === undefined) {
      note('back: no-gesture-api')
      return
    }
    if (g.busy()) {
      note('back: gesture-busy')
      return
    }
    const open = g.isOpen()
    note(`back: isOpen=${open} → ${open ? 'close' : 'open'}`)
    if (open) g.collapseToZero()
    else g.open()
  }

  /** bfcache 恢复（离开后浏览器前进回来）：监听器还活着但哨兵可能已被
   *  消耗，补推恢复防护。 */
  const onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return
    if (!isSentryState(history.state)) pushSentry()
  }

  const dispose = (): void => {
    window.removeEventListener('popstate', onPopState)
    window.removeEventListener('pageshow', onPageShow)
  }

  // 安装：当前记录已是哨兵（驻留哨兵时刷新页面）则不叠加推入，栈深恒 2。
  if (!isSentryState(history.state)) pushSentry()
  window.addEventListener('popstate', onPopState)
  window.addEventListener('pageshow', onPageShow)
  ;(w as unknown as Record<string, unknown>).__meowSmoothBackGuardDispose = dispose
  return dispose
}
