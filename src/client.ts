/**
 * meow-smooth — 喵丝滑（client 端）。
 *
 * 前端行为增强（纯插件，不改 dsh 本体）：
 *
 * 1. 输入框失焦折叠：composer 输入框（textarea）失去焦点时，把自适应高度
 *    折叠回 1 行；再次聚焦/点击时展开回草稿实际高度（滚动位置保留）。
 *    机制：输入框高度 = mirror 撑高 + [data-input-scroll] 滚动窗
 *    （CSS max-height 14 行上限，见 InputBar.module.css .scroll）。折叠 =
 *    插件 CSS 把滚动窗 max-height 压到 1 行（30px = 24px line-height +
 *    4px 上 padding），不动 mirror/backdrop/textarea 三层结构；document
 *    级 focusin/focusout 事件委托判定进出卡片（[data-composer-card]），
 *    pointerdown 兜底：点卡片任意处即展开（非交互区域顺带聚焦 textarea），
 *    scrollTop 存 WeakMap 展开时恢复（防视口错位）。
 *
 * 2. 手机端模型选择器折叠宽度：@media (max-width: 1023px) 把
 *    [data-slot="conversation.input.model"] 的 trigger 压到 96px、隐藏
 *    effort 文字（label 自带省略号）——trailing 不再把左边的按钮挤没。
 *
 * 3. 手机端禁止页面缩放：viewport meta 加 maximum-scale=1 +
 *    user-scalable=no、CSS touch-action: manipulation（防双击缩放）、
 *    iOS gesture 事件拦截（防捏合）。
 *
 * 4. 手机端输入框换行：粗指针（触屏）设备上 Enter 不再发送，capture 阶段
 *    拦截（早于 React onKeyDown）插入换行并派发 input 事件让受控层感知；
 *    Shift/Ctrl/Alt/Meta+Enter 与 IME 选词（isComposing/keyCode 229）
 *    不受影响。
 *
 * 5. 窄屏选中会话自动收起侧边栏：视口宽度 < 1024px（dsh 布局契约
 *    SIDEBAR_AUTO_COLLAPSE）时，切换 Session 后自动把侧边栏收成 rail。
 *    机制：隐形 dock（conversation.composer.dock，InputZone 随会话快照
 *    重渲染）监听 session.sessionId 变化；判定窄屏 + 当前展开（frame 无
 *    data-sidebar-collapsed）后调 ctx.layout.toggleSidebar()。
 *    toggleSidebar 在窄屏 flip narrowExpanded（收起）、宽屏 flip 宽度
 *    preference（会误展开）——所以必须严格判窄屏，宁可少收不可误展开。
 *    会话切换感知：composer.dock 是 session scope，切换时整槽位重挂，
 *    快照 sessionId 即新会话（不能加"首挂只记录"——会吞掉切换）。
 *
 * 6. 手机端点击侧边栏外自动收起：侧边栏展开时点击右侧空间（边栏以外
 *    区域）→ 自动收起。用 click（pointerup 之后）判定：拖拽滚动不产生
 *    click，且被点元素的动作先于收起重排完成，避免误点。
 *
 * 7. 手机端 Session log 按钮缩窄：隐藏按钮文字只留下载图标。
 * 8. 手机端模式选择（agent preset label）缩窄：只留 icon（font-size:0
 *    隐去文本，flex 布局下 icon 尺寸不受影响）。
 * 9. 打字时显示悬浮 Session name 条：输入法激活（键盘占屏 ≥25% 视口高，
 *    差值阈值；visualViewport resize + 粗指针轮询双通道，状态挂
 *    documentElement 不随 header 重挂丢失）→ 隐藏原生 header、body 层
 *    创建 fixed 悬浮条（z-index 9999，offsetTop 补偿钉屏幕顶部）；
 *    键盘收起销毁恢复原生。默认隐藏，只在输入法激活时显示。
 *
 * 10. 手机端后台任务数 / 子代理按钮缩窄：只留状态小图标（隐藏计数文字
 *     与右侧下拉箭头），空闲（无运行中任务/子代理）时中性灰点兜底；
 *     点小图标 = 点按钮本体 → 打开下拉列表（aria-label 保留）。
 *
 * 11. 手机端 header 横向滑动：Session name 完整显示、绝不截断（crumbs
 *     全宽），其余动作按窄形态依次排在 name 后面；内容超宽时 titleRow
 *     可左右滑动（滚动条隐藏，触屏原生滑动）。
 *
 * 12. 手机端审批/提问提醒（host 配合见 src/index.ts）：AI 工作中的权限
 *     申请与提问在手机端可能因窗口未开/未在目标会话而不显示。host 端
 *     审计投影 + 只读路由暴露未决审批细节（toolName/reason/命令/失效
 *     标记），client 3s 轮询；提问/计划审状态由 FoldDock 经 useSessions
 *     汇报（官方帧驱动，跨会话）。合并后在窄屏顶部显示 fixed 横幅：
 *     点"查看"跳转目标会话（ctx.sessions.open），官方面板接管则隐藏，
 *     未接管（帧丢失/服务重启的孤儿审批）则展开详情并提示可能已失效。
 *
 * 13. 折叠稳定性修复：折叠判定对比实测 1 行高（line-height + padding）
 *     而非滚动窗当前高度——旧逻辑把"无溢出"误判为"只有 1 行"，导致
 *     多行草稿（≤14 行内）永不折叠；折叠高度用 JS 实测写入 CSS 变量
 *     --meow-smooth-one-line（30px 兜底），任何主题都精确等于默认 1 行高；
 *     触屏点卡片外 click 兜底折叠（iOS/Android 点空白可能不移焦）。
 *
 * 14. 手机端禁用橡皮筋回弹：overscroll-behavior:none（html/body 与
 *     [data-slot="root"] 全树）+ JS touchmove 边界兜底（旧 iOS/安卓）：
 *     可滚动容器内正常滚动、到边界即拦，页面整体稳定如原生 app。
 *
 * 15. 电脑端尽力拦截页面缩放：桌面浏览器（Chrome/Edge/Firefox/Safari）
 *     的 Ctrl+滚轮 / 触控板捏合 / Ctrl+±/Ctrl+0 页面缩放是浏览器级行为，
 *     网页 JS 无法强制禁止（平台限制），能锁就锁：wheel(ctrlKey) 与
 *     keydown(Ctrl+±0) 的 preventDefault（部分环境/未来版本有效，无效
 *     也无害；只拦 Ctrl 修饰的缩放手势与缩放按键，绝不拦普通滚轮）。
 *     缩放检测提示层已按用户要求移除（"能锁缩放就锁，锁不了也无所谓"）。
 */

import { useEffect } from 'react'
import { installNotifyClient, type NotifyItem } from './notify-client.ts'

/** 官方类型的最小本地声明（构建零 @deepseek-ai 依赖）。
 *
 * 曾经 `import type` 自 @deepseek-ai/dsh-client-connection 与
 * dsh-client-ui-layout——esbuild 会擦除 type-only import（不解析模块），
 * 但 IDE/tsc 类型检查需要它们，而官方包 peer 链复杂（rc.8 家族依赖未
 * 发布的 @deepseek-ai/dsh-paths，npm 装不上）。这里声明实际用到的两个
 * 最小接口：SessionId 本质是 string；ILayout 只用 toggleSidebar()。
 * 结构类型兼容官方定义——官方接口新增方法不影响本声明。 */
type SessionId = string
interface ILayout {
  toggleSidebar(): void
}

/** 折叠状态属性（挂在 composer 卡片上）。 */
const FOLD_ATTR = 'data-meow-smooth'
/** 折叠态值。 */
const FOLD_COLLAPSED = 'collapsed'
/** 输入法激活标记（挂在 documentElement 上——不随会话 header 重挂丢失；
 *  CSS 据此隐藏原生 header，JS 据此显示/隐藏悬浮 Session name 条）。 */
const IME_ROOT_ATTR = 'data-meow-smooth-ime'
/** 悬浮条元素标记（body 直接子级：fixed 最上层，不与任何页面元素发生关系）。 */
const BAR_ATTR = 'data-meow-smooth-bar'

/** 菜单打开标记（挂在 titleRow 上）：CSS 据此放开 overflow 防裁剪，
 *  JS 据此补偿 scrollLeft 保持原位不回跳。 */
const HEADER_MENU_ATTR = 'data-meow-smooth-menu-open'
/** 1 行高度兜底：24px line-height + 4px 上 padding（InputBar.module.css
 *  契约）。实际折叠高度由 JS 实测后写入 --meow-smooth-one-line 变量
 *  （任何主题/字号都精确等于"未输入时的默认 1 行高度"）。 */
const FOLDED_MAX_HEIGHT = '30px'
/** 审批/提问提醒横幅元素标记（body 直接子级：fixed 顶部、z-index 9998、
 *  仅窄屏显示；IME 悬浮条 9999 优先。二者几乎不会同时出现——审批/提问
 *  pending 时 composer 被 takeover，无法打字）。 */
const PENDING_BAR_ATTR = 'data-meow-smooth-pending'

const FOLD_CSS = `
/* 过渡放基础态：折叠/展开双向都有动画。 */
[data-composer-card] [data-input-scroll] { transition: max-height 150ms ease; }
/* 折叠态：滚动窗压到 1 行，mirror/backdrop/textarea 结构不动。高度取
   JS 实测的 1 行高（--meow-smooth-one-line），未测量时回退 30px 契约值。 */
[data-composer-card][${FOLD_ATTR}="${FOLD_COLLAPSED}"] [data-input-scroll] {
  max-height: var(--meow-smooth-one-line, ${FOLDED_MAX_HEIGHT}) !important;
}
/* 输入法激活：隐藏原生 header（悬浮条独占顶部，避免重复与遮挡）。
   imeActive 在桌面恒为 false，属性永不设置，此规则不生效。 */
html[${IME_ROOT_ATTR}] [data-slot="conversation.session.header"] > header {
  display: none !important;
}
/* 悬浮 Session name 条：body 直接子级、fixed 钉屏幕顶部、最高层级，
   不与任何页面元素发生关系（不参与布局、不挡点击）。top 由 JS 按
   visualViewport.offsetTop 补偿（iOS 键盘弹起平移 layout viewport）。 */
[${BAR_ATTR}] {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  padding: calc(8px + env(safe-area-inset-top, 0px)) 16px 8px;
  text-align: center;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  pointer-events: none;
}
/* 手机端（< 1024px，dsh 布局断点 SIDEBAR_AUTO_COLLAPSE）：模型选择器
   折叠宽度——trigger 压到 96px、隐藏 effort 文字；模型名 label 自带
   ellipsis，超出自动省略。trailing 变窄后不再挤掉左侧按钮。 */
@media (max-width: 1023px) {
  [data-composer-card] [data-slot="conversation.input.model"] button[aria-haspopup="menu"] {
    max-width: 96px;
  }
  [data-composer-card] [data-slot="conversation.input.model"] button[aria-haspopup="menu"] > span:not(:first-child) {
    display: none;
  }
  /* Session log 按钮缩窄：只留下载图标，隐藏文字；去掉 min-width:111px
     与宽 padding（HeaderAction.module.css 契约）。 */
  [data-slot="conversation.session.header.utilities"] button span {
    display: none;
  }
  [data-slot="conversation.session.header.utilities"] button {
    min-width: 0;
    padding: 6px 8px;
  }
  /* 模式选择（agent preset label）折叠：只留 icon（font-size:0 隐去
     文本节点，flex 布局下 icon 尺寸不受影响）。点击展开时由内联样式
     恢复（data-meow-smooth-mode-expanded，见 onModeLabelToggle）。 */
  [data-slot="conversation.session.header.actions"] span[title] {
    font-size: 0;
    max-width: 20px;
  }
  /* 后台任务数按钮（job-list）缩窄：只留 StateDot 小图标，隐藏计数文字
     与右侧下拉箭头；点小图标 = 点按钮本体 → 打开下拉列表。无运行中
     任务（无 dot）时用中性灰点兜底，按钮不消失、仍可点开列表。 */
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) {
    min-width: 0;
    padding: 4px 6px;
    gap: 0;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) > span {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]) > svg:not([data-state]) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-expanded]:not([aria-haspopup]):not(:has(svg[data-state]))::before {
    content: '';
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  /* 子代理目录按钮（subagent-catalog）同样缩窄：只留 activitySlot 里的
     状态小图标；空闲（无运行中子代理）时 activitySlot 空置 → 中性灰点
     兜底。菜单开合逻辑在按钮本体 onClick，点图标即展开。 */
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] {
    min-width: 0;
    padding: 4px 6px;
    gap: 0;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] > span:not(:first-child) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"] > svg:not([data-state]) {
    display: none;
  }
  [data-slot="conversation.session.header.actions"] button[aria-haspopup="tree"]:not(:has(svg[data-state])) > span:first-child::before {
    content: '';
    display: block;
    width: 6px;
    height: 6px;
    margin: auto;
    border-radius: 50%;
    background: currentColor;
  }
  /* header 横向滑动：Session name 完整显示、绝不截断，其余动作按优化后
     的窄形态依次排在 name 后面；内容超宽时 titleRow 可左右滑动（滚动条
     隐藏，触屏原生滑动；桌面 <1024px 窄窗口同理可用 shift+滚轮）。 */
  [data-slot="conversation.session.header"] > header > div:first-child {
    overflow-x: auto;
    overflow-y: hidden;
    flex-wrap: nowrap;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  /* 下拉菜单打开时放开 titleRow 的 overflow：滚动容器会裁剪绝对定位的
     菜单（overflow-x:auto 下 overflow-y 不能保持 visible，菜单被截断/
     隐藏）。开关状态由 JS 打 data-meow-smooth-menu-open 属性
     （syncHeaderMenu）：打开瞬间记录 scrollLeft 并用 transform 平移补偿，
     header 停在原处不回跳；关闭时恢复 overflow 后写回 scrollLeft，
     位置全程不变。z-index 抬高避免 transform 层叠上下文被后续内容盖住。 */
  [data-slot="conversation.session.header"] > header > div:first-child[${HEADER_MENU_ATTR}] {
    overflow-x: visible;
    overflow-y: visible;
    position: relative;
    z-index: 200;
  }

  [data-slot="conversation.session.header"] > header > div:first-child::-webkit-scrollbar {
    display: none;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child {
    flex: none;
    min-width: max-content;
    overflow: visible;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav {
    flex: none;
    min-width: max-content;
    overflow: visible;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav > span {
    flex: none;
    white-space: nowrap;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:first-child > nav button {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
  }
  [data-slot="conversation.session.header"] > header > div:first-child > div:nth-child(2) {
    margin-left: 10px;
  }
  /* 手机端禁用橡皮筋回弹（app 化观感）：overscroll-behavior 拦文档级
     与链式回弹（现代 Chrome/Safari 16+，含安卓下拉刷新）；旧 iOS 由
     JS touchmove 兜底（onTouchStartOverscroll/onTouchMoveOverscroll）。 */
  html, body {
    overscroll-behavior: none;
  }
  [data-slot="root"], [data-slot="root"] * {
    overscroll-behavior: none;
  }
}
/* 防双击缩放（触屏双击放大页面）；捏合另由 viewport meta + gesture
   事件拦截（Chrome 安卓会忽略 user-scalable，此为尽力而为）。 */
html, body { touch-action: manipulation; }
/* 审批/提问提醒横幅（需求 12/13）：body 直接子级、fixed 钉屏幕顶部。
   默认隐藏（data-visible 由 JS 控制），仅窄屏（<1024px）显示——桌面有
   侧边栏状态点 + 官方 takeover 面板，不需要横幅。z-index 9998 让位于
   IME 悬浮条（9999），二者几乎不会同现（pending 时 composer 被接管）。 */
[${PENDING_BAR_ATTR}] {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9998;
  display: none;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #222);
  background: var(--dsw-specific-input-major, #f5f5f5);
  border-bottom: 1px solid var(--dsw-alias-border-l2, #ddd);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
[${PENDING_BAR_ATTR}][data-visible="true"] { display: block; }
@media (max-width: 1023px) {
  [${PENDING_BAR_ATTR}] { padding: calc(8px + env(safe-area-inset-top, 0px)) 12px 8px; }
  [${PENDING_BAR_ATTR}] .row {
    display: flex;
    align-items: center;
    gap: 8px;
    pointer-events: auto;
    cursor: pointer;
  }
  [${PENDING_BAR_ATTR}] .row .text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [${PENDING_BAR_ATTR}] .row .hint {
    flex: none;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--dsw-alias-bg-weak, rgba(0,0,0,0.06));
  }
  [${PENDING_BAR_ATTR}] .detail {
    display: none;
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--dsw-alias-bg-weak, rgba(0,0,0,0.05));
    pointer-events: auto;
  }
  [${PENDING_BAR_ATTR}][data-mode="detail"] .detail { display: block; }
  [${PENDING_BAR_ATTR}] .detail .head { font-weight: 600; }
  [${PENDING_BAR_ATTR}] .detail .meta { margin-top: 4px; opacity: 0.85; word-break: break-all; }
  [${PENDING_BAR_ATTR}] .detail .cmd {
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    background: var(--dsw-alias-bg-strong, rgba(0,0,0,0.08));
  }
  [${PENDING_BAR_ATTR}] .detail .dead { margin-top: 6px; color: #b45309; font-weight: 600; }
}
`

/** 每个滚动窗折叠前的 scrollTop（展开时恢复，防视口错位）。 */
const scrollTops = new WeakMap<HTMLElement, number>()

/** 事件目标的 composer 卡片（不在卡片内返回 null）。 */
function composerCardOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-composer-card]')
}

/** 展开卡片（幂等）：移除折叠属性 + 恢复滚动位置 + 清除动态 1 行高
 *  （回到 CSS 变量默认，避免旧主题残留）。 */
function expandCard(card: HTMLElement): void {
  if (card.getAttribute(FOLD_ATTR) !== FOLD_COLLAPSED) return
  card.removeAttribute(FOLD_ATTR)
  card.style.removeProperty('--meow-smooth-one-line')
  const scroll = card.querySelector<HTMLElement>('[data-input-scroll]')
  if (scroll !== null) {
    const saved = scrollTops.get(scroll)
    if (saved !== undefined) {
      scroll.scrollTop = saved
      scrollTops.delete(scroll)
    }
  }
}

/** 实测滚动窗 1 行内容高度（line-height + 上下 padding）。line-height
 *  为 'normal'（非 px）时按 font-size × 1.2 估算；全部失败回退 30px
 *  契约值。折叠高度与"1 行判定"共用此值，保证折叠后 = 真实默认高度。 */
function oneLineHeight(scroll: HTMLElement): number {
  const style = getComputedStyle(scroll)
  const pt = parseFloat(style.paddingTop)
  const pb = parseFloat(style.paddingBottom)
  const pad = (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(pb) ? pb : 0)
  let line = parseFloat(style.lineHeight)
  if (!(Number.isFinite(line) && line > 0)) {
    const fs = parseFloat(style.fontSize)
    line = Number.isFinite(fs) && fs > 0 ? Math.round(fs * 1.2) : 20
  }
  const total = line + pad
  return total > 0 ? total : 30
}

/** 折叠卡片到 1 行（幂等）：保存 scrollTop、写入实测 1 行高变量、打折叠
 *  属性。草稿不足 1 行时跳过（折叠无视觉变化）。所有折叠入口（失焦 /
 *  触屏点卡片外）共用，行为一致。 */
function collapseCard(card: HTMLElement): void {
  if (card.getAttribute(FOLD_ATTR) === FOLD_COLLAPSED) return
  const scroll = card.querySelector<HTMLElement>('[data-input-scroll]')
  if (scroll === null) return
  const one = oneLineHeight(scroll)
  // 判定"不足 1 行"必须对比实测 1 行高而非 scroll.clientHeight（那是
  // 被 mirror 撑高的当前多行高度——对比它会把所有无溢出草稿都当成
  // "1 行"跳过折叠，正是折叠不稳定的根因）。
  if (scroll.scrollHeight <= one + 1) return
  scrollTops.set(scroll, scroll.scrollTop)
  scroll.scrollTop = 0
  card.style.setProperty('--meow-smooth-one-line', `${one}px`)
  card.setAttribute(FOLD_ATTR, FOLD_COLLAPSED)
}

/** 视觉判定：键盘占屏是否 ≥20% 物理屏高（输入法激活）。
 *  用 screen.height 而非 innerHeight：Android Chrome 键盘弹起时页面
 *  同步 resize（innerHeight 与 visualViewport 一起缩小，差值≈0——
 *  "收起后再点输入框横条不出现"的根因）；screen.height 是物理屏高，
 *  不受页面 resize 影响。键盘占屏 35%+ 必然触发，浏览器地址栏/工具栏
 *  ~14% 不误判。桌面（精细指针）永不触发。 */
function imeActive(): boolean {
  if (!isCoarsePointer()) return false
  const vv = window.visualViewport
  if (vv === null || vv.height === 0) return false
  return window.screen.height - vv.height > window.screen.height * 0.2
}

/** 当前会话名（header 面包屑的当前段：nav 里最后一个 disabled 按钮）。 */
function sessionName(): string {
  const nameEl = document.querySelector('[data-slot="conversation.session.header"] nav button:disabled')
  return nameEl?.textContent?.trim() ?? ''
}

/** header 的 titleRow（面包屑所在行；header 首个子 div，横向滑动的宿主）。 */
function titleRow(): HTMLElement | null {
  const header = document.querySelector('[data-slot="conversation.session.header"] > header')
  if (header === null || !(header.firstElementChild instanceof HTMLElement)) return null
  return header.firstElementChild
}

/** 菜单打开期间 header 原位的横向位移（打开瞬间的 scrollLeft）。 */
let headerMenuScroll = 0

/** 菜单开关观察器（document 级 aria-expanded / childList；持有引用防 GC，
 *  观察器随插件生命周期存活）。 */
let menuGuard: MutationObserver | null = null

/** 菜单开合同步：打开 → 记录 scrollLeft + 打属性（CSS 放开 overflow，
 *  scrollLeft 归零）+ transform 平移补偿；关闭 → 去属性、恢复 overflow
 *  后把 scrollLeft 写回。全部在同一任务内完成，视觉位置不回跳。 */
function syncHeaderMenu(): void {
  const row = titleRow()
  if (row === null) return
  const anyOpen = row.querySelector('button[aria-expanded="true"]') !== null
  if (anyOpen) {
    if (row.getAttribute(HEADER_MENU_ATTR) !== 'true') {
      headerMenuScroll = row.scrollLeft
      row.setAttribute(HEADER_MENU_ATTR, 'true')
      row.style.transform = headerMenuScroll > 0 ? `translateX(${-headerMenuScroll}px)` : ''
    }
  } else if (row.getAttribute(HEADER_MENU_ATTR) === 'true') {
    row.removeAttribute(HEADER_MENU_ATTR)
    row.style.transform = ''
    void row.offsetWidth // 强制样式重算：属性移除后 overflow 恢复 auto
    row.scrollLeft = headerMenuScroll
  }
}

/** 橡皮筋抑制：最近触点坐标（touchstart 初始化，防首个 touchmove 伪位移）。 */
let lastTouchX = 0
let lastTouchY = 0
/** 橡皮筋抑制：本次手势最近的可滚动祖先（touchstart 定位，touchmove
 *  只做边界判定，避免每帧 getComputedStyle 走树）。 */
let overscrollNode: HTMLElement | null = null

/** touchstart：记录触点 + 定位最近可滚动祖先（overflow auto/scroll 且
 *  确实有溢出）。编辑控件（textarea/input）不参与——iOS 文本选择句柄
 *  拖动依赖原生 touchmove，拦截会弄坏选择。 */
function onTouchStartOverscroll(event: TouchEvent): void {
  overscrollNode = null
  if (event.touches.length !== 1) return
  const t0 = event.touches[0]
  lastTouchX = t0.clientX
  lastTouchY = t0.clientY
  const target = event.target
  if (!(target instanceof Element)) return
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return
  let node: Element | null = target
  while (node !== null && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    const oy = style.overflowY
    const ox = style.overflowX
    const sy = (oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1
    const sx = (ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 1
    if (sy || sx) {
      overscrollNode = node as HTMLElement
      return
    }
    node = node.parentElement
  }
}

/** touchmove（passive:false）：可滚动祖先在滑动方向还能滚 → 放行；
 *  已到边界或根本没有可滚动祖先 → preventDefault，阻断滚动链与文档级
 *  橡皮筋。双指（捏合缩放）不干预。 */
function onTouchMoveOverscroll(event: TouchEvent): void {
  if (event.touches.length !== 1) return
  const touch = event.touches[0]
  const dy = touch.clientY - lastTouchY
  const dx = touch.clientX - lastTouchX
  lastTouchY = touch.clientY
  lastTouchX = touch.clientX
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
  if (overscrollNode === null) {
    if (event.cancelable) event.preventDefault()
    return
  }
  const node = overscrollNode
  const canY = dy !== 0
    && ((dy < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1)
      || (dy > 0 && node.scrollTop > 0))
  const canX = dx !== 0
    && ((dx < 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
      || (dx > 0 && node.scrollLeft > 0))
  if (canY || canX) return
  if (event.cancelable) event.preventDefault()
}



/** 悬浮条元素（不存在则创建；body 直接子级，fixed 最上层）。 */
function barElement(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${BAR_ATTR}]`)
  if (existing !== null) return existing
  const bar = document.createElement('div')
  bar.setAttribute(BAR_ATTR, 'true')
  document.body.appendChild(bar)
  return bar
}

/** 悬浮条钉在屏幕顶部：iOS 键盘弹起会平移整个 layout viewport
 *  （visualViewport.offsetTop 变大），fixed 相对 layout viewport 会被
 *  推出屏幕——用 offsetTop 补偿钉回视觉视口顶部；顺带刷新会话名
 *  （键盘开着切换会话时 header 重挂）。 */
function pinBar(): void {
  const bar = document.querySelector<HTMLElement>(`[${BAR_ATTR}]`)
  if (bar === null) return
  const vv = window.visualViewport
  bar.style.top = vv === null || vv.offsetTop <= 0 ? '0px' : `${vv.offsetTop}px`
  const name = sessionName()
  if (bar.textContent !== name) bar.textContent = name
}

/** 设置输入法激活态（幂等）：状态挂 documentElement（不随 header 重挂
 *  丢失），激活时创建悬浮条并隐藏原生 header，解除时销毁。 */
function setImeState(on: boolean): void {
  const root = document.documentElement
  if (on) {
    if (root.getAttribute(IME_ROOT_ATTR) !== 'true') {
      root.setAttribute(IME_ROOT_ATTR, 'true')
      pinBar()
      if (barElement().textContent === '') {
        const name = sessionName()
        if (name !== '') barElement().textContent = name
      }
    }
    pinBar() // 已激活时也刷新（offsetTop/会话名可能变化）
  } else if (root.getAttribute(IME_ROOT_ATTR) === 'true') {
    root.removeAttribute(IME_ROOT_ATTR)
    document.querySelector(`[${BAR_ATTR}]`)?.remove()
  }
}

/** 最近一次用户点击 composer 卡片内的时间戳（区分"用户激活输入框"与
 *  dsh 切换会话自动聚焦——InputBar unlock effect 会在会话切换后
 *  自动 focus textarea，触屏上聚焦即弹键盘）。 */
let lastComposerPointer = 0

/** IME 状态统一同步（resize 与 500ms 轮询共用，转换检测只跑一次）：
 *  false→true 且最近无用户点击输入框（自动聚焦弹的键盘）→ blur 收起
 *  键盘、不显示条——切换会话只是看内容时键盘不该默认打开；有用户点击
 *  → 正常显示悬浮条。打字中（状态无转换）只刷新条位置，绝不干预。 */
let lastIme = false
function syncIme(): void {
  const now = imeActive()
  if (now === lastIme) {
    if (now) pinBar()
    return
  }
  lastIme = now
  if (now) {
    if (Date.now() - lastComposerPointer > 1000) {
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement && composerCardOf(active) !== null) {
        active.blur() // 无用户点击的键盘激活（会话切换自动聚焦）→ 收起
        return // 键盘即将收起，不显示条
      }
    }
    setImeState(true)
  } else {
    setImeState(false)
  }
}

/** 焦点进入卡片：若处于折叠态则展开并恢复滚动位置。 */
function onFocusIn(event: FocusEvent): void {
  const card = composerCardOf(event.target)
  if (card === null) return
  expandCard(card)
  // 触屏键盘的回车键显示为"换行"（配合需求 4：触屏 Enter 插入换行）。
  // 注意：这里不再直接压缩 header——键盘是否弹起由 visualViewport
  // 判定（imeActive），聚焦本身不是键盘信号（外接键盘/不自动弹键盘）。
  card.querySelector<HTMLTextAreaElement>('textarea')?.setAttribute('enterkeyhint', 'enter')
}

/** 焦点离开卡片：折叠到 1 行（保存 scrollTop）。重复监听时幂等。 */
function onFocusOut(event: FocusEvent): void {
  const card = composerCardOf(event.target)
  if (card === null) return
  // 焦点落在卡片内其他控件（模型选择等）不算离开。
  if (composerCardOf(event.relatedTarget) === card) return
  collapseCard(card)
  // 键盘收起由 visualViewport 恢复触发解除（imeActive），失焦本身不解除
  // （iOS 键盘"完成"键收起时焦点可能仍在输入框）。
}

/** 触屏兜底折叠：点卡片外任意处 → 折叠。iOS/Android 点空白区域键盘收起
 *  但焦点可能不移走（focusout 不触发），这是失焦折叠的唯一漏网场景。
 *  用 click（pointerup 之后）而非 pointerdown：拖拽滚动不产生 click，
 *  不会误伤"滚动聊天记录"。桌面（精细指针）由 focusout 覆盖，不启用。 */
function onDocumentClickCapture(event: MouseEvent): void {
  if (!isCoarsePointer()) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (composerCardOf(target) !== null) return
  const card = document.querySelector<HTMLElement>('[data-composer-card]')
  if (card !== null) collapseCard(card)
}

/** 模式图标点击：展开显示模式名（恢复内联 font-size/max-width 覆盖
 *  CSS 折叠态）；再点收起。 */
function onModeLabelToggle(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const label = target.closest<HTMLElement>('[data-slot="conversation.session.header.actions"] span[title]')
  if (label === null) return
  if (label.dataset.meowFoldModeExpanded === 'true') {
    delete label.dataset.meowFoldModeExpanded
    label.style.fontSize = ''
    label.style.maxWidth = ''
  } else {
    label.dataset.meowFoldModeExpanded = 'true'
    label.style.fontSize = '12px' // 恢复文本（CSS 折叠态 font-size:0）
    label.style.maxWidth = '180px'
  }
}

/** 点击模式图标以外区域：收起展开的模式名（capture 先于 toggle 执行）。 */
function onModeLabelDismiss(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('[data-slot="conversation.session.header.actions"] span[title]') !== null) return
  for (const label of document.querySelectorAll<HTMLElement>(
    '[data-slot="conversation.session.header.actions"] span[title][data-meow-smooth-mode-expanded="true"]',
  )) {
    delete label.dataset.meowFoldModeExpanded
    label.style.fontSize = ''
    label.style.maxWidth = ''
  }
}

/** 点击卡片任意处兜底展开：聚焦态判定外的补强（手机点输入框区域即展开）。
 *  交互控件（按钮/选择器/菜单项）不抢焦点；非交互区域顺带聚焦 textarea。
 *  同时记录用户主动点击时间戳（syncIme 区分自动聚焦键盘用）。 */
function onPointerDownCapture(event: PointerEvent): void {
  const card = composerCardOf(event.target)
  if (card === null) return
  lastComposerPointer = Date.now()
  expandCard(card)
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('button, select, input, textarea, a, [role="menuitem"], [role="menu"]')) return
  const ta = card.querySelector<HTMLTextAreaElement>('textarea')
  if (ta !== null && !ta.disabled && !ta.readOnly) ta.focus({ preventScroll: true })
}

/** 触屏（粗指针）判定：需求 4 只在手机/触屏设备生效，桌面键盘保持 Enter 发送。 */
let coarseCache: boolean | undefined
function isCoarsePointer(): boolean {
  if (coarseCache === undefined) {
    coarseCache = typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false
  }
  return coarseCache
}

/** 触屏 Enter → 换行：capture 阶段拦截（早于 React onKeyDown 的发送逻辑），
 *  手动插入换行并派发 input 事件让受控层（keyboard.setDraft）感知。
 *  Shift/Ctrl/Alt/Meta+Enter、IME 选词（isComposing/keyCode 229）放行。 */
function onKeyDownCapture(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.isComposing || event.keyCode === 229) return
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement) || target.readOnly || target.disabled) return
  if (composerCardOf(target) === null) return
  if (!isCoarsePointer()) return
  event.preventDefault()
  event.stopPropagation()
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? start
  const next = target.value.slice(0, start) + '\n' + target.value.slice(end)
  target.value = next
  const caret = start + 1
  target.setSelectionRange(caret, caret)
  target.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertLineBreak',
    data: '\n',
  }))
}

/** 禁止页面缩放：viewport meta 加 maximum-scale=1 + user-scalable=no
 *  （页面已有 meta 则原地补全，避免双 meta 冲突）。 */
function lockViewport(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  const want = 'maximum-scale=1, user-scalable=no'
  if (meta !== null) {
    const content = meta.getAttribute('content') ?? ''
    if (!content.includes('user-scalable')) {
      meta.setAttribute('content', `${content.replace(/,\s*$/, '')}, ${want}`)
    } else if (!content.includes('maximum-scale=1')) {
      meta.setAttribute('content', `${content.replace(/user-scalable=[^,]+/g, 'user-scalable=no')}, maximum-scale=1`)
    }
  } else {
    const created = document.createElement('meta')
    created.name = 'viewport'
    created.content = `width=device-width, initial-scale=1, ${want}`
    document.head.appendChild(created)
  }
}

/** 电脑端尽力拦截页面缩放（需求 15）。
 *
 * 桌面浏览器（Chrome/Edge/Firefox/Safari）的 Ctrl+滚轮 / 触控板捏合 /
 * Ctrl+± / Ctrl+0 页面缩放是浏览器级行为，网页 JS 无法强制禁止（与
 * 手机端 viewport meta 不同，平台限制）。能锁就锁：wheel(ctrlKey) 与
 * keydown(Ctrl+±0) 的 preventDefault——对部分环境/未来版本有效，无效
 * 也无害；只拦 Ctrl 修饰的缩放手势与缩放按键，绝不拦普通滚轮（不破坏
 * 正常滚动）与普通按键。缩放检测提示层已按用户要求移除（UX 干扰）。
 */
function lockDesktopZoom(): void {
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey) event.preventDefault()
  }, { capture: true, passive: false })
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    const code = event.code
    if (code === 'Equal' || code === 'Minus' || code === 'Digit0'
      || code === 'NumpadAdd' || code === 'NumpadSubtract' || code === 'Numpad0') {
      event.preventDefault()
    }
  }, { capture: true })
}

/** dsh 布局契约断点（ui-layout columns.ts SIDEBAR_AUTO_COLLAPSE）。 */
const SIDEBAR_AUTO_COLLAPSE = 1024

/** AppFrame 根元素：root slot 的 slot wrapper 的首个子元素。 */
function frameElement(): HTMLElement | null {
  const root = document.querySelector('[data-slot="root"]')
  if (root !== null && root.firstElementChild instanceof HTMLElement) return root.firstElementChild
  return null
}

/** 会话切换后：窄屏 + 侧边栏展开 → 收起。 */
function maybeCollapseSidebar(layout: ILayout): void {
  const frame = frameElement()
  if (frame === null) return
  // 窄屏判定与 AppFrame 一致（frame 宽，非 window）：窄屏 toggle 才 flip
  // narrowExpanded；宽屏 toggle 会翻转宽度 preference（误展开手动收起的）。
  if (frame.getBoundingClientRect().width >= SIDEBAR_AUTO_COLLAPSE) return
  if (frame.hasAttribute('data-sidebar-collapsed')) return // 已收起
  layout.toggleSidebar()
}

/** 手机端：侧边栏展开时点击右侧空间（边栏以外区域）→ 自动收起。
 *  用 click（pointerup 之后）而非 pointerdown：拖拽滚动不产生 click，
 *  且被点元素的动作先于布局变化完成，避免收起重排导致的误点。
 *  data-slot wrapper 是 display:contents（rect 全 0），所以用 DOM 包含
 *  判定为主、侧边栏渲染列（wrapper 子元素）rect 兜底。 */
function onClickDismissSidebar(event: MouseEvent, layout: ILayout): void {
  const frame = frameElement()
  if (frame === null) return
  if (frame.getBoundingClientRect().width >= SIDEBAR_AUTO_COLLAPSE) return // 宽屏不管
  if (frame.hasAttribute('data-sidebar-collapsed')) return // 已收起
  const target = event.target
  if (!(target instanceof Element)) return
  // 侧边栏 DOM 内、拖拽手柄、弹层（菜单/命令面板/审批/overlay）→ 不收起。
  if (target.closest(
    '[data-slot="sidebar"], [data-side="sidebar"], [role="menu"], [role="menuitem"], '
    + '[role="listbox"], [role="option"], [role="dialog"], [data-shell-overlay]',
  )) return
  // 视觉兜底：点击 x 仍在侧边栏渲染列内 → 不收起。
  const column = document.querySelector('[data-slot="sidebar"] > *')
  if (column instanceof HTMLElement && event.clientX < column.getBoundingClientRect().right) return
  layout.toggleSidebar()
}

/** 本地 pending 汇报条目（React 侧 useSessions 数据 → 横幅模块）。 */
interface LocalPendingItem {
  sessionId: string
  title: string
  status: 'approval' | 'question' | 'plan-review'
}

/** host 端 /plugins/meow-smooth/pending 返回的审批细节（结构子集）。 */
interface HostApproval {
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  command?: string
  askedAt: number
  orphan: boolean
}

/** host 端 /plugins/meow-smooth/pending 返回的未决提问（审计投影，
 *  客户端帧链路的权威兜底：断线重连丢帧后仍可显示横幅）。 */
interface HostQuestion {
  sessionId: string
  callId?: string
  planReview?: boolean
  askedAt: number
  orphan?: boolean
}

/** 横幅合并条目（host 审批 + 本地提问/计划审，统一呈现）。 */
interface MergedItem {
  sessionId: string
  title: string
  kind: 'approval' | 'question' | 'plan-review'
  /** 审批的稳定去重 id（host 投影；通知模块按此去重）。 */
  approvalId?: string
  toolName?: string
  reason?: string
  command?: string
  askedAt: number
  orphan?: boolean
}

// --- 横幅状态（React 侧汇报 + host 轮询 合并） ---
/** 最近一次 FoldDock 汇报的本地 pending（官方帧驱动，跨会话）。 */
let localPending: LocalPendingItem[] = []
/** 最近一次 FoldDock 汇报的当前会话（undefined = 无会话/列表页）。 */
let currentSessionId: string | undefined
/** host 轮询到的未决审批（含细节与 orphan 标记）。 */
let hostApprovals: HostApproval[] = []
/** host 轮询到的未决提问（审计投影；与 localPending 合并时 host 为准）。 */
let hostQuestions: HostQuestion[] = []
/** 横幅点击跳转回调（apply 闭包注入 ctx.sessions.open）。 */
let openSession: ((sessionId: string) => void) | undefined
/** 当前展示的主条目（renderBanner 写入，点击/详情用）。 */
let bannerItem: MergedItem | undefined
/** 横幅交互态：idle = 单行提示；detail = 展开详情。 */
let bannerMode: 'idle' | 'detail' = 'idle'

/** 官方 takeover 面板是否正在显示（当前会话的审批/提问/计划审被接管）。 */
function officialPanelVisible(): boolean {
  return document.querySelector(
    '[data-approval-key], [data-question-key], [data-plan-review-key]',
  ) !== null
}

/** 横幅元素（不存在则创建；body 直接子级，fixed 顶部）。 */
function pendingBarElement(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${PENDING_BAR_ATTR}]`)
  if (existing !== null) return existing
  const bar = document.createElement('div')
  bar.setAttribute(PENDING_BAR_ATTR, 'true')
  document.body.appendChild(bar)
  return bar
}

/** 横幅骨架（.row 提示行 + .detail 详情块；一次性创建）。 */
function ensurePendingBarSkeleton(bar: HTMLElement): void {
  if (bar.firstElementChild !== null) return
  const row = document.createElement('div')
  row.className = 'row'
  const text = document.createElement('span')
  text.className = 'text'
  const hint = document.createElement('span')
  hint.className = 'hint'
  row.append(text, hint)
  const detail = document.createElement('div')
  detail.className = 'detail'
  const head = document.createElement('div')
  head.className = 'head'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const cmd = document.createElement('div')
  cmd.className = 'cmd'
  const dead = document.createElement('div')
  dead.className = 'dead'
  detail.append(head, meta, cmd, dead)
  bar.append(row, detail)
  row.addEventListener('click', onPendingBarRowClick)
  detail.addEventListener('click', () => {
    bannerMode = 'idle'
    bar.removeAttribute('data-mode')
  })
}

/** 合并当前可见的待处理条目：host 审批（细节全）+ host 提问（审计投影
 *  权威）+ 本地提问/计划审（host 未覆盖的会话）。当前会话的项在官方
 *  面板已显示时剔除（避免与 takeover 面板重复）；官方面板未显示时保留
 *  （host 帧丢失/跳转前，横幅兜底）。approval 优先于提问/计划审（可应答
 *  性最强），同类按时间新→旧。 */
function mergedPendingItems(): MergedItem[] {
  const out: MergedItem[] = []
  const localBySession = new Map<string, LocalPendingItem>()
  for (const item of localPending) localBySession.set(item.sessionId, item)
  const panelShown = officialPanelVisible()
  for (const approval of hostApprovals) {
    if (approval.sessionId === currentSessionId && panelShown) continue
    const local = localBySession.get(approval.sessionId)
    out.push({
      sessionId: approval.sessionId,
      title: local?.title ?? '',
      kind: 'approval',
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      ...(approval.command !== undefined ? { command: approval.command } : {}),
      askedAt: approval.askedAt,
      orphan: approval.orphan,
    })
  }
  const hostQuestionSessions = new Set<string>()
  for (const question of hostQuestions) {
    if (question.sessionId === currentSessionId && panelShown) continue
    hostQuestionSessions.add(question.sessionId)
    const local = localBySession.get(question.sessionId)
    out.push({
      sessionId: question.sessionId,
      title: local?.title ?? '',
      kind: question.planReview === true ? 'plan-review' : 'question',
      askedAt: question.askedAt,
      orphan: question.orphan,
    })
  }
  for (const item of localPending) {
    if (item.status === 'approval') continue // approval 以 host 为准（细节全）
    if (hostQuestionSessions.has(item.sessionId)) continue // 提问以 host 投影为准
    if (item.sessionId === currentSessionId && panelShown) continue
    out.push({
      sessionId: item.sessionId,
      title: item.title,
      kind: item.status,
      askedAt: Date.now(),
    })
  }
  const rank = (kind: MergedItem['kind']): number => kind === 'approval' ? 0 : kind === 'question' ? 1 : 2
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || b.askedAt - a.askedAt)
  return out
}

/** 官方审批帧是否到达该会话（localPending 有 approval 状态 = 官方链路
 *  活着，跳转后面板应能显示；没有 = 帧未同步/已失效）。 */
function officialApprovalAlive(sessionId: string): boolean {
  return localPending.some(item => item.sessionId === sessionId && item.status === 'approval')
}

/** 展开详情（approval 显示 toolName/reason/命令/失效提示；提问/计划审
 *  无细节可展示，提示跳转即可）。 */
function showPendingDetail(item: MergedItem): void {
  bannerMode = 'detail'
  const bar = pendingBarElement()
  ensurePendingBarSkeleton(bar)
  bar.setAttribute('data-mode', 'detail')
  const head = bar.querySelector<HTMLElement>('.head')
  const meta = bar.querySelector<HTMLElement>('.meta')
  const cmd = bar.querySelector<HTMLElement>('.cmd')
  const dead = bar.querySelector<HTMLElement>('.dead')
  if (head === null || meta === null || cmd === null || dead === null) return
  if (item.kind === 'approval') {
    head.textContent = item.toolName === '' ? '权限申请' : `工具 ${item.toolName} 请求权限`
    meta.textContent = item.reason ?? ''
    meta.style.display = item.reason === undefined || item.reason === '' ? 'none' : ''
    cmd.textContent = item.command ?? ''
    cmd.style.display = item.command === undefined || item.command === '' ? 'none' : ''
    dead.style.display = item.orphan === true || !officialApprovalAlive(item.sessionId) ? '' : 'none'
    dead.textContent = '该申请可能已失效（无法应答），可忽略；若 AI 卡住请重发消息。'
  } else {
    head.textContent = item.kind === 'plan-review' ? '计划等待审批' : '提问等待回答'
    meta.textContent = ''
    meta.style.display = 'none'
    cmd.style.display = 'none'
    dead.style.display = item.orphan === true ? '' : 'none'
    dead.textContent = '该提问可能已失效（无法应答），可忽略；若 AI 卡住请重发消息。'
  }
}

/** 跳转目标会话（带重试）：会话列表未同步时 manager.select 抛
 *  "unknown session"，1.5s 后重试（列表加载完即成功），最多 3 次；
 *  仍失败或跳转能力不可用 → 展开详情并提示手动切换。 */
function jumpToSession(item: MergedItem, attempt = 0): void {
  if (openSession === undefined) {
    showPendingDetail(item)
    markJumpFailed()
    return
  }
  let thrown: unknown = null
  try {
    openSession(item.sessionId)
  } catch (error) {
    thrown = error
  }
  if (thrown !== null) {
    if (attempt < 3) {
      window.setTimeout(() => { jumpToSession(item, attempt + 1) }, 1500)
      return
    }
    showPendingDetail(item)
    markJumpFailed()
    return
  }
  // 跳转成功：1.5s 后检测官方面板（接管则隐藏横幅，未接管则展开详情）。
  window.setTimeout(() => {
    if (officialPanelVisible()) {
      updatePendingBanner()
    } else {
      showPendingDetail(item)
    }
  }, 1500)
}

/** 跳转失败提示（覆盖详情里的失效提示文本）。 */
function markJumpFailed(): void {
  const bar = pendingBarElement()
  const dead = bar.querySelector<HTMLElement>('.dead')
  if (dead === null) return
  dead.style.display = ''
  dead.textContent = '无法自动切换到目标会话（会话列表未同步），请在侧边栏手动选择该会话。'
}

/** 横幅提示行点击：目标会话非当前 → 跳转（带重试）；已是当前 → 展开详情。 */
function onPendingBarRowClick(): void {
  const item = bannerItem
  if (item === undefined) return
  if (item.sessionId !== currentSessionId) {
    jumpToSession(item)
    return
  }
  showPendingDetail(item)
}

/** 通知模块句柄（apply 安装；横幅刷新/轮询处调用）。 */
let notifyHandle: ReturnType<typeof installNotifyClient> | undefined

/** 合并条目 → 通知条目（approval 用 approvalId 去重，其余用 会话:类型）。 */
function notifyItemsOf(merged: MergedItem[]): NotifyItem[] {
  return merged.map(item => ({
    sessionId: item.sessionId,
    kind: item.kind,
    id: item.kind === 'approval' && item.approvalId !== undefined
      ? item.approvalId
      : `${item.sessionId}:${item.kind}`,
    title: item.title,
    ...(item.toolName !== undefined && item.toolName !== '' ? { toolName: item.toolName } : {}),
  }))
}

/** 横幅整体刷新：合并数据 → 更新提示行（保持 detail 态除非主条目变化）
 *  + 通知模块 pending 变化（页面 hidden 时弹系统通知）。 */
function updatePendingBanner(): void {
  const items = mergedPendingItems()
  notifyHandle?.onPending(notifyItemsOf(items))
  const bar = pendingBarElement()
  if (items.length === 0) {
    bannerItem = undefined
    bar.removeAttribute('data-visible')
    bar.removeAttribute('data-mode')
    bannerMode = 'idle'
    return
  }
  const item = items[0]
  if (bannerItem === undefined
    || bannerItem.sessionId !== item.sessionId || bannerItem.kind !== item.kind) {
    bannerMode = 'idle' // 主条目变了，收起的详情态作废
  }
  bannerItem = item
  ensurePendingBarSkeleton(bar)
  if (bannerMode === 'detail') bar.setAttribute('data-mode', 'detail')
  else bar.removeAttribute('data-mode')
  const text = bar.querySelector<HTMLElement>('.text')
  const hint = bar.querySelector<HTMLElement>('.hint')
  if (text === null || hint === null) return
  const name = item.title === '' ? '未命名会话' : item.title
  const what = item.kind === 'approval' ? '有权限申请待处理'
    : item.kind === 'plan-review' ? '有计划待审' : '有提问待回答'
  text.textContent = `${name} ${what}`
  hint.textContent = items.length > 1 ? `还有 ${items.length - 1} 条` : '查看'
  bar.setAttribute('data-visible', 'true')
}

/** React 侧汇报入口（FoldDock 每次快照变化调用）。 */
function reportLocalPending(items: LocalPendingItem[], current: string | undefined): void {
  localPending = items
  currentSessionId = current
  updatePendingBanner()
}

/** 轮询 host 审批投影（3s + 页面可见性恢复立即刷）。接口不可用
 *  （host 旧版/未装配）时静默降级：横幅只显示本地提问/计划审。
 *  响应里的 events（长任务完成）交给通知模块（localStorage 去重）。 */
async function pollHostApprovals(): Promise<void> {
  try {
    const res = await fetch('/plugins/meow-smooth/pending', { cache: 'no-store' })
    if (!res.ok) {
      hostApprovals = []
      hostQuestions = []
      updatePendingBanner()
      return
    }
    const data = await res.json() as {
      approvals?: HostApproval[]
      questions?: HostQuestion[]
      events?: { id: string; sessionId: string; toolCalls: number }[]
    }
    hostApprovals = Array.isArray(data.approvals) ? data.approvals : []
    hostQuestions = Array.isArray(data.questions) ? data.questions : []
    notifyHandle?.onPollResult({ events: data.events })
  } catch {
    hostApprovals = []
    hostQuestions = []
  }
  updatePendingBanner()
}

/** 安装横幅（apply 调用）：启动轮询 + 可见性刷新。open 为 undefined 时
 *  跳转不可用（sessions 服务缺失），点击横幅只展开详情并提示手动切换。 */
function installPendingBanner(open: ((sessionId: string) => void) | undefined): void {
  openSession = open
  void pollHostApprovals()
  window.setInterval(() => { void pollHostApprovals() }, 3000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollHostApprovals()
  })
}

/** 隐形 dock 条目：不渲染 UI，只随快照驱动"选中会话后收起侧边栏"。
 *  session 是 InputZone 的会话快照（ConversationSnapshot）——InputZone
 *  未从官方 /client 导出，这里用只读 sessionId 的结构子集（鸭子兼容）。
 *
 *  注意：composer.dock 是 session scope 槽位，会话切换时整个重挂（新
 *  实例）——因此不能用"首次挂载只记录"逻辑（会把切换吞掉，实测 bug）。
 *  每次 sessionId 变化（含重挂首渲染）都触发；安全性由
 *  maybeCollapseSidebar 保证：宽屏/已收起直接 return，页面加载时窄屏
 *  默认收起也无害——只有"窄屏 + 用户展开"时才会真正收起。 */
export interface FoldDockProps {
  session: { sessionId: SessionId }
  /** 会话切换回调（apply 闭包注入：窄屏+展开时收起侧边栏）。 */
  onSessionSwitch: () => void
  /** 本地 pending 汇报回调（apply 闭包注入 → 横幅模块）。 */
  reportPending: (items: LocalPendingItem[], currentSessionId: string | undefined) => void
  /** 全局会话列表快照（框架 PropsRuntime 提供：跨会话 pending 状态 +
   *  标题；会话未实例化也由 manager 跟踪，官方帧驱动）。 */
  useSessions: <T>(selector: (snapshot: unknown) => T) => T
}

export function FoldDock({ session, onSessionSwitch, reportPending, useSessions }: FoldDockProps): null {
  useEffect(() => {
    onSessionSwitch()
  }, [session.sessionId, onSessionSwitch])
  // 跨会话 pending 汇报（需求 12/13）：manager 对所有会话跟踪
  // pendingInteraction（含未实例化会话），官方帧到达即有。审批细节由
  // host 轮询补（toolName/reason/命令），这里只报状态与标题。
  const pendingItems = useSessions((snapshot) => {
    const raw = snapshot as { items?: { sessionId: string; title?: string; pendingInteraction?: string }[] } | null | undefined
    const items = raw?.items ?? []
    return items
      .filter(item => item.pendingInteraction !== undefined)
      .map(item => ({
        sessionId: item.sessionId,
        title: item.title ?? '',
        status: item.pendingInteraction as LocalPendingItem['status'],
      }))
  })
  useEffect(() => {
    reportPending(pendingItems, session.sessionId)
  }, [pendingItems, session.sessionId, reportPending])
  return null
}

/** 浏览器端插件体：注入 CSS + 事件委托 + 注册 composer.dock 隐形条目。 */
export const inject = ['slots', 'layout', 'sessions']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  // CSS 常驻全局（折叠由 data 属性驱动，规则在即生效）。
  const style = document.createElement('style')
  style.dataset.meowFoldCss = 'true'
  style.textContent = FOLD_CSS
  document.head.appendChild(style)

  // 禁止页面缩放（需求 3）：viewport meta + iOS 捏合拦截。
  lockViewport()
  document.addEventListener('gesturestart', (e) => e.preventDefault())
  document.addEventListener('gesturechange', (e) => e.preventDefault())
  // 电脑端禁止/缓解页面缩放（需求 15）：拦截 Ctrl 缩放手势/按键 +
  // 缩放偏离检测提示条（桌面浏览器缩放是浏览器级行为，JS 尽力而为）。
  lockDesktopZoom()

  // 失焦折叠（需求 1）：进出卡片判定 + 点击兜底展开 + 触屏 Enter 换行。
  // 幂等：重复监听时各分支先查状态再动作。
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('focusout', onFocusOut)
  document.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
  document.addEventListener('keydown', onKeyDownCapture, { capture: true })
  // 触屏兜底折叠：点卡片外任意处 → 折叠（iOS/Android 点空白可能不移焦，
  // focusout 不触发；click 判定不会误伤滚动）。
  document.addEventListener('click', onDocumentClickCapture, { capture: true })

  // 模式图标点击展开/收起（需求 4）：capture 先收起别处的，冒泡再切换本尊。
  document.addEventListener('click', onModeLabelDismiss, { capture: true })
  document.addEventListener('click', onModeLabelToggle)

  // 菜单开合同步（横向滑动防裁剪 + 位置保持）：document 级观察
  // aria-expanded 变化（点击/键盘/程序关闭全覆盖）；childList 兜底
  // 按钮整体卸载的情况（只在菜单开着时才复查，成本可控）。
  menuGuard = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const target = mutation.target
        if (target instanceof Element
          && target.closest('[data-slot="conversation.session.header"] > header') !== null) {
          syncHeaderMenu()
          return
        }
      } else {
        const row = titleRow()
        if (row !== null && row.getAttribute(HEADER_MENU_ATTR) === 'true') {
          syncHeaderMenu()
          return
        }
      }
    }
  })
  menuGuard.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded'],
    childList: true,
  })

  // 橡皮筋抑制（需求 12）：touchstart 定位滚动祖先 + touchmove 边界拦截
  // （passive:false 才能 preventDefault）。CSS overscroll-behavior 已覆盖
  // 现代浏览器，这里是旧 iOS/安卓的兜底。
  document.addEventListener('touchstart', onTouchStartOverscroll, { passive: true })
  document.addEventListener('touchmove', onTouchMoveOverscroll, { passive: false })



  // 输入法激活 → 悬浮 Session name 条（需求 3）+ 自动聚焦键盘抑制：
  // 判定 = 键盘占屏 ≥20% 物理屏高（screen.height 差值，Android 页面
  // resize 也不受影响）。syncIme 统一做 false→true 转换检测（resize
  // 与轮询共用 lastIme）：键盘激活且最近无用户点击输入框（dsh 切换
  // 会话自动聚焦的场景）→ 收起键盘、不显示条——"只在用户激活输入框
  // 时键盘才打开"；打字中（无转换）绝不干预。
  window.visualViewport?.addEventListener('resize', syncIme)
  window.visualViewport?.addEventListener('scroll', pinBar)
  if (isCoarsePointer()) {
    window.setInterval(syncIme, 500)
  }

  const slots = ctx?.slots
  if (slots === undefined || typeof slots.inject !== 'function') {
    console.warn('[meow-smooth] slots service unavailable; sidebar auto-collapse disabled')
    return
  }
  const layout = ctx?.layout as ILayout | undefined
  if (layout === undefined || typeof layout.toggleSidebar !== 'function') {
    console.warn('[meow-smooth] layout service unavailable; sidebar auto-collapse disabled')
    return
  }
  const sessions = ctx?.sessions as { open?: (sessionId: string) => void } | undefined
  // 手机端：侧边栏展开时点击右侧空间 → 自动收起（click 而非 pointerdown，
  // 见 onClickDismissSidebar 注释）。
  document.addEventListener('click', (event) => { onClickDismissSidebar(event, layout) }, { capture: true })
  // 审批/提问提醒横幅（需求 12/13）：host 轮询 + 本地 pending 汇报合并。
  // sessions 不可用时跳转回调为 undefined（横幅仍显示，提示手动切换）。
  let openSessionFn: ((sessionId: string) => void) | undefined
  if (sessions === undefined || typeof sessions.open !== 'function') {
    console.warn('[meow-smooth] sessions service unavailable; banner jump disabled')
  } else {
    openSessionFn = (sessionId: string) => { sessions.open(sessionId) }
  }
  installPendingBanner(openSessionFn)
  // 通知模块（需求 15）：页面内系统通知 + PWA/SW 桥。SW notificationclick
  // 的跳转指令与横幅跳转共用同一回调。
  notifyHandle = installNotifyClient({ openSession: openSessionFn })
  slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'meow-smooth',
    order: 90,
    inject: () => ({
      onSessionSwitch: () => maybeCollapseSidebar(layout),
      reportPending: reportLocalPending,
    }),
  }, FoldDock))
}
