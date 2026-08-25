/**
 * meow-smooth — 手机端设置页改造模块（需求 16：窄屏设置面板可用化）。
 *
 * 零 dsh 本体改动，纯 client 侧：CSS 注入 + 事件委托 + 面板属性状态机。
 * 只作用于窄屏（< 1024px，dsh 布局断点 SIDEBAR_AUTO_COLLAPSE）；桌面宽屏
 * 不注入属性、不拦截点击，官方原样。
 *
 * 行为（仅窄屏）：
 *  1. 设置浮层全窗口显示（面板铺满 viewport，无上下左右空隙）。
 *  2. 左侧 sidebar 收成一竖列，宽度与 dsh 主界面边栏收起时一致（56px
 *     rail：36x36 控件 + 10px 侧边距），只显示图标。
 *  3. 右侧内容本就 flex:1 占满，无需改动。
 *  4. 点左侧边栏图标：不切换标签页，边栏宽度恢复（向右滑出动画），完整
 *     显示图标和文字标签。
 *  5. 边栏完整状态下点边栏按钮：正常切换标签页。
 *  6. 边栏完整状态下点右侧空间（非交互元素）：不切换标签页，边栏收回
 *     细细的版本。
 *
 * 状态机：挂在设置面板元素上的 data-meow-smooth-settings 属性
 *   absent    = 桌面/宽屏，官方原样；
 *   collapsed = 窄屏默认态：56px 图标竖列；
 *   expanded  = 窄屏展开态：188px 完整边栏。
 * 属性随面板挂载/卸载由 MutationObserver 重置（面板关闭重开必回默认），
 * 跨断点由 matchMedia 监听切换。
 */

/** 设置面板状态属性（值：collapsed / expanded；缺席 = 桌面原样）。 */
const SETTINGS_ATTR = 'data-meow-smooth-settings'
/** 初始落位压制动画标记（面板刚插入时属性后置会触发 188→56 闪动动画）。 */
const NOANIM_ATTR = 'data-meow-smooth-settings-noanim'
/** 本模块注入的 <style> 标记（调试/排障用）。 */
const STYLE_ATTR = 'data-meow-smooth-settings-css'
/** 窄屏判定：与 dsh 布局断点 SIDEBAR_AUTO_COLLAPSE（1024）一致。 */
const BREAKPOINT = '(max-width: 1023px)'

/** 设置面板专用的移动端 CSS：全窗口 + 边栏收起/展开状态机。 */
const SETTINGS_CSS = `
/* 需求 16：手机端设置页改造。属性由 settings-mobile.ts 管理；桌面（宽屏）
   无属性，以下全部不生效。 */
@media (max-width: 1023px) {
  /* 1. 浮层全窗口：面板铺满 overlay（fixed inset:0 的 flex 容器），
     无上下左右空隙；圆角/阴影不再需要。 */
  div[role="dialog"][${SETTINGS_ATTR}] {
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  /* 2/4. 边栏宽度动画（收起/展开共用一条 transition，双向平滑）。 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav {
    transition: width 220ms cubic-bezier(0.2, 0.8, 0.3, 1),
                padding 220ms cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  /* 标签的显示/隐藏动画：宽度与透明度联动（收起归零、展开滑出）。 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav > div > button > span {
    transition: max-width 220ms cubic-bezier(0.2, 0.8, 0.3, 1),
                opacity 150ms ease;
  }
  /* 初始落位不播动画：面板刚插入时属性后置（MutationObserver 微任务晚于
     元素首帧样式）会让浏览器把"188px 原生态 → 收起态"也当过渡来播，
     打开瞬间闪一下。noanim 标记在首帧压制 transition，下一帧由 JS 摘除。 */
  div[role="dialog"][${SETTINGS_ATTR}][${NOANIM_ATTR}] > nav,
  div[role="dialog"][${SETTINGS_ATTR}][${NOANIM_ATTR}] > nav > div > button > span {
    transition: none;
  }
  /* 边栏右侧 1px 边线：引导用户识别"边栏 / 内容"两个区域。伪元素不占
     布局宽度（border 会吃掉内容宽导致按钮 36px 溢出被压缩），随宽度
     动画贴右缘移动。 */
  div[role="dialog"][${SETTINGS_ATTR}] > nav {
    position: relative;
  }
  div[role="dialog"][${SETTINGS_ATTR}] > nav::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  }
  /* 收起态（默认）：56px 图标竖列——与 dsh 主界面边栏收起宽度一致
     （ui-sidebar rail：36x36 控件居中 + 10px 侧边距）。 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav {
    width: 56px;
    padding: 22px 10px 0;
  }
  /* 收起态标题：视觉隐藏但保留在无障碍树（dialog aria-labelledby 指向
     它，display:none 会丢无障碍名）。 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div:first-child {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  /* 收起态按钮：36x36 圆钮（与主界面 rail 控件同形），只留图标居中。 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div > button {
    width: 36px;
    height: 36px;
    padding: 0;
    gap: 0;
    justify-content: center;
    border-radius: 50%;
  }
  /* 收起态标签：宽度与透明度同时归零（展开时按 transition 反向动画）。 */
  div[role="dialog"][${SETTINGS_ATTR}="collapsed"] > nav > div > button > span {
    flex: 0;
    max-width: 0;
    opacity: 0;
  }
  /* 展开态：恢复官方 188px 完整边栏 + 图标文字。 */
  div[role="dialog"][${SETTINGS_ATTR}="expanded"] > nav {
    width: 188px;
    padding: 22px 12px 0;
  }
  div[role="dialog"][${SETTINGS_ATTR}="expanded"] > nav > div > button > span {
    flex: 1;
    max-width: 200px;
    opacity: 1;
  }
}
`

/** 窄屏媒体查询（install 时初始化；跨断点变化时重设面板状态）。 */
let narrowQuery: MediaQueryList | null = null
/** 当前设置面板元素（null = 未打开）。 */
let panel: HTMLElement | null = null

/**
 * 定位设置面板：官方 SettingsRoot 的 dialog 独有结构——`role="dialog"`
 * 的直接子级是 nav（Modal 系 dialog 直接子级是 content/footer，不命中）。
 */
function findSettingsPanel(): HTMLElement | null {
  const nav = document.querySelector('div[role="dialog"] > nav')
  return nav !== null ? (nav.parentElement ?? null) : null
}

/** 按当前屏宽把面板状态机复位（宽屏 = 移除属性，官方原样）。 */
function applyMode(): void {
  if (panel === null) return
  if (narrowQuery?.matches === true) {
    panel.setAttribute(SETTINGS_ATTR, 'collapsed')
  } else {
    panel.removeAttribute(SETTINGS_ATTR)
  }
}

/** 交互元素判定：展开态点这些元素不收回边栏（避免误收与布局抖动）。 */
function isInteractive(target: Element): boolean {
  return target.closest(
    'button, a, input, select, textarea, label, [contenteditable="true"], '
    + '[role="button"], [role="menuitem"], [role="menuitemcheckbox"], '
    + '[role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], '
    + '[role="radio"], [role="link"], [role="slider"]',
  ) !== null
}

/**
 * 点击拦截（document capture，先于 React 根容器委托）：
 * 收起态点边栏按钮 → stopPropagation 让官方 onSelect 收不到 → 只展开；
 * 展开态点右侧空白 → 只收回，不切页。
 */
function onSettingsClickCapture(event: MouseEvent): void {
  const el = panel
  if (el === null || narrowQuery?.matches !== true) return
  const state = el.getAttribute(SETTINGS_ATTR)
  if (state !== 'collapsed' && state !== 'expanded') return
  const target = event.target
  if (!(target instanceof Element) || !el.contains(target)) return
  const nav = el.querySelector(':scope > nav')
  const inNav = nav !== null && nav.contains(target)
  if (state === 'collapsed') {
    // 点边栏任意处（按钮或背景）→ 只展开，不切换标签页（capture 拦截在
    // React 委托之前，stopPropagation 让官方 onSelect 收不到这次点击）。
    if (inNav) {
      event.preventDefault()
      event.stopPropagation()
      el.setAttribute(SETTINGS_ATTR, 'expanded')
    }
    return
  }
  // 展开态：点右侧非交互空间 → 收回细细的版本。
  if (!inNav && !isInteractive(target)) {
    event.preventDefault()
    event.stopPropagation()
    el.setAttribute(SETTINGS_ATTR, 'collapsed')
  }
}

/** 面板挂载/卸载观察（打开即收起态；关闭/重开自动复位）。 */
const panelObserver = new MutationObserver(() => {
  const next = findSettingsPanel()
  if (next === panel) return
  const fresh = panel === null && next !== null
  panel = next
  if (fresh && narrowQuery?.matches === true) {
    // 初始落位：直接钉到收起态并压制首帧动画（见 NOANIM_ATTR CSS）。
    // 下一帧摘除标记，之后的收起/展开照常播动画。
    next.setAttribute(SETTINGS_ATTR, 'collapsed')
    next.setAttribute(NOANIM_ATTR, 'true')
    requestAnimationFrame(() => { next.removeAttribute(NOANIM_ATTR) })
  } else {
    applyMode()
  }
})

/**
 * 安装手机端设置页改造（client.ts apply 调用）。返回拆除函数（样式/
 * matchMedia/面板观察者/点击拦截）——client.ts 单实例拆除协议登记用，
 * 模块热替换时旧实例资源随协议整体清理，不再堆积。
 */
export function installSettingsMobile(): () => void {
  // 先移除上一份同标记样式（热替换重装时避免 <head> 无限堆积副本）。
  document.querySelector('style[data-meow-smooth-settings-css]')?.remove()
  const style = document.createElement('style')
  style.dataset.meowSettingsCss = 'true'
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)

  const mq = window.matchMedia(BREAKPOINT)
  narrowQuery = mq
  const onNarrowChange = (): void => { applyMode() }
  mq.addEventListener('change', onNarrowChange)
  panelObserver.observe(document.body, { subtree: true, childList: true })
  document.addEventListener('click', onSettingsClickCapture, { capture: true })

  // 初始扫描：插件在设置面板已打开时热重载的兜底。
  panel = findSettingsPanel()
  applyMode()

  return (): void => {
    style.remove()
    mq.removeEventListener('change', onNarrowChange)
    panelObserver.disconnect()
    document.removeEventListener('click', onSettingsClickCapture, { capture: true })
  }
}
