/**
 * meow-smooth — 手机端侧边栏边缘手势（需求⑲，2026-08-24 猫猫定稿 v5 状态机式）。
 *
 * 交互（v5：人类最直觉的方式，**不跟手、无自定义补间**——侧边栏只有
 * 三个官方原生状态，手势只负责"识别→触发一次官方状态切换"，动画全部
 * 由官方 .frame 自带的 grid 过渡（300ms）播放）：
 *
 *  - 屏幕左缘向右轻划（<110px）→ 打开细条（窄档 = 原生收起态 rail）
 *  - 细条在场再向右轻划 → 打开宽边栏（原生展开态）
 *  - 左缘向右长划（≥110px）→ 跳过细条直接打开宽边栏
 *  - 宽边栏在场：边栏无按钮空白处向左滑，或右侧窗口向左滑 → 收起到 0
 *  - 细条在场：右侧窗口向左滑 → 收起到 0
 *  - 点右侧窗口区收起（client.ts onClickDismissSidebar，行为一致）
 *
 * 三档停留态全部是官方原生状态：
 *  - 0     = furl 收起（小方块，功能⑱ 原样，零改动）
 *  - 窄档  = 原生收起态 rail（不 furl：真 logo、真设置齿轮可点）
 *  - 宽档  = 原生展开态完整侧边栏
 *
 * v1 的跟手逐帧驱动与自绘窄壳已全部废弃（v1 窄壳造成两段式闪变被否；
 * 跟手方案每帧写 grid 轨道触发全页 reflow，卡顿且复杂）。v5 手势期间
 * 零 DOM 写入——只在识别完成后调用一次官方状态切换，性能天然最优。
 *
 * 已知局限（平台限制）：浏览器网页模式里左缘内滑会被系统前进/后退手势
 * 抢走；PWA（添加到主屏幕，主场景）无此问题。
 */

/** 窄档宽度 = 官方收起态竖条宽度（ui-sidebar rail 契约）。 */
const NARROW_W = 56
/** 左缘开启手势热区宽度（触点 x ≤ 此值才起手）。 */
const EDGE_HOTSPOT = 26
/** 滑动识别阈值：|dx| 达到此值才认定为一次滑动。 */
const SWIPE_MIN = 24
/** 轻/长划分界：≥ 此值为长划（直达宽档），否则轻划（逐级开合）。 */
const LONG_SWIPE = 110
/** 横向主导判定系数：|dx| > |dy| × 此值才算横滑。 */
const AXIS_RATIO = 1.2

/** 手势模块依赖（client.ts apply 注入既有工具函数，避免重复实现）。 */
export interface GestureDeps {
  /** 官方布局服务（窄档⇄宽档切换）。 */
  layout: { toggleSidebar(): void }
  /** AppFrame 根元素（同 client.ts frameElement）。 */
  frameElement(): HTMLElement | null
  /** furl 标记写（同 client.ts setFurled；0 档挂回小方块 / 开启时解除）。 */
  setFurled(on: boolean): void
  /** furl 标记读（同 client.ts furlRoot；判定当前是否 0 档）。 */
  isFurled(): boolean
  /** 触屏（粗指针）判定（同 client.ts isCoarsePointer）。 */
  isCoarsePointer(): boolean
}

/** 手势模块对外接口（client.ts 消费）。 */
export interface GestureApi {
  /** 窄档停留保持中（用户用手势拉出过 rail）：syncSidebarFurl 据此豁免
   *  自动折回小方块——窄档是合法停留态，不是待折叠态。 */
  narrowHold(): boolean
  /** 清除窄档保持（收起到 0 时由 syncSidebarFurl 的 furl 分支调用）。 */
  clearHold(): void
  /** 编程式收起到 0 档：侧边栏在场（窄档或宽档）时触发官方过渡链
   *  （宽档 = 280→56→0 两段连贯收缩；窄档 = 56→0 单段）。点外部收起/
   *  选会话自动收起共用。接管返回 false 表示不在场/桌面/忙，调用方走
   *  原逻辑。 */
  collapseToZero(): boolean
  /** 手势识别或收起序列进行中：syncSidebarFurl 等外部干预据此让路。 */
  busy(): boolean
}

/** 手势期规则（安装时注入一次）：触屏下 sidebar 子树 touch-action: pan-y
 *  ——纵向滚动仍由浏览器原生处理，横向滑动不被滚动容器吞掉（否则
 *  touchstart 后浏览器接管手势发出 touchcancel，横滑识别永远收不到
 *  committed）。左缘开启手势起点在内容区，无需额外声明。 */
const GESTURE_CSS = `
@media (pointer: coarse) {
  [data-slot="sidebar"],
  [data-slot="sidebar"] * {
    touch-action: pan-y;
  }
}
`

/**
 * 安装手机端侧边栏边缘手势。
 * @param deps - client.ts 既有工具函数注入。
 * @returns 手势模块句柄。
 */
export function installSidebarGesture(deps: GestureDeps): GestureApi {
  // 运行时构建标记（排障用）：页面执行到本函数即可见，用于确认"页面
  // 实际执行的 client.js 是否为本构建"（rev 滞后时静态路由与执行内容
  // 不一致——排障期每次构建必须 bump 标记文本并等精确匹配）。
  document.documentElement.dataset.meowSmoothGestureLoaded = 'v6.2-axis'
  const w = window as unknown as Record<string, unknown>
  // 旧实例清理：dsh 模块热替换（rev 更新）会执行新脚本，但旧实例挂在
  // document 上的匿名监听器无法自动移除——新旧实例并存时互相污染状态。
  // 旧实例把拆除函数挂 window，新实例先拆再装（单实例保证）。
  ;(w.__meowSmoothGestureDispose as (() => void) | undefined)?.()

  // 样式注入（每次安装都刷新内容——构建更新时规则同步演进）。
  const prevStyle = document.querySelector('style[data-meow-smooth-gesture-css]')
  if (prevStyle !== null) prevStyle.remove()
  const style = document.createElement('style')
  style.setAttribute('data-meow-smooth-gesture-css', 'true')
  style.textContent = GESTURE_CSS
  document.head.appendChild(style)

  // --- 状态机：idle → pending(起点已记) → committed(方向已判) → idle ---
  let phase: 'idle' | 'pending' | 'committed' = 'idle'
  let sx = 0
  let sy = 0
  /** 起手区域：furl 态左缘 / rail 表面 / 展开态表面 / 右侧窗口。 */
  let startZone: 'edge' | 'rail' | 'sidebar' | 'window' = 'window'
  /** 窄档停留保持（见 GestureApi.narrowHold）。挂 window 使热替换新实例
   *  能继承旧实例的状态（旧实例闭包已死，标志不能丢）。 */
  let hold = false
  const syncHoldFlag = (): void => { w.__meowSmoothGestureHold = hold }

  const html = document.documentElement
  const frameOf = (): HTMLElement | null => deps.frameElement()
  const collapsedNow = (): boolean => frameOf()?.hasAttribute('data-sidebar-collapsed') ?? true

  /** 官方态对齐（幂等）：只在状态不符时 toggle。 */
  const ensureOfficial = (wantExpanded: boolean): void => {
    if ((!collapsedNow()) !== wantExpanded) deps.layout.toggleSidebar()
  }

  /** 打开细条（窄档）：0 档解除 furl 即可（React inline 已是 56px，官方
   *  过渡自动从 0 播到 56）；已是窄档则无操作。 */
  const openNarrow = (): void => {
    if (!collapsedNow()) return
    deps.setFurled(false)
    hold = true
    syncHoldFlag()
  }

  /** 打开宽档（幂等）：furl 态先解除，再切展开态。 */
  const openWide = (): void => {
    deps.setFurled(false)
    ensureOfficial(true)
    hold = false
    syncHoldFlag()
  }

  /** 编程式收起到 0 档（猫猫：任何在场形态点外部/左滑都直接恢复全屏，
   *  不经过中间档停顿——宽档收起时切收起与 furl 同步执行，!important
   *  归零让 grid 过渡一次性播 280→0，rail 不会在 56px 处闪现）。 */
  const collapseToZero = (): boolean => {
    const frame = frameOf()
    if (frame === null || frame.getBoundingClientRect().width >= 1024) return false
    if (collapsedNow()) {
      if (deps.isFurled()) return false // 0 档：无可收
      deps.setFurled(true) // 窄档 → 0：官方过渡 56→0 自动播放
      hold = false
      syncHoldFlag()
      return true
    }
    // 宽档 → 0：toggleSidebar（flip 收起态）+ 立即 furl（归零覆盖），
    // 过渡一次性播 280→0，落位即小方块。
    deps.layout.toggleSidebar()
    deps.setFurled(true)
    hold = false
    syncHoldFlag()
    return true
  }

  // --- 起手判定（touchstart capture）---
  const onTouchStart = (event: TouchEvent): void => {
    if (phase !== 'idle' || event.touches.length !== 1) return
    if (!deps.isCoarsePointer()) return
    const frame = frameOf()
    if (frame === null || frame.getBoundingClientRect().width >= 1024) return
    const target = event.target
    if (!(target instanceof Element)) return
    const touch = event.touches[0]
    sx = touch.clientX
    sy = touch.clientY
    const onInput = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    if (onInput && sx > EDGE_HOTSPOT) return
    // composer 卡片内起手一律排除（2026-08-25 光标 bug）：旧版留了"卡片内
    // 且 x≤左缘热区仍识别"的例外——输入框折叠后仅一行高，行首长按定位光标
    // 的起手极易落进这 26px 条带，pending 态横移被 committed+preventDefault
    // 冻住光标。输入区永不参与边栏手势；furl 态拉边栏走屏幕其余左缘。
    if (target.closest('[data-composer-card]') !== null) return
    const overlayHit = target.closest('[role="dialog"], [data-meow-smooth-pending], [data-meow-smooth-fab]')
    if (overlayHit !== null) return

    if (!collapsedNow()) {
      // 宽档在场：边栏无按钮空白处 / 右侧窗口 → 左滑收起。
      const inSidebar = target.closest('[data-slot="sidebar"]') !== null
      const onBlank = inSidebar && target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [contenteditable="true"]') === null
      if ((onBlank || !inSidebar) && !onInput) {
        startZone = inSidebar ? 'sidebar' : 'window'
        phase = 'pending'
        note(`ts pending zone=${startZone} x=${sx}`)
      } else {
        note(`ts skip wide inSidebar=${inSidebar} onBlank=${onBlank}`)
      }
      return
    }
    if (deps.isFurled()) {
      // 0 档（小方块）：只有左缘热区起手（开启方向）。
      if (sx <= EDGE_HOTSPOT) {
        startZone = 'edge'
        phase = 'pending'
      }
      return
    }
    // 窄档（rail 在场）：rail 上右划开宽档；右侧窗口左划收起到 0。
    if (sx <= NARROW_W + 30) {
      startZone = 'rail'
      phase = 'pending'
    } else if (!onInput) {
      startZone = 'window'
      phase = 'pending'
    }
  }

  // --- 方向判定（touchmove capture，非 passive 才能拦历史导航手势）---
  const onTouchMove = (event: TouchEvent): void => {
    if (phase !== 'pending' || event.touches.length !== 1) return
    // 文本选区在场 → 可能是选区手柄拖动（PWA 里 cancelable=true，一旦
    // committed+preventDefault 手柄就冻结拖不动）：回 idle 放行原生行为，
    // 本序列不再参与识别。2026-08-25 选区手柄 bug 修复的一部分。
    const sel = document.getSelection()
    if (sel !== null && sel.type === 'Range') {
      phase = 'idle'
      return
    }
    const touch = event.touches[0]
    const dx = touch.clientX - sx
    const dy = touch.clientY - sy
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
      // 横向主导滑动确认 → 进入 committed（后续 preventDefault 阻断浏览器
      // 边缘历史导航；识别期零 DOM 写入，无任何性能负担）。
      phase = 'committed'
      note(`committed dx=${Math.round(dx)} zone=${startZone}`)
      if (event.cancelable) event.preventDefault()
    } else if (Math.abs(dy) > SWIPE_MIN && Math.abs(dy) > Math.abs(dx)) {
      phase = 'idle' // 纵向主导 → 放行原生滚动
    }
  }

  // --- 松手：按累计位移分派动作 ---
  const onTouchEnd = (event: TouchEvent): void => {
    if (phase !== 'committed') {
      phase = 'idle'
      return
    }
    phase = 'idle'
    const touch = event.changedTouches[0]
    const dx = (touch?.clientX ?? sx) - sx
    if (Math.abs(dx) < SWIPE_MIN) return // 位移不足（理论上 committed 已保证）
    note(`swipe dx=${Math.round(dx)} zone=${startZone} furled=${deps.isFurled()} collapsed=${collapsedNow()}`)
    if (dx > 0) {
      // 向右：开细条 / 开宽档（长划跳级；细条在场再划即宽档）。
      if (startZone === 'edge' && deps.isFurled()) {
        if (dx >= LONG_SWIPE) openWide()
        else openNarrow()
      } else if (startZone === 'rail') {
        openWide()
      }
      return
    }
    // 向左：在场即收起到 0（宽档空白处/右侧窗口；细条仅右侧窗口）。
    collapseToZero()
  }

  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true })

  /** 实例拆除：移除全部 document 级监听。挂 window 供下一次模块安装
   *  （构建热替换/页面内重装）先行调用——旧实例的匿名监听器无法被他人
   *  移除，必须自留拆除函数（否则新旧实例并存互相污染）。 */
  const dispose = (): void => {
    document.removeEventListener('touchstart', onTouchStart, { capture: true } as AddEventListenerOptions)
    document.removeEventListener('touchmove', onTouchMove, { capture: true } as AddEventListenerOptions)
    document.removeEventListener('touchend', onTouchEnd, { capture: true } as AddEventListenerOptions)
    document.removeEventListener('touchcancel', onTouchEnd, { capture: true } as AddEventListenerOptions)
  }
  ;(w as unknown as Record<string, unknown>).__meowSmoothGestureDispose = dispose

  /** 排障轨迹（环形 16 条）：真机无 console，动作分派问题靠
   *  window.__meowGestureTrace 定位。 */
  const trace: string[] = []
  const INSTANCE_ID = Math.random().toString(36).slice(2, 7)
  ;(w).__meowGestureInstanceId = INSTANCE_ID
  ;(w).__meowGestureTrace = trace
  function note(msg: string): void {
    trace.push(`${Date.now() % 100000} [${INSTANCE_ID}] ${msg}`)
    if (trace.length > 16) trace.shift()
  }

  return {
    narrowHold: () => hold,
    clearHold: () => {
      hold = false
      syncHoldFlag()
    },
    collapseToZero,
    busy: () => phase !== 'idle',
  }
}
