/**
 * meow-smooth — 喵丝滑（client 端）。
 *
 * 前端行为增强（纯插件，不改 dsh 本体）：
 *
 * 1. 输入框失焦折叠：composer 输入框（textarea）失去焦点时，按端收窄——
 *    桌面折叠回 2 行、窄屏/手机折叠回 1 行（手机屏幕小，1 行留给内容）；
 *    再次聚焦/点击时展开回草稿实际高度（滚动位置保留）。
 *    机制：输入框高度 = mirror 撑高 + [data-input-scroll] 滚动窗
 *    （CSS max-height 14 行上限，见 InputBar.module.css .scroll）。折叠 =
 *    插件 CSS 把滚动窗 max-height 压到目标行数，不动
 *    mirror/backdrop/textarea 三层结构；document
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
 * 4. 手机端输入框换行：粗指针（触屏）设备上 Enter 不再发送——capture
 *    阶段只 stopPropagation 断掉官方 keydown→submit 路径，默认行为留给
 *    浏览器原生插入换行（v5.3 重写：旧版手动改 DOM+合成事件与受控层
 *    竞争，造成换行丢失/跳回）；Shift/修饰键与 IME 选词不受影响。
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
 * 12. 手机端审批/提问提醒卡片（host 配合见 src/index.ts）：AI 工作中的
 *     权限申请与提问在手机端可能因窗口未开/未在目标会话而不显示。host 端
 *     审计投影 + 只读路由暴露未决审批/提问（含会话标题，修"未命名会话"），
 *     client 3s 轮询；提问/计划审状态另由 FoldDock 经 useSessions 汇报
 *     （官方帧驱动，跨会话，host 未覆盖时补充）。合并后顶部显示系统通知
 *     样式的圆角卡片（v2：两行文字、下滑弹出、整卡点击进入、上滑隐藏、
 *     30s 静默防重弹）：官方面板接管则隐藏；跳转失败/面板未接管（iOS
 *     实例重建限制）→ 卡片 fail 提示与恢复办法。纯通知，不做输入。
 *
 * 13. 折叠稳定性修复：折叠判定对比实测 N 行高（line-height × N + padding）
 *     而非滚动窗当前高度——旧逻辑把"无溢出"误判为"只有 1 行"，导致
 *     多行草稿（≤14 行内）永不折叠；折叠高度用 JS 实测写入 CSS 变量
 *     --meow-smooth-fold-height（按 foldLines() 的目标行数实测），任何主题
 *     都精确等于目标行数高（桌面 2 行 / 窄屏 1 行，跨断点 resize 重算）；
 *     触屏点卡片外 click 兜底折叠（iOS/Android 点空白可能不移焦）。
 *
 * 14. 手机端禁用橡皮筋回弹：overscroll-behavior:none（html/body 与
 *     [data-slot="root"] 全树）+ JS touchmove 边界兜底（旧 iOS/安卓）。
 *     v2 链式判定（2026-08-22 表格竖滑修复）：收集全部可滚动祖先（含
 *     scrollingElement），链上任一环节能消费手势方向就放行原生滚动，
 *     全部到边界才拦——旧版只认"最近一个"可滚祖先且排除 body/html，起点
 *     落在静止态 overflow-x:hidden 的宽表/代码块等 x 向容器里时竖滑被吞。
 *
 * 17.1 触屏宽表常开横滑：本体宽表静止态 overflow-x:hidden（桌面悬停才显
 *     滚动条的美学），触屏无 hover → 宽表在手机上无法横向滑动看右侧列；
 *     @media (hover: none) 强制 .md-table-wide 常开 overflow-x:auto。
 *
 * 15. 电脑端尽力拦截页面缩放：桌面浏览器（Chrome/Edge/Firefox/Safari）
 *     的 Ctrl+滚轮 / 触控板捏合 / Ctrl+±/Ctrl+0 页面缩放是浏览器级行为，
 *     网页 JS 无法强制禁止（平台限制），能锁就锁：wheel(ctrlKey) 与
 *     keydown(Ctrl+±0) 的 preventDefault（部分环境/未来版本有效，无效
 *     也无害；只拦 Ctrl 修饰的缩放手势与缩放按键，绝不拦普通滚轮）。
 *     缩放检测提示层已按用户要求移除（"能锁缩放就锁，锁不了也无所谓"）。
 *
 * 17. 手机端消息操作行横向滑动：AI 回答下方的 复制/点赞/备注/分支 按钮 +
 *     时间·用时·首token·吐字速度 统计一行在手机上放不下，原生被祖先
 *     裁剪看不到尾部统计。把该行自身变成横向滚动容器（滚动条隐藏、
 *     触屏原生滑动、橡皮筋抑制 JS 自动识别为可滚动祖先），超宽内容
 *     左右滑着看。锚点=消息容器的 data-time-hover-root 属性 + 行的
 *     CSS Modules 哈希类名尾缀 [class*='_actions']——属性与 local 名
 *     稳定、哈希随版本变化也不影响；rc.6（3080）与 rc.2（3081）实测
 *     结构一致。Tooltip 气泡 position:fixed（无 transformed 祖先时不被
 *     祖先 overflow 裁剪）、备注弹层 portal 到 body，均不受影响。
 *
 * 18. 手机端竖条折叠为小方块（v3 原生切片重绘，2026-08-23 猫猫拍板）：
 *     收起状态的 56px 细竖条对寸土寸金的手机屏还是太宽——把整条竖条
 *     向上"折叠"成左上角一小块：原竖条宽度 56px、竖条同款底色、右缘
 *     同款灰色竖线（原生 sidebarCol 的分隔线），鱼 logo 待在原生几何
 *     位置——看起来就像竖条只在 Header 区存在、不往下延伸（v2 的贴角
 *     圆角标签被否："有点丑"）。会话 header 整体打 margin-left: 56px
 *     （标题/标签行/动作按钮随盒模型右移），与原生收起态逐像素对齐——
 *     纯 CSS 零测量（header 原生 padding 左右不对称且 furl 后计算值被
 *     污染，实测不可靠）。**色块与 header 同进退**（猫猫要求"始终跟
 *     Header 在一起"）：header 被隐藏（打字 IME 态由 html[ime] 规则即时
 *     同步 + tick 轮询按 computed display 打标记兜住任何其他隐藏来源）
 *     → 色块同步退场；header 显示 → 回归。新会话页空壳 header 不算隐藏
 *     （色块是那里唯一的侧边栏入口）。高度=header 实高（JS 实测，空壳
 *     时兜底 56）。两态流转：
 *     折叠（默认，只有小方块）→ 点小方块直接展开完整侧边栏；选会话/
 *     点边栏外收起后自动折回。展开时侧边栏内容叠一个"从上向下揭开"
 *     的辅助动画（translateY+fade），列滑出仍是本体自带的 grid 过渡。
 *     自适应切换（猫猫定稿）：竖条底部无插件按钮 → 两态（小方块 ⇄ 展开）；
 *     有插件按钮 → 三态：默认仍是折叠全屏文字，按小方块唤出细竖条（插件
 *     按钮可达）→ 按竖条顶部原生 toggle 展开 → 收起自动折回小方块。两种
 *     模式的默认态都是折叠。判定方式：竖条常驻 DOM（折叠时只是隐藏），
 *     运行时数竖条底部区（footArea）的按钮数——官方只有设置齿轮 1 个，
 *     第三方插件能加按钮的唯一扩展点是 sidebar.footer.action（list 槽，
 *     渲染在底部区），超出 1 个即三态。不数工作区区域：展开态那里是整棵
 *     会话树，settle 前后数量不一致会抖动误判。判定每次同步都跑，插件
 *     热装/热卸自动跟随（实测 3081 的 dsh-femwa 🎭 按钮即走三态）。
 *     实现：frame 的 data-sidebar-collapsed 是本体契约属性；furl 标记挂
 *     documentElement（不随 React 重渲染丢失）；grid-template-columns 用
 *     !important 压过 inline style 归零第一轨（窄屏 details 轨道恒为 0，
 *     写死安全），滑动动画复用本体 .frame 自带的 grid 过渡；列内容
 *     visibility:hidden 但保持挂载（display:none 会把后续 auto-placement
 *     列前移进第一轨）；小方块的鱼 logo 从竖条顶部原生按钮的 brand mark
 *     克隆，主题色跟随。
 */

import { useEffect, useRef } from 'react'
import { installNotifyClient, type NotifyItem } from './notify-client.ts'
import { installSettingsMobile } from './settings-mobile.ts'
import { installSidebarGesture } from './sidebar-gesture.ts'
import { createBusyEnterHook, RunSendButton, type RunSendMode } from './run-send.tsx'

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
/** 失焦折叠保留的行数：桌面 2 行（扫一眼上下文够接着写，又不占屏），
 *  窄屏 1 行（手机屏幕小，1 行留给内容）。按 foldLines() 的窄屏判定取值。 */
const FOLD_LINES_DESKTOP = 2
const FOLD_LINES_MOBILE = 1
/** 折叠高度兜底（仅 JS 未实测时生效）：桌面 = 单行 24px line-height +
 *  6px padding（InputBar.module.css 契约）× 2 行；窄屏 = 1 行 30px。
 *  实际折叠高度由 JS 按 foldLines() 实测写入 --meow-smooth-fold-height
 *  变量（任何主题/字号都精确等于目标行数高）。 */
const FOLDED_MAX_HEIGHT = '54px'
const FOLDED_MAX_HEIGHT_MOBILE = '30px'
/** 审批/提问提醒卡片元素标记（body 直接子级：fixed 顶部、z-index 9998、
 *  仅窄屏显示；IME 悬浮条 9999 优先。二者几乎不会同时出现——审批/提问
 *  pending 时 composer 被 takeover，无法打字）。 */
const PENDING_BAR_ATTR = 'data-meow-smooth-pending'
/** 电脑端判定（细指针）：桌面卡片策略=当前会话不弹卡片（官方面板接管
 *  即足够）；触屏保留"当前会话+面板未接管时显示卡片"（iOS 实例重建
 *  限制下点卡片 reload 恢复问题窗的兜底）。 */
const IS_DESKTOP = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: fine)').matches === true

/** 功能⑱ 竖条折叠标记（挂 documentElement——不随 frame 的 React 重渲染
 *  丢失；CSS 据此归零侧边栏轨道并显示小方块）。 */
const FURL_ROOT_ATTR = 'data-meow-smooth-furled'
/** 功能⑱ 小方块按钮标记（body 直接子级的 button）。 */
const FAB_ATTR = 'data-meow-smooth-fab'
/** 功能⑱ header 隐藏标记（挂在 fab 上）：header 计算样式 display:none 时
 *  由 tick 打上，CSS 据此隐藏色块（与 header 同进退的结构性兜底）。 */
const HEADER_HIDDEN_ATTR = 'data-meow-smooth-header-hidden'

const FOLD_CSS = `
/* 过渡放基础态：折叠/展开双向都有动画。 */
[data-composer-card] [data-input-scroll] { transition: max-height 150ms ease; }
/* 折叠态：滚动窗压到目标行数（桌面 2 行 / 窄屏 1 行），mirror/backdrop/
   textarea 结构不动。高度取 JS 实测的 N 行高（--meow-smooth-fold-height），
   未测量时回退契约值：桌面 54px（2 行），窄屏（<1024）30px（1 行）。 */
[data-composer-card][${FOLD_ATTR}="${FOLD_COLLAPSED}"] [data-input-scroll] {
  max-height: var(--meow-smooth-fold-height, ${FOLDED_MAX_HEIGHT}) !important;
}
@media (max-width: 1023px) {
  [data-composer-card][${FOLD_ATTR}="${FOLD_COLLAPSED}"] [data-input-scroll] {
    max-height: var(--meow-smooth-fold-height, ${FOLDED_MAX_HEIGHT_MOBILE}) !important;
  }
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
  /* 消息操作行横向滑动（需求 17）：复制/点赞/备注/分支按钮 + 时间·用时·
     首token·吐字速度统计在手机上一行放不下，原生被祖先裁剪。把行自身
     变成横向滚动容器：max-width 钳回容器宽（用户行 align-items:flex-end
     下行宽随内容、超宽时向左溢出），内容原样排开、超宽部分左右滑。
     锚点=容器 data-time-hover-root（官方只在用户行/turn-tail 根两处使用）
     的直接子级 [class*='_actions']（MessageIconActions 的 [hash]_actions，
     哈希前缀随版本变、_actions 尾缀不变；直接子级限定避免误伤页面其他
     模块的 *_actions）。滚动条隐藏 + 触屏惯性滚动；橡皮筋抑制 JS 按计算
     样式自动把该行识别为可滚动祖先（到边界才拦），无需额外配合。 */
  [data-time-hover-root] > [class*='_actions'] {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  [data-time-hover-root] > [class*='_actions']::-webkit-scrollbar {
    display: none;
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
/* 触屏设备宽表常开横向滚动（2026-08-22 表格竖滑修复的另一半）：本体的
   宽表（md-table-wide，≥4 列）静止态 overflow-x:hidden、悬停才变 auto——
   桌面"悬停才显滚动条"的美学，触屏没有 hover，结果是宽表在手机上完全
   无法横向滑动看右边的列。这里用本体文档承诺的稳定全局钩子强制常开
   （触屏是覆盖式滚动条，常开没有视觉代价）；桌面（有 hover）不动。
   !important 压过官方 (0,2,0) 的 module 类+全局类组合规则。 */
@media (hover: none) {
  .md-table-wide {
    overflow-x: auto !important;
    padding-bottom: 0 !important;
  }
}
/* 审批/提问提醒卡片（需求 12/13，v2：系统通知样式的圆角卡片，替代全宽
   横条）：fixed 顶部居中、圆角、下滑弹出动画；整卡可点（点击进入目标
   会话）、上滑手势隐藏。纯通知——回答永远在官方面板，卡片不做输入。
   z-index 9998 让位于 IME 悬浮条（9999），二者几乎不会同现。 */
[${PENDING_BAR_ATTR}] {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top, 0px));
  left: 12px;
  right: 12px;
  z-index: 9998;
  display: none;
  border-radius: 14px;
  background: var(--dsw-specific-input-major, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  transform: translateY(calc(-100% - 24px));
  transition: transform 260ms cubic-bezier(0.2, 0.8, 0.3, 1);
  pointer-events: none;
  -webkit-tap-highlight-color: transparent;
}
[${PENDING_BAR_ATTR}][data-visible="true"] {
  display: block;
  transform: translateY(0);
  pointer-events: auto;
}
[${PENDING_BAR_ATTR}] .toast-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  padding: 12px 14px 2px;
  color: var(--dsw-alias-label-primary, #222);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[${PENDING_BAR_ATTR}] .toast-sub {
  font-size: 12px;
  line-height: 18px;
  padding: 0 14px 12px;
  color: var(--dsw-alias-label-secondary, #666);
}
[${PENDING_BAR_ATTR}] .toast-fail {
  display: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 14px 12px;
  color: #b45309;
}
[${PENDING_BAR_ATTR}][data-mode="fail"] .toast-sub { display: none; }
[${PENDING_BAR_ATTR}][data-mode="fail"] .toast-fail { display: block; }
/* ---- 功能⑱ 手机端竖条折叠为小方块（furl，两态/三态自适应）---- */
/* 轨道归零：grid-template-columns 是 AppFrame 的 inline style（React 每次
   渲染都会重写），必须 !important 才能压过。窄屏下第三轨（details）恒为
   0——computeColumns 在视口 <996px 时 details 必然解出 0，写死安全。
   滑动动画复用本体 .frame 自带的 grid-template-columns 过渡（slow）。 */
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [data-slot="root"] > [data-sidebar-collapsed] {
    grid-template-columns: 0px minmax(0, 1fr) 0px !important;
  }
}
/* 竖条列内容：轨道 0 + overflow:hidden 已裁掉画面，但 visibility:hidden
   才不挡触控；不能用 display:none——它会让后续 auto-placement 的
   center/details 列前移进第一轨。border 同步透明防残留 1px 竖线；
   visibility 挂延迟 transition（离散过渡：到延时终点才翻转），收拢的
   滑动画播完再隐，观感是整条向左滑出屏幕。 */
html[${FURL_ROOT_ATTR}] [data-slot="root"] > [data-sidebar-collapsed] > :first-child {
  visibility: hidden;
  border-right-color: transparent;
  transition: visibility 0s var(--ds-transition-duration-slow, 300ms);
}
/* furl 态会话 header 让位：整个 header 打 margin-left = 竖条宽度 56px
 * （标题行、对话/轨迹标签行、动作按钮随盒模型整体右移）——与原生收起
 * 态（中心列从 x=56 起）逐像素一致，且完全无需测量 header 原生 padding
 * （左右不对称、furl 后计算值被污染，实测 20/28 不可靠）。margin 挂
 * 过渡，展开/折叠时标题平滑让位/回归。 */
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [data-slot="conversation.session.header"] > header {
    margin-left: 56px;
    transition: margin-left 200ms var(--ds-ease-in-out, ease);
  }
}
/* 小方块 = 原生侧边栏的"顶部切片"重绘（v3，猫猫拍板）：原竖条宽度
   56px、竖条同款底色（sidebar-fill）、右缘同款灰色竖线（border-l1，
   即原生 sidebarCol 的分隔线）——像竖条只在 Header 区存在、不往下
   延伸。直角、无阴影无圆角（原生就是这样的），鱼 logo 待在原生几何
   位置：竖条 padding 18px 上/10px 左 + logoRow 36px 内的 28px 按钮
   → svg 左上角 (12, 27)（鲸鱼标 24×17.66 在按钮内垂直居中的结果）。
   44px+ 触控面积由 56×56 的整块面积保证。z-index 9997：让位 IME 悬浮
   条(9999)与提醒卡片(9998)。 */
[${FAB_ATTR}] {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 9997;
  width: 56px;
  height: 56px; /* 兜底值：JS 按 header 实高动态覆盖（与 header 等高才规整） */
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  border-radius: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--dsw-specific-sidebar-fill, #ffffff);
  border: none;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, #222222);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  transition: height 200ms var(--ds-ease-in-out, ease);
}
[${FAB_ATTR}] svg {
  position: absolute;
  left: 12px;
  top: 27px;
}
[${FAB_ATTR}]:active svg { transform: scale(0.9); transition: transform 120ms ease; }
@media (max-width: 1023px) {
  html[${FURL_ROOT_ATTR}] [${FAB_ATTR}] { display: flex; }
}
/* 弹层避让：设置页/命令面板等 dialog、提醒卡片、IME 悬浮条出现时小方块
   暂时退场——它们都盖住左上角，留着只会误触（点"小方块"实际点到的是
   上层弹层）。弹层关掉自动回来。 */
body:has(div[role="dialog"]) [${FAB_ATTR}],
body:has([${PENDING_BAR_ATTR}][data-visible="true"]) [${FAB_ATTR}],
html[${IME_ROOT_ATTR}] [${FAB_ATTR}] {
  display: none !important;
}
/* 与 header 同进退（结构性兜底，猫猫要求"始终跟 Header 在一起"）：
   header 被 display:none 隐藏（打字 IME 态由 html[ime] 规则即时同步，
   此处兜住任何其他隐藏来源，≤500ms 轮询延迟）→ 色块同时退场；header
   显示 → 色块回归。标记由 JS 按 header 计算样式在 tick 里打。 */
[${FAB_ATTR}][data-meow-smooth-header-hidden] {
  display: none !important;
}
/* 展开辅助动画（"向下展开"的呼应）：窄屏展开瞬间侧边栏内容从上向下
   揭开（下移+淡入）。选择器在 frame 失去 data-sidebar-collapsed 的一
   瞬间开始命中 → 动画恰好播一次；收起后停止命中，下次展开重播。列
   本体的滑出仍由本体 grid 过渡负责，这里只给内容加纵向的"展开感"。
   transform 只存在于 260ms 动画期间，不影响常驻布局与 portal 弹层。 */
@media (max-width: 1023px) {
  [data-slot="root"] > *:not([data-sidebar-collapsed]) [data-slot="sidebar"] > * {
    animation: meow-smooth-unfold 260ms var(--ds-ease-in-out, ease);
  }
}
@keyframes meow-smooth-unfold {
  from {
    opacity: 0;
    transform: translateY(-16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 运行时发送按钮，外观复刻官方 primary；仅 AI 运行中渲染（空闲不显示），
   点击等价于输入框按一次回车，按 busyEnter 设置执行插话发送或排队。 */
[data-meow-run-send] {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 999px;
  /* 外观复刻官方 primary 发送按钮：信息蓝底 + 白图标（官方 css 契约）。 */
  background: var(--dsw-alias-button-info-fill);
  color: #fff;
  cursor: pointer;
  transition: background-color 100ms ease;
  /* 与官方 primary 相同的行内上移对齐。 */
  transform: translateY(-2px);
  /* 排到 .trailing 末尾，紧贴官方发送/停止按钮（中间不再隔 model/meter）。 */
  order: 10;
  padding: 0;
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
}
[data-meow-run-send]:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}
[data-meow-run-send]:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-meow-run-send] svg {
  width: 16px;
  height: 16px;
}
`

/** 每个滚动窗折叠前的 scrollTop（展开时恢复，防视口错位）。 */
const scrollTops = new WeakMap<HTMLElement, number>()

// ---- 输入框焦点链路诊断（2026-08-26 猫猫报"输入框卡住：点文字不出光标、
// 能选择却无法删除修改"——PWA 无 console，环形轨迹 + 关键节点上报 host
// /diag-log，GET /diag 读回分析。触屏专属；随构建保留为排障句柄。）----
const foldTrace: string[] = []
let foldSelLast = ''
let foldVisLastPost = 0
declare global {
  interface Window { __meowFoldTrace?: string[] }
}
if (typeof window !== 'undefined') window.__meowFoldTrace = foldTrace
/** 记一条轨迹。post=true 时同步上报 host（低频关键节点专用；input 等
 *  高频事件只入环形）。ae=当前 activeElement 标签，len=其 value 长度。 */
function noteFold(msg: string, post = false): void {
  try {
    const ae = document.activeElement
    const tag = ae instanceof HTMLTextAreaElement ? 'ta' : (ae instanceof HTMLElement ? ae.tagName : 'null')
    const extra = ae instanceof HTMLTextAreaElement ? ` len=${ae.value.length}` : ''
    foldTrace.push(`${Date.now() % 100000} ${msg} ae=${tag}${extra}`)
    if (foldTrace.length > 60) foldTrace.shift()
  } catch { /* 诊断绝不干扰主流程 */ }
  if (post) {
    try {
      void fetch('/plugins/meow-smooth/diag-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg: `fold ${msg}` }),
        keepalive: true,
      }).catch(() => { /* 离线/代理失败静默 */ })
    } catch { /* 忽略 */ }
  }
}
/** composer 卡片内 textarea 的编辑流监听（input/beforeinput/selectionchange
 *  ——高频，只入环形不上报）。apply 注册、disposers 拆除。 */
function installFoldDiagListeners(): () => void {
  const onInput = (event: Event): void => {
    if (!(event.target instanceof HTMLTextAreaElement) || composerCardOf(event.target) === null) return
    noteFold(`ipt len=${event.target.value.length}`)
  }
  const onBeforeInput = (event: Event): void => {
    if (!(event.target instanceof HTMLTextAreaElement) || composerCardOf(event.target) === null) return
    noteFold(`bei ${(event as InputEvent).inputType ?? '?'}`)
  }
  const onSelectionChange = (): void => {
    const ae = document.activeElement
    if (!(ae instanceof HTMLTextAreaElement) || composerCardOf(ae) === null) return
    const sel = document.getSelection()
    const type = sel?.type ?? '?'
    if (type === foldSelLast) return
    foldSelLast = type
    noteFold(`sel ${type}`)
  }
  document.addEventListener('input', onInput, true)
  document.addEventListener('beforeinput', onBeforeInput, true)
  document.addEventListener('selectionchange', onSelectionChange)
  return (): void => {
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('beforeinput', onBeforeInput, true)
    document.removeEventListener('selectionchange', onSelectionChange)
  }
}

/** 事件目标的 composer 卡片（不在卡片内返回 null）。 */
function composerCardOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-composer-card]')
}

/** 展开卡片（幂等）：移除折叠属性 + 恢复滚动位置 + 清除动态折叠行高
 *  （回到 CSS 变量默认，避免旧主题残留）。instant=true 时跳过 150ms
 *  过渡直接到位——聚焦路径专用：浏览器/iOS 的"聚焦上滚/键盘让位 pan"
 *  按【聚焦瞬间】的盒子几何判定是否滚动，过渡中的半高盒子会被判成
 *  "已可见"而放弃滚动，等长高后底部就压在键盘下（2026-08-26 猫猫报
 *  "重新展开有时被输入法遮挡"的根因之一）。瞬时展开让聚焦瞬间的几何
 *  = 终态几何，原生 reveal 判定必然正确。 */
function expandCard(card: HTMLElement, instant = false): void {
  if (card.getAttribute(FOLD_ATTR) !== FOLD_COLLAPSED) return
  noteFold(`exp${instant ? '!' : ''}`)
  card.removeAttribute(FOLD_ATTR)
  card.style.removeProperty('--meow-smooth-fold-height')
  const scroll = card.querySelector<HTMLElement>('[data-input-scroll]')
  if (instant && scroll !== null) {
    // 抑制本帧起的过渡：inline 覆盖 CSS transition，双 rAF 后恢复
    // （rAF1=样式已提交，rAF2=下一帧起恢复正常动画节奏）。
    scroll.style.transition = 'none'
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { scroll.style.transition = '' })
    })
  }
  if (scroll !== null) {
    const saved = scrollTops.get(scroll)
    if (saved !== undefined) {
      scroll.scrollTop = saved
      scrollTops.delete(scroll)
    }
  }
}

/** 当前折叠目标行数：窄屏（frame 宽 < 1024，dsh 布局契约断点，即手机/
 *  小窗）1 行，桌面 2 行。与功能⑤窄屏判定同源（frame 宽，非 window）；
 *  frame 未挂时退 window.innerWidth 兜底（首页等极早期场景）。 */
function foldLines(): number {
  const frame = frameElement()
  const width = frame !== null
    ? frame.getBoundingClientRect().width
    : (typeof window !== 'undefined' ? window.innerWidth : SIDEBAR_AUTO_COLLAPSE)
  return width < SIDEBAR_AUTO_COLLAPSE ? FOLD_LINES_MOBILE : FOLD_LINES_DESKTOP
}

/** 实测滚动窗 N 行内容高度（line-height × N + 上下 padding）。line-height
 *  为 'normal'（非 px）时按 font-size × 1.2 估算；全部失败回退 30px × N
 *  契约值。折叠高度与"N 行判定"共用此值，保证折叠后 = 真实默认高度。 */
function foldedHeight(scroll: HTMLElement, lines: number): number {
  const style = getComputedStyle(scroll)
  const pt = parseFloat(style.paddingTop)
  const pb = parseFloat(style.paddingBottom)
  const pad = (Number.isFinite(pt) ? pt : 0) + (Number.isFinite(pb) ? pb : 0)
  let line = parseFloat(style.lineHeight)
  if (!(Number.isFinite(line) && line > 0)) {
    const fs = parseFloat(style.fontSize)
    line = Number.isFinite(fs) && fs > 0 ? Math.round(fs * 1.2) : 20
  }
  const total = line * lines + pad
  return total > 0 ? total : 30 * lines
}

/** 折叠卡片到目标行数（桌面 2 行 / 窄屏 1 行，幂等）：保存 scrollTop、
 *  写入实测 N 行高变量、打折叠属性。草稿不足目标行数时跳过（折叠无视觉
 *  变化）。所有折叠入口（失焦 / 触屏点卡片外）共用，行为一致。 */
function collapseCard(card: HTMLElement): void {
  if (card.getAttribute(FOLD_ATTR) === FOLD_COLLAPSED) return
  noteFold('cld')
  const scroll = card.querySelector<HTMLElement>('[data-input-scroll]')
  if (scroll === null) return
  const h = foldedHeight(scroll, foldLines())
  // 判定"不足 N 行"必须对比实测 N 行高而非 scroll.clientHeight（那是
  // 被 mirror 撑高的当前多行高度——对比它会把所有无溢出草稿都当成
  // "N 行"跳过折叠，正是折叠不稳定的根因）。
  if (scroll.scrollHeight <= h + 1) return
  scrollTops.set(scroll, scroll.scrollTop)
  scroll.scrollTop = 0
  card.style.setProperty('--meow-smooth-fold-height', `${h}px`)
  card.setAttribute(FOLD_ATTR, FOLD_COLLAPSED)
}

/** 动态基线：无键盘态的 visualViewport 高度。screen.height 在分屏/折叠
 *  半窗下不再是可靠锚——半窗 vv 天生 ≈ 半屏，"对物理屏的差值"恒超 20%
 *  阈值（2026-08-31 猫猫报：折叠屏/分屏使用时永远只显示 IME 条、原生
 *  header 消失——旧判定恒误报）。键盘的本质信号是 vv 相对自身无键盘态
 *  的骤缩，用滑动基线替代 screen.height：
 *  变大 → 立即跟随（键盘收起/窗口变高/展开折叠屏）；
 *  缩小 <15% → 跟随（分屏分隔条缓拖、系统 UI 增减）；
 *  缩小 ≥15% → 仅当无编辑焦点信号才跟随（有焦点=疑似键盘，冻结基线防
 *  污染；折叠⇄展开、旋转等窗口形态突变都发生在无焦点时，靠此自愈）。 */
let vvBaseline = 0

/** 最近一次可编辑元素聚焦时间（键盘弹出的伴随信号）：窗口形态变化
 *  （折叠/分屏/旋转）的 vv 骤变发生时无编辑焦点，不误判键盘；蓝牙键盘
 *  聚焦但 vv 不缩也不误显示（屏幕无遮挡本就不需要条）。 */
let lastEditableFocusAt = 0

/** 视觉判定：键盘激活 = vv 相对动态基线骤缩 ≥25%（≥120px 绝对下限，
 *  防小窗噪声）且近期有可编辑元素聚焦。旧版
 *  "screen.height−vv.height > 20% 物理屏"在分屏/折叠半窗恒真，已废弃；
 *  键盘实际占屏 35%+，从任何合理基线都能检出。 */
function imeActive(): boolean {
  if (!isCoarsePointer()) return false
  const vv = window.visualViewport
  if (vv === null || vv.height === 0) return false
  const vh = vv.height
  // 焦点信号：当前正聚焦可编辑元素（打字中的常态——focusin 只发一次，
  // 不能只看 1200ms 时间戳）或刚聚焦过（blur 后键盘收起动画期）。
  const active = document.activeElement
  const editableActive = active instanceof HTMLTextAreaElement
    || active instanceof HTMLInputElement
    || (active instanceof HTMLElement && active.isContentEditable)
  const focusRecent = editableActive || Date.now() - lastEditableFocusAt < 1200
  if (vvBaseline === 0) {
    vvBaseline = vh // 首次调用建立基线（页面加载时键盘已弹出的场景：基线
    // 短暂偏低 → 本轮判 false，键盘收起后 vv 变大自动归位，自愈）
  } else if (vh > vvBaseline) {
    vvBaseline = vh
  } else if (vvBaseline - vh < vvBaseline * 0.15 || !focusRecent) {
    vvBaseline = vh
  } // else：缩 ≥15% 且有焦点 → 疑似键盘，冻结基线
  if (vvBaseline - vh < Math.max(vvBaseline * 0.25, 120)) return false
  return focusRecent
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
/** 橡皮筋抑制：本次手势的可滚动祖先链（touchstart 收集，近→远排序；
 *  touchmove 只做边界判定，避免每帧 getComputedStyle 走树）。
 *
 *  v2（2026-08-22 表格竖滑修复）：旧实现只取"最近一个"可滚动祖先，且把
 *  body/html 排除在外——两个洞：①起点落在静止态 overflow-x:hidden 的宽表
 *  包装层（本体桌面美学：悬停才显横滚条，触屏无 hover）里时，包装层不算
 *  可滚动、更外层的会话滚动容器又不在判定范围 → 链上"没有"可滚节点 →
 *  所有 touchmove 被无脑 preventDefault，页面竖滑被吞（代码块等 x 向滚动
 *  容器同理误伤）；②即使命中了 x 向滚动容器，竖向滑动它消费不了也不放行
 *  给外层。新语义=原生滚动链等价物：收集全部可滚动祖先（含文档级
 *  scrollingElement），touchmove 时链上任一环节能消费该方向位移就放行，
 *  全部到边界才 preventDefault——页面边缘防回弹（本功能初衷）不变。 */
let overscrollChain: HTMLElement[] = []

// ---- 轴仲裁（2026-09-01 猫猫报：表格/工具行展开内容上滑动页面不动）----
// 根因（probe-touch-slide3 实锤）：竖滑落在 overflow-x:auto 且 sw>cw 的容器
// （超宽表格/横滚代码块/统计行）上时，Chrome 把手势 latch 到该容器——竖向
// 位移整个丢弃且**不 scroll-chaining 给外层**（页面纹丝不动；我们没拦 pd=0，
// touch-action: pan-y 也救不了）。femGen 仓库卡片同款老大难的解法=move 确认
// 意图后 JS 接管（round49）：竖向主导 → preventDefault + 手动滚 y 链（无原生
// 惯性，touchend 用速度衰减 fling 补）；横向主导 → 放行容器自己原生横滚。
let axisPhase: 'idle' | 'undecided' | 'x' | 'y' = 'idle'
/** y 向滚动链的首个容器（竖向接管时的滚动目标；每次 move 从整链重找
 *  "该方向还能滚"的容器，滚到边界自然链给下一个）。 */
let axisYNode: HTMLElement | null = null
/** 竖向接管期间的滚动速度（px/ms，正=手指下移）——fling 初速。 */
let axisVel = 0
let axisLastT = 0
let flingRaf = 0
/** 手势起点（femGen round49 同款：判轴用**累计位移**——真机手指慢划时
 *  单帧 dy 仅 2-3px，按帧判永远达不到阈值=慢划冻死、"时灵时不灵"。 */
let axisStartX = 0
let axisStartY = 0
/** touchstart 时刻（长按识别：≥600ms 无移动=拖拽/长按语义，退出仲裁） */
let axisStartT = 0
/** 落点祖先链上有 touch-action:none（femwa 画布等自定义手势区）→ 本手势
 *  归自定义手势管，轴仲裁绝不接管（竖划=拖拽语义）。 */
let axisExcluded = false

/** 沿链滚 y 向：找第一个"该方向还有余量"的容器滚之；全到边界=不滚
 *  （防回弹，与橡皮筋语义一致）。delta>0=scrollTop 增大（手指上划，看
 *  下方内容）→ 要求**下方**有余量；delta<0=scrollTop 减小（手指下划，看
 *  上方内容）→ 要求**上方**有余量。⚠️方向别反：v1 把 -dy 代入后条件写成
 *  互补反向——会话总停在顶/底，反向条件恒 false=真机全冻（e2e 只测中部
 *  双向有余量，恰好掩盖）。 */
function scrollYChain(delta: number): void {
  for (const node of overscrollChain) {
    const canY = (delta > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1)
      || (delta < 0 && node.scrollTop > 0)
    if (canY) {
      node.scrollTop += delta
      return
    }
  }
}

/** 竖向接管后的惯性滑动：速度指数衰减，新触摸/低速/全边界即停。 */
function axisFlingStep(): void {
  flingRaf = requestAnimationFrame(() => {
    axisVel *= 0.94
    if (Math.abs(axisVel) < 0.04) {
      flingRaf = 0
      return
    }
    scrollYChain(-axisVel * 16.7)
    axisFlingStep()
  })
}

function onTouchEndAxis(): void {
  if (axisPhase === 'y' && Math.abs(axisVel) > 0.15 && flingRaf === 0) axisFlingStep()
  axisPhase = 'idle'
}

/** touchstart：记录触点 + 收集可滚动祖先链（overflow auto/scroll 且确实有
 *  溢出；body/html 本体经 document.scrollingElement 单独兜底——dsh 的滚动
 *  在容器内一般用不到它，普通整页滚动页面靠它保持行为正确）。
 *  ⚠️2026-09-02：编辑控件/composer 卡片的"整序列豁免"已退役——豁免=放行
 *  给原生，而真机合成器会 latch textarea/输入区（absolute 铺满无溢出 +
 *  潜在可滚身份）吞掉竖划，输入框滚动反而冻死（probe-composer-swipe 实锤
 *  双向 0 位移 pd=0）。输入框落点统一进轴仲裁：竖划接管滚
 *  [data-input-scroll]，选区/光标场景由 Range 守卫（手柄拖动选区在场）、
 *  长按退出（选词 ≥600ms 无移动）、纯点击（累计 <10px 不触发）三重保护。 */
function onTouchStartOverscroll(event: TouchEvent): void {
  // 轴仲裁状态重置（早退分支同样重置，防旧手势状态泄漏）；新触摸打断惯性。
  axisPhase = 'idle'
  axisExcluded = false
  axisYNode = null
  if (flingRaf !== 0) {
    cancelAnimationFrame(flingRaf)
    flingRaf = 0
  }
  if (gestureApi?.busy() === true) return // 手势拖拽中：橡皮筋逻辑完全旁路
  overscrollChain = []
  if (event.touches.length !== 1) return
  const t0 = event.touches[0]
  lastTouchX = t0.clientX
  lastTouchY = t0.clientY
  axisStartX = t0.clientX
  axisStartY = t0.clientY
  axisStartT = performance.now()
  const target = event.target
  if (!(target instanceof Element)) return
  let node: Element | null = target
  while (node !== null && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node)
      const oy = style.overflowY
      const ox = style.overflowX
      const sy = (oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1
      const sx = (ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 1
      if (sy || sx) overscrollChain.push(node)
      // 自定义手势区（touch-action:none，如 femwa 画布拖节点）→ 竖划是
      // 拖拽语义，轴仲裁绝不能接管。
      if (style.touchAction === 'none') axisExcluded = true
    }
    node = node.parentElement
  }
  const scroller = document.scrollingElement
  if (scroller instanceof HTMLElement && scroller.scrollHeight > scroller.clientHeight + 1) {
    overscrollChain.push(scroller)
  }
  // 轴仲裁：**全站落点无关接管**（2026-09-02 猫猫拍板——dsh 一切皆插件，
  // 别人机器上有无数未知插件，元件枚举不现实；真机合成器对"可 click 元素/
  // 截断行/任意结构"的 latch 不可预测，唯一确定方案=所有竖划都由 JS 滚）。
  // 排除仅剩：touch-action:none 区（画布拖拽）、编辑控件/composer（豁免）、
  // 选区拖动（move 守卫）、长按无移动（move 判定，拖拽语义退出）。
  axisPhase = 'undecided'
  axisLastT = 0
  axisVel = 0
  for (const node of overscrollChain) {
    const style = getComputedStyle(node)
    const oy = style.overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      axisYNode = node
      break
    }
  }
  noteFold(`os-ts chain=${overscrollChain.length} excl=${axisExcluded} tgt=${target instanceof Element ? target.tagName : '?'}`, true)
}

/** touchmove（passive:false）：全站轴仲裁主场。竖向 → 接管手动滚；横向 →
 *  放行原生横滚；整条 y 链到边界 → preventDefault（防回弹）。选区拖动/
 *  长按/双指等特殊语义在早退守卫里让路。 */
function onTouchMoveOverscroll(event: TouchEvent): void {
  // 手势拖拽中必须旁路：本 handler 读取 scrollTop/scrollHeight 等布局
  // 属性，而手势每帧写 grid 轨道标脏布局——读写交错会强制同步重排，
  // touchmove 高频触发下成倍放大（卡顿元凶之一）。
  if (gestureApi?.busy() === true) return
  // 文本选区在场（长按选词后出现，拖选区手柄扩展选区）→ 绝不
  // preventDefault：手柄拖动也是普通 touchmove，拦掉它 iOS 就取消整个
  // 序列的默认行为=选区冻结、"两条杠杠拖不动"（2026-08-25 猫猫报）。
  // Safari 浏览器里系统接管使该序列多为 cancelable=false 拦不住，故此
  // bug 只在 standalone PWA（cancelable=true）暴露；有选区时防回弹本来
  // 轮不到 JS 兜底（现代 iOS 由上方 CSS overscroll-behavior:none 负责）。
  const sel = document.getSelection()
  if (sel !== null && sel.type === 'Range') return
  if (event.touches.length !== 1) return
  const touch = event.touches[0]
  const dy = touch.clientY - lastTouchY
  const dx = touch.clientX - lastTouchX
  lastTouchY = touch.clientY
  lastTouchX = touch.clientX
  // --- 轴仲裁（全站落点无关接管）：竖向优先累计判轴（femGen 歪招"直接
  //     判定 dy"——真机手指起手必有横向抖动，|dy|>|dx| 判轴会先锁 x 再也
  //     出不来；累计 |dy|≥10 即竖向接管）。竖向 → preventDefault（拦 Chrome
  //     的 latch）+ 手动滚 y 链（scrollYChain 直接写 scrollTop，对
  //     cancelable=false 的合成器接管事件同样有效）；横向主导 → 放行（横滚
  //     容器自己原生滚）。长按 ≥600ms 无移动 → 拖拽/长按语义，本手势永久
  //     退出仲裁。 ---
  if (!axisExcluded && axisPhase !== 'x') {
    if (axisPhase === 'undecided') {
      const accDx = Math.abs(touch.clientX - axisStartX)
      const accDy = Math.abs(touch.clientY - axisStartY)
      if (performance.now() - axisStartT > 600 && accDx < 10 && accDy < 10) {
        axisExcluded = true // 长按无移动：拖拽/长按交互，退出仲裁并让路
        return
      }
      if (accDy >= 10) axisPhase = 'y'
      else if (accDx >= 24) axisPhase = 'x'
      if (axisPhase !== 'undecided') {
        noteFold(`os-axis=${axisPhase} accDy=${Math.round(accDy)} accDx=${Math.round(accDx)}`, true)
      }
    }
    if (axisPhase === 'y') {
      const now = performance.now()
      const dt = Math.max(1, now - axisLastT)
      axisVel = dy / dt
      axisLastT = now
      scrollYChain(-dy)
      if (event.cancelable) event.preventDefault()
      return // 本事件已被轴仲裁消费，橡皮筋判定跳过
    }
  }
  for (const node of overscrollChain) {
    const canY = dy !== 0
      && ((dy < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1)
        || (dy > 0 && node.scrollTop > 0))
    const canX = dx !== 0
      && ((dx < 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
        || (dx > 0 && node.scrollLeft > 0))
    if (canY || canX) return
  }
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

/** 程序化聚焦抑制（需求⑳，2026-08-24 猫猫：输入法弹起一下再收回很碍眼，
 *  压根别让它弹）。官方 InputBar unlock effect 在 mount/会话切换时无条件
 *  focus textarea（桌面体验好），触屏上 focus 即弹键盘——旧方案靠
 *  visualViewport 检测键盘已弹再 blur，天然慢一拍。本拦截器在 capture
 *  阶段同步 blur：focus→blur 同任务完成时键盘弹出动画不会启动。
 *
 *  判据：composer 卡片内 textarea 的 focusin，若近期（600ms）没有用户
 *  在卡片内的 pointerdown，即为程序化聚焦（unlock effect / 恢复焦点），
 *  立即撤焦；用户点输入框的路径有先行 pointerdown，照常放行。
 *  仅粗指针启用（桌面 autofocus 无害且是官方意图）；抑制器自身以
 *  suppressing 防重入。 */
let suppressing = false
const supTrace = (msg: string): void => {
  const w = window as unknown as Record<string, unknown>
  const arr = (w.__meowSuppressTrace as string[] | undefined) ?? []
  arr.push(`${Date.now() % 100000} ${msg}`)
  if (arr.length > 20) arr.shift()
  w.__meowSuppressTrace = arr
}
const suppressFocusIn = (event: FocusEvent): void => {
  document.documentElement.dataset.supCalled = 'yes'
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement) || !isCoarsePointer()) { supTrace('skip not-ta-or-fine'); return }
  if (composerCardOf(target) === null) { supTrace('skip outside card'); return }
  if (Date.now() - lastComposerPointer < 600) { supTrace('skip recent user pointer'); return }
  suppressing = true
  target.blur()
  suppressing = false
  noteFold('SUPPRESS blur', true)
  supTrace('suppressed programmatic focus')
}

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
        noteFold('ime+ autofocused -> blur', true)
        active.blur() // 无用户点击的键盘激活（会话切换自动聚焦）→ 收起
        return // 键盘即将收起，不显示条
      }
    }
    noteFold('ime+', true)
    setImeState(true)
  } else {
    noteFold('ime-', true)
    setImeState(false)
  }
}

/** 聚焦展开后的可视性修正兜底：键盘就位后若卡片底部仍在可视视口下方
 *  （键盘上缘之下），把可纵向滚动的祖先链向上滚、内层优先分配——
 *  覆盖"会话页聊天记录长、scrollBody 有余量"的场景。新会话页壳无任何
 *  有余量的滚动祖先（实测），那时只能依赖原生聚焦 reveal（配合瞬时
 *  展开保证几何正确）。幂等：修正完成后 needed≤0 自然不再写。
 *  只在 composer textarea 持焦时动作；visualViewport 缺席直接放弃。
 *
 *  量卡片不量 textarea（2026-08-28 猫猫报"电脑端长草稿选字滚动条狂跑、
 *  选不到开头"的根因）：textarea 被内部滚动窗 [data-input-scroll] 裁剪，
 *  草稿长、窗口停在上半段时 textarea 底边天然伸出视口底——那不是"被
 *  键盘遮住"，恰是"用户正要看开头"的正常态（实测：40 行草稿 textarea
 *  bottom=1204 而视口底=800，误判 needed=412 把输入窗内部拽下 412px）。
 *  卡片底边不受内部滚动影响，才是"composer 是否可见"的真边界；桌面
 *  无键盘，卡片完整可见时本函数恒为 no-op。 */
function ensureComposerVisible(): void {
  const active = document.activeElement
  if (!(active instanceof HTMLTextAreaElement)) return
  const card = composerCardOf(active)
  if (card === null) return
  const vv = window.visualViewport
  if (vv === null || vv.height === 0) return
  const rect = card.getBoundingClientRect()
  // 键盘上缘（布局视口坐标）≈ visualViewport 底边；底部超出即被遮。
  let needed = Math.ceil(rect.bottom - (vv.offsetTop + vv.height)) + 8 // 8px 呼吸边距
  if (needed <= 0) return
  noteFold(`vis need=${needed}`)
  const chain: HTMLElement[] = []
  // 内部滚动窗永远不进链（同一根因的另一半）：滚它救不了"卡片被键盘
  // 遮住"，只会毁掉用户在输入框里的阅读位置；可见性余量应全部分配给
  // 外层祖先——这才是本函数的本意。
  const inner = active.closest('[data-input-scroll]')
  let node: Element | null = active.parentElement
  while (node !== null && node !== document.documentElement) {
    if (node === inner) { node = node.parentElement; continue }
    if (node instanceof HTMLElement) {
      const oy = getComputedStyle(node).overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) chain.push(node)
    }
    node = node.parentElement
  }
  const se = document.scrollingElement
  if (se instanceof HTMLElement && se.scrollHeight > se.clientHeight + 1) chain.push(se)
  for (const box of chain) {
    if (needed <= 0) break
    const room = box.scrollHeight - box.clientHeight - box.scrollTop
    if (room <= 0) continue
    const take = Math.min(needed, room)
    box.scrollTop += take
    needed -= take
  }
  // 上报节流 800ms：键盘动画期 resize 连发，避免刷爆 host 端 100 条环形。
  if (Date.now() - foldVisLastPost > 800) {
    foldVisLastPost = Date.now()
    noteFold(`vis scrolled remain=${needed}`, true)
  }
}

/** 键盘动画期间的重试调度：iOS 键盘 ~250ms 弹起，visualViewport 连续
 *  变化，展开过渡也要 150ms——单次修正在中间态会算错几何。180/380ms
 *  双采样基本覆盖"键盘就位+展开完成"的稳定点（幂等无害多打几次）。 */
function revealSoon(): void {
  window.setTimeout(ensureComposerVisible, 180)
  window.setTimeout(ensureComposerVisible, 380)
}

/** 焦点进入卡片：若处于折叠态则展开并恢复滚动位置。
 *  焦点已被抑制器撤走（activeElement 不再是 target）时不展开——会话
 *  切换的自动聚焦被拦截后，卡片应保持折叠态（无焦点=无输入意图）。 */
function onFocusIn(event: FocusEvent): void {
  const card = composerCardOf(event.target)
  if (card === null) return
  if (event.target !== document.activeElement) return
  noteFold('fi', true)
  expandCard(card)
  revealSoon() // 键盘弹起/展开完成后的可视性兜底
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
  noteFold('fo', true)
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
 *  同时记录用户主动点击时间戳（syncIme 区分自动聚焦键盘用）。
 *
 *  展开必须瞬时（instant）：本 handler 之后紧跟 focus——浏览器/iOS 的
 *  聚焦上滚与键盘让位 pan 按聚焦瞬间的几何判定，过渡中的半高盒子会被
 *  判成"已可见"而放弃滚动（2026-08-26 猫猫报"重新展开有时被输入法遮挡"
 *  的主根因）。聚焦也不再 preventScroll：直接点 textarea 的原生路径
 *  （无 preventScroll）一直正常，这里对齐同一行为。 */
function onPointerDownCapture(event: PointerEvent): void {
  const card = composerCardOf(event.target)
  if (card === null) return
  const tgt = event.target instanceof Element ? event.target : null
  noteFold(`pd ${tgt?.closest('textarea') !== null ? 'ta' : 'card'}`, true)
  lastComposerPointer = Date.now()
  expandCard(card, true)
  revealSoon()
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('button, select, input, textarea, a, [role="menuitem"], [role="menu"]')) return
  const ta = card.querySelector<HTMLTextAreaElement>('textarea')
  if (ta !== null && !ta.disabled && !ta.readOnly) ta.focus()
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

/** 触屏 Enter → 换行：capture 阶段只断官方发送路径（stopPropagation，
 *  React root 收不到 keydown → 官方 submit 不触发），默认行为留给浏览器
 *  原生插入换行（v5.3 重写，详见函数内注释）。
 *  Shift/Ctrl/Alt/Meta+Enter、IME 选词（isComposing/keyCode 229）放行。 */
function onKeyDownCapture(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.isComposing || event.keyCode === 229) return
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement) || target.readOnly || target.disabled) return
  if (composerCardOf(target) === null) return
  if (!isCoarsePointer()) return
  noteFold('keyEnter', true)
  // 只断官方发送路径，把换行还给浏览器（2026-08-25 v5.3 重写，修"换行
  // 丢失/跳回"）：旧实现 preventDefault + 手动改 DOM value + setSelectionRange
  // + 派发合成 InputEvent——与本体受控层（textarea value={draft}）产生
  // DOM/state 不一致窗口，commit 前任何其他重渲染都会用旧 draft 写回
  // textarea（换行被抹掉="换不到"；晚一步覆盖="换到了又跳回"），且绕过
  // 官方 beforeinput 编辑跟踪与 Safari 布局修复。实际只需 stopPropagation：
  // 官方的 Enter→submit 挂在 React root 的 keydown 上，document capture
  // 断传播即收不到、不会发送；不 preventDefault 则 WebKit 原生插入换行，
  // beforeinput/input/onChange/mirror 全走原生节奏零竞争。
  event.stopPropagation()
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
function lockDesktopZoom(): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) return
    const code = event.code
    if (code === 'Equal' || code === 'Minus' || code === 'Digit0'
      || code === 'NumpadAdd' || code === 'NumpadSubtract' || code === 'Numpad0') {
      event.preventDefault()
    }
  }
  document.addEventListener('wheel', onWheel, { capture: true, passive: false })
  document.addEventListener('keydown', onKeyDown, { capture: true })
  return (): void => {
    document.removeEventListener('wheel', onWheel, { capture: true })
    document.removeEventListener('keydown', onKeyDown, { capture: true })
  }
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
  // 已在 0 档（收起 + furl）→ 无事可做；窄档（collapsed 不 furl）继续走
  // collapseToZero 收到 0 档——需求⑲ v3 后窄档是合法在场态，选会话后
  // 应自动折回小方块而不是停在细条。
  if (frame.hasAttribute('data-sidebar-collapsed') && furlRoot()) return
  // 手机端优先走手势模块的动画收起（宽档平滑滑出、无 rail 闪现）。
  if (gestureApi?.collapseToZero() === true) return
  layout.toggleSidebar()
  syncSidebarFurl() // 功能⑱：选会话收起后立即折回小方块
}

// --- 功能⑱ 手机端竖条折叠为小方块（furl，两态/三态自适应）---

/** 官方竖条底部区按钮基线（1 = 设置齿轮）。第三方插件能往竖条上加按钮
 *  的唯一扩展点是 sidebar.footer.action（list 槽），渲染在底部区——所以
 *  只数底部区（footArea）的按钮：超出 1 个即认定有插件用了竖条 → 小方块
 *  改走三态（按一下先出竖条，插件按钮可达），否则两态（直接展开）。
 *  不数工作区区域：那里展开态是整棵会话树（每行还挂操作按钮），收起
 *  动画 settle 前后数量不一致，会造成计数抖动误判；新会话按钮/toggle
 *  是官方固定件也无需数。竖条折叠期间只是 visibility:hidden，DOM 常驻，
 *  任何时刻都能数；判定每次同步都跑，插件热装/热卸自动跟随。 */
const OFFICIAL_FOOT_BUTTONS = 1

/** layout 服务是否就绪（apply 里检查后置 true）：两态的"展开"依赖
 *  ctx.layout.toggleSidebar，服务缺失时绝不折叠（否则用户没有入口）。 */
let layoutReady = false

/** furl 标记读写。 */
function furlRoot(): boolean {
  return document.documentElement.getAttribute(FURL_ROOT_ATTR) === 'true'
}
function setFurled(on: boolean): void {
  if (on) document.documentElement.setAttribute(FURL_ROOT_ATTR, 'true')
  else document.documentElement.removeAttribute(FURL_ROOT_ATTR)
}

/** 竖条顶部原生 toggle 按钮：侧边栏渲染列首个子元素（logoRow）里最后一
 *  个 button——wide 态品牌按钮在前、toggle 在后，收起态只剩它一个。
 *  Tooltip 不包额外元素时按钮直接命中，包了也能靠"子树内最后一个 button"
 *  兜住；结构变化返回 null，调用方自行降级。 */
function railToggleButton(): HTMLButtonElement | null {
  const column = document.querySelector('[data-slot="sidebar"] > *')
  const logoRow = column?.firstElementChild ?? null
  if (logoRow === null) return null
  const buttons = logoRow.querySelectorAll('button')
  return buttons.length > 0 ? buttons[buttons.length - 1] : null
}

/** 竖条自适应切换判定：数竖条底部区（footArea = 渲染列最后一个子元素）
 *  的 button 数，超出官方基线（1 个设置齿轮）即认定 sidebar.footer.action
 *  槽位有插件加了按钮 → 小方块走三态（按一下先出竖条，插件按钮可达），
 *  否则两态（按一下直接展开）。列未挂载按"无额外"处理（等挂载后下个
 *  tick 再判）。 */
function railHasExtraButtons(): boolean {
  const column = document.querySelector('[data-slot="sidebar"] > *')
  const foot = column?.lastElementChild ?? null
  if (foot === null) return false
  return foot.querySelectorAll('button').length > OFFICIAL_FOOT_BUTTONS
}

/** 三态模式：用户经小方块唤出过竖条（中间态）——true 期间轮询不得重新
 *  折叠；展开⇄收起转换时复位，收起即回折叠态。两态模式不使用。 */
let railRevealed = false
/** 上一次观测到的收起态（检测展开⇄收起转换用）；null = 尚未观测。 */
let lastRailCollapsed: boolean | null = null

/** 小方块按钮（body 直接子级，一次性创建）。点击行为在 apply 里接线
 *  （需要 layout 服务）：解除 furl 并直接展开完整侧边栏（两态）。 */
function sidebarFab(): HTMLButtonElement {
  const existing = document.querySelector<HTMLButtonElement>(`[${FAB_ATTR}]`)
  if (existing !== null) return existing
  const fab = document.createElement('button')
  fab.type = 'button'
  fab.setAttribute(FAB_ATTR, 'true')
  fab.setAttribute('aria-label', '打开侧边栏')
  document.body.appendChild(fab)
  return fab
}

/** 把竖条顶部原生按钮里的 DeepSeek 鱼 logo（brand mark svg）克隆进小
 *  方块：幂等；React 未挂完下个 tick 重试；结构变化克隆不到则标记放弃
 *  （留白方块仍可点，避免每 tick 反复查询）。 */
function populateFabIcon(): void {
  const fab = sidebarFab()
  if (fab.childElementCount > 0 || fab.dataset.meowFabIconFail === '1') return
  const toggle = railToggleButton()
  if (toggle === null) return
  const mark = toggle.querySelector('span svg')
  if (mark === null) {
    fab.dataset.meowFabIconFail = '1'
    return
  }
  fab.appendChild(mark.cloneNode(true))
}

/** 色块高度与 header 等高（猫猫：和现有 header 一样高才规整）+ 与 header
 *  同进退（header 被隐藏/被盖住 → 色块同步退场）：JS 实测 header 实高
 *  写入 fab inline style，底边与 header 底边重合。header 未挂载/空壳
 *  （新会话页 0×0）时保持 CSS 兜底 56px——空壳不算"隐藏"（那里色块是
 *  唯一的侧边栏入口）。隐藏判定两种：①计算样式 display:none（打字 IME
 *  等）；②覆盖检测——header 中心点 elementFromPoint 不属于 header 子树
 *  （全屏视图如 femGen 画布盖在 header 上）。值不变不写，避免无谓的
 *  样式重算。 */
function syncFabHeight(): void {
  const header = document.querySelector('[data-slot="conversation.session.header"] > header')
  const fab = sidebarFab()
  // 同进退：header 计算样式 display:none（如打字 IME 态，IME 由 html[ime]
  // CSS 规则即时同步，这里是兜住任何其他隐藏来源的结构性兜底）→ 打隐藏
  // 标记；header 显示 → 撤标记。新会话页空壳 header 不走此分支（display
  // 不是 none，只是没内容）。
  if (header === null) {
    fab.removeAttribute(HEADER_HIDDEN_ATTR)
    return
  }
  // 同进退的边界：header 被 display:none 隐藏 → 色块退场。但"无会话的
  // 空壳 header"（新会话页：官方同样以 display:none 渲染、且无任何子
  // 元素）不算隐藏——那里色块是唯一的侧边栏入口（猫猫拍板过"新会话页
  // 只留那一点点 sidebar"）。区分锚点：空壳无子元素；打字 IME 态
  // display:none 时子树保持挂载，不受影响。
  const isEmptyShell = header.firstElementChild === null
  let hidden = !isEmptyShell && getComputedStyle(header).display === 'none'
  // 覆盖检测（display:none 查不出的"隐藏"）：全屏视图（如 femGen 画布）
  // 盖在 header 上面时，header 中心点的最顶层元素不属于 header 子树 →
  // 视觉上 header 已被顶掉 → 色块同步退场。半透明 header 下滚动内容
  // 透出不受影响——内容在 header 下层，elementFromPoint 返回的仍是
  // header 子树（header 盒子本身是命中目标）。
  if (!hidden && !isEmptyShell) {
    const r = header.getBoundingClientRect()
    if (r.height > 1 && r.width > 1) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (top !== null && !header.contains(top)) hidden = true
    }
  }
  if (hidden) fab.setAttribute(HEADER_HIDDEN_ATTR, '1')
  else fab.removeAttribute(HEADER_HIDDEN_ATTR)
  const h = Math.round(header.getBoundingClientRect().height)
  if (!(h > 1)) return // 空壳 header（新会话页）→ 保持兜底 56
  if (fab.dataset.meowH === String(h)) return
  fab.dataset.meowH = String(h)
  fab.style.height = `${h}px`
}

/** 功能⑱状态同步（两态/三态自适应）：手机端（粗指针）+ 窄屏 + 侧边栏
 *  收起态 → 折叠成小方块（两种模式的默认态都是折叠）；展开态/宽屏/桌面
 *  一律还原原生。三态模式下"用户唤出过竖条"期间不重新折叠（竖条是
 *  中间态），展开⇄收起转换时复位。幂等，双通道驱动：500ms 轮询兜底
 *  （原生收起路径无钩子）+ 插件自身的收起动作后直调（即时折叠不闪竖条）。 */
function syncSidebarFurl(): void {
  // 手势进行中（需求⑲）一切自动折叠/展开干预冻结：拖拽里 enterDrag 已
  // 解除 furl 让 rail 本体跟手，此刻 tick 若再折回会毁掉拖拽状态。
  if (gestureApi?.busy() === true) return
  if (!layoutReady) return
  if (!isCoarsePointer()) {
    if (furlRoot()) setFurled(false)
    return
  }
  syncFabHeight()
  const frame = frameElement()
  if (frame === null) return
  const narrow = frame.getBoundingClientRect().width < SIDEBAR_AUTO_COLLAPSE
  const collapsed = frame.hasAttribute('data-sidebar-collapsed')
  if (lastRailCollapsed !== null && collapsed !== lastRailCollapsed) railRevealed = false
  lastRailCollapsed = collapsed
  // 已回 0 档（collapsed+furled）＝三态中间态结束：rail⇄小方块之间
  // data-sidebar-collapsed 全程不变，上面的转换检测清不掉 railRevealed
  // ——留着它会让本函数在下一个 tick 走"不得重新折叠"分支强制解除
  // furl，竖条"点外部收起后又立即弹回"（2026-08-28 猫猫报，3081 独有：
  // 三态模式只有装了侧栏插件的实例在走，3080 两态从不置 railRevealed）。
  if (collapsed && furlRoot()) railRevealed = false
  if (!narrow) gestureApi?.clearHold() // 离开窄屏（转宽屏/桌面）：窄档保持失效
  // 窄档停留（需求⑲手势拉出的原生 rail）与三态中间态一样是合法的收起
  // 停留态：不折回小方块，直到用户推回到 0（furl 分支会清 hold）。
  if (!narrow || !collapsed || railRevealed || gestureApi?.narrowHold() === true) {
    if (furlRoot()) setFurled(false)
    return
  }
  setFurled(true)
  gestureApi?.clearHold()
  populateFabIcon()
}

/** 手机端：侧边栏在场（展开态或手势拉出的窄档）时点击右侧空间 → 动画
 *  收起到 0 档。用 click（pointerup 之后）而非 pointerdown：拖拽滚动不产
 *  生 click，且被点元素的动作先于收起重排完成，避免误点。
 *  data-slot wrapper 是 display:contents（rect 全 0），所以用 DOM 包含
 *  判定为主、侧边栏渲染列（wrapper 子元素）rect 兜底。 */
function onClickDismissSidebar(event: MouseEvent, layout: ILayout): void {
  const dbg = (msg: string): void => { if (window.location.search.includes('meow-debug')) console.log(`[meow-smooth] dismiss: ${msg}`) }
  const frame = frameElement()
  if (frame === null) { dbg('no frame'); return }
  if (frame.getBoundingClientRect().width >= SIDEBAR_AUTO_COLLAPSE) { dbg('wide viewport'); return }
  const collapsed = frame.hasAttribute('data-sidebar-collapsed')
  const furled = furlRoot()
  if (collapsed && furled) { dbg('zero-tier, nothing to do'); return } // 0 档（小方块态）：侧边栏不在场，无事可做
  // 手势拖拽/磁吸进行中不干预（以手势模块内部状态为准，不受陈旧 DOM 标记影响）
  if (gestureApi?.busy() === true) { dbg('gesture busy'); return }
  const target = event.target
  if (!(target instanceof Element)) { dbg('target not element'); return }
  // 侧边栏 DOM 内、拖拽手柄、弹层（菜单/命令面板/审批/overlay）→ 不收起。
  const overlayHit = target.closest(
    '[data-slot="sidebar"], [data-side="sidebar"], [role="menu"], [role="menuitem"], '
    + '[role="listbox"], [role="option"], [role="dialog"], [data-shell-overlay]',
  )
  if (overlayHit !== null) { dbg(`inside overlay ${overlayHit.tagName}`); return }
  // 视觉兜底：点击 x 仍在侧边栏渲染列内 → 不收起（窄档时列右缘 ≈ 56px）。
  const column = document.querySelector('[data-slot="sidebar"] > *')
  if (column instanceof HTMLElement && event.clientX < column.getBoundingClientRect().right) {
    dbg(`inside column x=${event.clientX} right=${Math.round(column.getBoundingClientRect().right)}`)
    return
  }
  // 手机端优先动画收起（窄档/宽档统一：直接收到 0 档，无中间档停顿）。
  const taken = gestureApi?.collapseToZero() === true
  dbg(`collapseToZero → ${taken}`)
  if (taken) return
  layout.toggleSidebar()
  syncSidebarFurl() // 功能⑱：收起后立即折回小方块（不等 500ms tick）
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
 *  客户端帧链路的权威兜底：断线重连丢帧后仍可显示卡片）。title 由 host
 *  折叠 session/title 事件提供（修手机端"未命名会话"——local 快照标题
 *  在手机上常缺失）。 */
interface HostQuestion {
  sessionId: string
  callId?: string
  planReview?: boolean
  askedAt: number
  orphan?: boolean
  title?: string
}

/** host 端 /pending events 里 kind='failed' 的回合失败事件（v0.4.0+ host
 *  才会产出；系统通知由 notify-client 消费同一份数据，横幅卡片在这里）。 */
interface HostFailureEvent {
  id: string
  sessionId: string
  title?: string
  message?: string
  at: number
}

/** 横幅合并条目（host 审批 + 本地提问/计划审 + host 回合失败，统一呈现）。 */
interface MergedItem {
  sessionId: string
  title: string
  kind: 'approval' | 'question' | 'plan-review' | 'failed'
  /** 审批的稳定去重 id（host 投影；通知模块按此去重）。 */
  approvalId?: string
  /** failed 专有：稳定去重 id（sessionId:turn:error，localStorage 已读标记用）。 */
  failureId?: string
  /** failed 专有：失败摘要（host 已截断 120 字符）。 */
  message?: string
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
/** host 轮询到的回合失败事件（快照替换，随 host 队列 TTL 消失）。 */
let hostFailures: HostFailureEvent[] = []
/** 已在横幅展示过的失败事件 id（localStorage 持久化）：host 队列 TTL 10
 *  分钟内不重复弹卡。失败是"信息"不是"待办"，渲染过即算送达，点击/
 *  上滑只是提前收起。 */
const SEEN_FAILURES_KEY = 'meow-smooth:seen-failures'
const SEEN_FAILURES_CAP = 60
function loadSeenFailures(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_FAILURES_KEY)
    const list: unknown = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}
function markFailureSeen(id: string): void {
  seenFailures.add(id)
  try {
    const list = [...seenFailures].slice(-SEEN_FAILURES_CAP)
    localStorage.setItem(SEEN_FAILURES_KEY, JSON.stringify(list))
  } catch {
    // localStorage 不可用（隐私模式等）→ 仅本次会话去重。
  }
}
let seenFailures = loadSeenFailures()
/** 卡片点击跳转回调（apply 闭包注入 ctx.sessions.open）。 */
let openSession: ((sessionId: string) => void) | undefined
/** 会话列表强制刷新回调（apply 闭包注入 ctx.sessions.refresh；跳转遇
 *  "unknown session"（列表未同步）时先刷新再重试，修"新会话界面点卡片
 *  不跳转"）。 */
let refreshSessions: (() => Promise<void>) | undefined
/** 当前展示的主条目（renderBanner 写入，点击/详情用）。 */
let bannerItem: MergedItem | undefined
/** 卡片交互态：idle = 正常两行提示；fail = 跳转/面板未接管提示。 */
let bannerMode: 'idle' | 'fail' = 'idle'
/** 用户上滑隐藏后的静默期（同主条目 30s 内不重弹，避免轮询烦人）。 */
let suppressedUntil = 0
let suppressedKey = ''

/** 官方 takeover 面板是否正在显示（当前会话的审批/提问/计划审被接管）。 */
function officialPanelVisible(): boolean {
  return document.querySelector(
    '[data-approval-key], [data-question-key], [data-plan-review-key]',
  ) !== null
}

/** 卡片元素（不存在则创建；body 直接子级，fixed 顶部圆角卡片）。 */
function pendingBarElement(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[${PENDING_BAR_ATTR}]`)
  if (existing !== null) return existing
  const bar = document.createElement('div')
  bar.setAttribute(PENDING_BAR_ATTR, 'true')
  document.body.appendChild(bar)
  return bar
}

/** 卡片骨架（两行文字 + 失败提示；一次性创建；整卡点击进入、上滑隐藏）。 */
function ensurePendingBarSkeleton(bar: HTMLElement): void {
  if (bar.firstElementChild !== null) return
  const title = document.createElement('div')
  title.className = 'toast-title'
  const sub = document.createElement('div')
  sub.className = 'toast-sub'
  const fail = document.createElement('div')
  fail.className = 'toast-fail'
  bar.append(title, sub, fail)
  bar.addEventListener('click', onPendingBarClick)
  // 上滑隐藏（系统通知手势）：touch 累计位移 < -40px 视为上滑。
  let touchStartY = 0
  let touchDy = 0
  bar.addEventListener('touchstart', (event) => {
    touchStartY = event.touches[0]?.clientY ?? 0
    touchDy = 0
  }, { passive: true })
  bar.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY ?? touchStartY
    touchDy = y - touchStartY
  }, { passive: true })
  bar.addEventListener('touchend', () => {
    if (touchDy < -40) hideToast(true)
  })
}

/** 隐藏卡片：播放向上滑出动画（iOS 通知交互）后移除可见态；suppress 时
 *  静默同主条目 30s（用户上滑后不被轮询重新弹出）。 */
function hideToast(suppress = false): void {
  const bar = pendingBarElement()
  if (bar.getAttribute('data-visible') === 'true') {
    bar.style.transform = 'translateY(calc(-100% - 24px))'
    window.setTimeout(() => {
      bar.removeAttribute('data-visible')
      bar.style.transform = ''
    }, 240)
  } else {
    bar.removeAttribute('data-visible')
  }
  bar.removeAttribute('data-mode')
  bannerMode = 'idle'
  if (suppress && bannerItem !== undefined) {
    suppressedUntil = Date.now() + 30_000
    suppressedKey = `${bannerItem.sessionId}:${bannerItem.kind}${bannerItem.failureId !== undefined ? `:${bannerItem.failureId}` : ''}`
  }
}

/** 失败提示（跳转失败 / 面板未接管）：卡片切 fail 模式，6s 后自动恢复。 */
function showFailHint(text: string): void {
  const bar = pendingBarElement()
  ensurePendingBarSkeleton(bar)
  const fail = bar.querySelector<HTMLElement>('.toast-fail')
  if (fail !== null) fail.textContent = text
  bar.setAttribute('data-mode', 'fail')
  bar.setAttribute('data-visible', 'true')
  bannerMode = 'fail'
  window.setTimeout(() => {
    if (bannerMode === 'fail') {
      bannerMode = 'idle'
      document.querySelector<HTMLElement>(`[${PENDING_BAR_ATTR}]`)?.removeAttribute('data-mode')
    }
  }, 6000)
}

/** 合并当前可见的待处理条目：host 审批（细节全）+ host 提问（审计投影
 *  权威）+ 本地提问/计划审（host 未覆盖的会话）+ host 回合失败事件
 *  （v0.4.0+，渲染过即记已读）。当前会话的审批/提问项在官方面板已显示时
 *  剔除（避免与 takeover 面板重复）；失败项一律剔除当前会话（错误行就在
 *  眼前，卡片只提醒"不在场"的会话）。approval 优先于提问/失败/计划审，
 *  同类按时间新→旧。 */
function mergedPendingItems(): MergedItem[] {
  const out: MergedItem[] = []
  const localBySession = new Map<string, LocalPendingItem>()
  for (const item of localPending) localBySession.set(item.sessionId, item)
  const panelShown = officialPanelVisible()
  for (const approval of hostApprovals) {
    if (approval.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue
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
    if (question.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue
    hostQuestionSessions.add(question.sessionId)
    const local = localBySession.get(question.sessionId)
    out.push({
      sessionId: question.sessionId,
      title: question.title ?? local?.title ?? '',
      kind: question.planReview === true ? 'plan-review' : 'question',
      askedAt: question.askedAt,
      orphan: question.orphan,
    })
  }
  for (const item of localPending) {
    if (item.status === 'approval') continue // approval 以 host 为准（细节全）
    if (hostQuestionSessions.has(item.sessionId)) continue // 提问以 host 投影为准
    if (item.sessionId === currentSessionId && (panelShown || IS_DESKTOP)) continue
    out.push({
      sessionId: item.sessionId,
      title: item.title,
      kind: item.status,
      askedAt: Date.now(),
    })
  }
  for (const failure of hostFailures) {
    if (seenFailures.has(failure.id)) continue // 展示过即送达，TTL 内不重弹
    if (failure.sessionId === currentSessionId) continue // 正看着的会话：错误行就在眼前
    out.push({
      sessionId: failure.sessionId,
      title: failure.title ?? '',
      kind: 'failed',
      failureId: failure.id,
      ...(failure.message !== undefined ? { message: failure.message } : {}),
      askedAt: failure.at,
    })
  }
  const rank = (kind: MergedItem['kind']): number =>
    kind === 'approval' ? 0 : kind === 'question' ? 1 : kind === 'failed' ? 2 : 3
  out.sort((a, b) => rank(a.kind) - rank(b.kind) || b.askedAt - a.askedAt)
  return out
}

/** 跳转目标会话（带重试）：会话列表未同步时 manager.select 抛
 *  "unknown session"——先强制刷新列表（refreshSessions）再重试，最多
 *  3 轮；仍失败或跳转能力不可用 → 卡片 fail 提示手动切换。跳转成功后
 *  1.5s 检测官方面板：接管则卡片自然隐藏（无多余提示行）；未接管（iOS
 *  实例重建限制）→ fail 提示已知限制与恢复办法。 */
function jumpToSession(item: MergedItem, attempt = 0): void {
  if (openSession === undefined) {
    showFailHint('无法自动切换（跳转能力不可用），请在侧边栏选择该会话。')
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
      const retry = (): void => { window.setTimeout(() => { jumpToSession(item, attempt + 1) }, 800) }
      if (attempt === 0 && refreshSessions !== undefined) {
        // 首轮失败先刷新列表（手机端刚打开/列表未同步的常见原因）。
        void refreshSessions().then(retry).catch(retry)
      } else {
        retry()
      }
      return
    }
    showFailHint('无法自动切换（会话列表未同步），请在侧边栏选择该会话。')
    return
  }
  window.setTimeout(() => {
    if (officialPanelVisible()) {
      updatePendingBanner()
    } else {
      showFailHint('已进入会话，但问题窗未显示（iOS 已知限制），重开页面可恢复回答。')
    }
  }, 1500)
}

/** 卡片点击：目标会话非当前 → 跳转（带重试）；已是当前 → 卡片出现即
 *  面板未接管（接管时会被剔除）——点卡片 = 恢复问题窗：reload 页面
 *  （连接重开 → mux 基线重放 → 面板重建，即"重开就好"的机制）。 */
function onPendingBarClick(): void {
  const item = bannerItem
  if (item === undefined) return
  if (item.sessionId !== currentSessionId) {
    jumpToSession(item)
    return
  }
  if (officialPanelVisible()) {
    hideToast(false)
    return
  }
  window.location.reload()
}

/** 通知模块句柄（apply 安装；横幅刷新/轮询处调用）。 */
let notifyHandle: ReturnType<typeof installNotifyClient> | undefined

/** 手势模块句柄（需求⑲，apply 安装；syncSidebarFurl 据此豁免窄档停留——
 *  用户用手势拉出的原生 rail 是合法停留态，不能被 500ms tick 折回小方块）。 */
let gestureApi: ReturnType<typeof installSidebarGesture> | undefined

/** 合并条目 → 通知条目（approval 用 approvalId 去重，其余用 会话:类型）。
 *  failed 不走这里——它的系统通知由 notify-client 消费 events 数据负责
 *  （含页面 hidden 判定），横幅这边再转一份会双弹。 */
function notifyItemsOf(merged: MergedItem[]): NotifyItem[] {
  return merged
    .filter(item => item.kind !== 'failed')
    .map(item => ({
      sessionId: item.sessionId,
      kind: item.kind as 'approval' | 'question' | 'plan-review',
      id: item.kind === 'approval' && item.approvalId !== undefined
        ? item.approvalId
        : `${item.sessionId}:${item.kind}`,
      title: item.title,
      ...(item.toolName !== undefined && item.toolName !== '' ? { toolName: item.toolName } : {}),
    }))
}

/** 卡片整体刷新：合并数据 → 两行文字（会话名 + 提示）+ 通知模块
 *  pending 变化（页面 hidden 时弹系统通知）。用户上滑隐藏后同主条目
 *  30s 静默；主条目变化（新 pending）重新弹出。 */
function updatePendingBanner(): void {
  const items = mergedPendingItems()
  notifyHandle?.onPending(notifyItemsOf(items))
  const bar = pendingBarElement()
  if (items.length === 0) {
    bannerItem = undefined
    hideToast(false)
    return
  }
  const item = items[0]
  if (bannerItem === undefined
    || bannerItem.sessionId !== item.sessionId || bannerItem.kind !== item.kind
    || bannerItem.failureId !== item.failureId) {
    bannerMode = 'idle' // 主条目变了，收起 fail 态并解除静默（重新弹）
    suppressedUntil = 0
  }
  bannerItem = item
  const key = `${item.sessionId}:${item.kind}${item.failureId !== undefined ? `:${item.failureId}` : ''}`
  if (suppressedUntil > Date.now() && suppressedKey === key) return
  ensurePendingBarSkeleton(bar)
  if (bannerMode !== 'fail') bar.removeAttribute('data-mode')
  const titleEl = bar.querySelector<HTMLElement>('.toast-title')
  const subEl = bar.querySelector<HTMLElement>('.toast-sub')
  if (titleEl === null || subEl === null) return
  const name = item.title === '' ? '未命名会话' : item.title
  let what: string
  if (item.kind === 'failed') {
    // 失败卡片：渲染即记"已读"（host 队列 TTL 内不重弹；信息类非待办）。
    if (item.failureId !== undefined) markFailureSeen(item.failureId)
    what = item.message !== undefined && item.message !== ''
      ? `运行失败：${item.message.slice(0, 90)}${item.message.length > 90 ? '…' : ''}，点击查看…`
      : 'AI 回合因错误中断，点击查看…'
  } else {
    what = item.kind === 'approval' ? '有权限申请待处理，点击查看…'
      : item.kind === 'plan-review' ? '有计划待审，点击查看…' : '有提问待回答，点击查看…'
  }
  titleEl.textContent = name
  subEl.textContent = what
  bar.style.transform = '' // 清滑出动画的 inline 位移（显示态由 CSS 规则接管）
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
    // 聚焦状态随轮询上报（host 据此抑制系统通知：任一页面聚焦 → 不推
    // Web Push，卡片气泡提醒；跨 origin 时 SW 自身无法互相感知，host
    // 层统一判定）。
    const res = await fetch('/plugins/meow-smooth/pending', {
      cache: 'no-store',
      headers: { 'x-meow-focus': document.hasFocus() ? '1' : '0' },
    })
    if (!res.ok) {
      hostApprovals = []
      hostQuestions = []
      hostFailures = []
      updatePendingBanner()
      return
    }
    const data = await res.json() as {
      approvals?: HostApproval[]
      questions?: HostQuestion[]
      events?: { id: string; sessionId: string; toolCalls: number; kind?: string; title?: string; message?: string; at?: number }[]
    }
    hostApprovals = Array.isArray(data.approvals) ? data.approvals : []
    hostQuestions = Array.isArray(data.questions) ? data.questions : []
    const events = Array.isArray(data.events) ? data.events : []
    // 失败事件快照（横幅卡片用）；系统通知由 notify-client 消费同一数组。
    hostFailures = events
      .filter(event => event.kind === 'failed')
      .map(event => ({
        id: event.id,
        sessionId: event.sessionId,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
        at: typeof event.at === 'number' ? event.at : Date.now(),
      }))
    notifyHandle?.onPollResult({ events })
  } catch {
    hostApprovals = []
    hostQuestions = []
    hostFailures = []
  }
  updatePendingBanner()
}

/** 安装卡片（apply 调用）：启动轮询 + 可见性刷新。open 为 undefined 时
 *  跳转不可用（sessions 服务缺失），点击卡片提示手动切换。返回拆除函数
 *  （3s 轮询定时器 + visibilitychange 监听）——双实例时期轮询会翻倍堆积，
 *  且旧实例的横幅状态机与新实例各自为政。 */
function installPendingBanner(
  open: ((sessionId: string) => void) | undefined,
  refresh: (() => Promise<void>) | undefined,
): () => void {
  openSession = open
  refreshSessions = refresh
  void pollHostApprovals()
  const pollTick = window.setInterval(() => { void pollHostApprovals() }, 3000)
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void pollHostApprovals()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return (): void => {
    window.clearInterval(pollTick)
    document.removeEventListener('visibilitychange', onVisibility)
  }
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
  // 需求⑳：会话切换后撤掉自动聚焦——触屏上弹键盘很碍眼。
  // 官方 unlock effect 在 mount/session 切换时无条件 focus textarea；
  // 这里在 sessionId 变化后延迟检查并撤焦（setTimeout 确保 React effects
  // 全部完成后执行；50ms 远小于键盘弹出动画的启动时间）。
  useEffect(() => {
    if (!isCoarsePointer()) return
    const timer = window.setTimeout(() => {
      const ta = document.querySelector('[data-composer-card] textarea')
      if (ta instanceof HTMLTextAreaElement && document.activeElement === ta) {
        ta.blur()
      }
    }, 50)
    return () => window.clearTimeout(timer)
  }, [session.sessionId])

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
export const inject = ['slots', 'layout', 'sessions', 'conversation', 'settingsScope']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  // 排障分段标记：确认 apply 执行到哪一段（rev-lag 时区分新旧 bundle）。
  document.documentElement.dataset.meowApplyStage = 'enter'
  // 单实例拆除协议（2026-08-25 边栏循环动画 bug 根治）：dsh 模块热替换会
  // 在不刷新页面的情况下重新执行本脚本，旧实例的定时器/监听器此前从不
  // 拆除——新旧实例并存且内部状态分歧时（如旧实例 railRevealed=true、
  // 新实例全新状态），两边的 syncSidebarFurl 轮询互踢 furl 标记，边栏陷入
  // "展开到细条⇄收到 0"的永动循环。与手势模块 __meowSmoothGestureDispose
  // 同款协议：新实例入口先拆旧实例全部运行期资源，再安装自己。
  const w = window as unknown as Record<string, unknown>
  ;(w.__meowSmoothClientDispose as (() => void) | undefined)?.()
  /** 本实例登记的拆除函数清单（安装完成后打包挂 window）。 */
  const disposers: Array<() => void> = []
  // UI 注入开关（2026-08-20 为"录优化前原生界面素材"加，轻量 URL 方案）：
  // URL 带 ?meow-smooth-ui=off 时跳过全部 UI 注入（CSS/锁缩放/设置改造/事件
  // 委托/横幅/通知 client 桥），界面完全原生；host 侧压缩代理/审计投影/pending
  // 路由不受影响（手机 HTTPS 入口仍由 8445 代理提供服务，无需重启 3080）。
  // 录原生素材：手机访问 https://<tailscale 域名>/?meow-smooth-ui=off
  // 恢复优化版：去掉 query 刷新即可。（上方入口拆除已先于本 return 执行：
  // ui=off 的执行同样接管清理责任，旧实例不会残留。）
  if (new URLSearchParams(window.location.search).get('meow-smooth-ui') === 'off') {
    console.log('[meow-smooth] UI injection OFF (meow-smooth-ui=off) — native UI only')
    return
  }
  // 服务可用性前置检查（原在监听器安装之后）：缺失时不留下"半安装"状态
  // ——要么完整安装（拆除函数挂 window），要么什么都不装。
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
  // CSS 常驻全局（折叠由 data 属性驱动，规则在即生效）。先移除上一份同
  // 标记样式（双实例时期每次热替换都追加一份，无限堆积）。
  document.querySelector('style[data-meow-fold-css]')?.remove()
  const style = document.createElement('style')
  style.dataset.meowFoldCss = 'true'
  style.textContent = FOLD_CSS
  document.head.appendChild(style)
  disposers.push(() => { style.remove() })

  // 禁止页面缩放（需求 3）：viewport meta + iOS 捏合拦截。
  lockViewport()
  const onGestureStart = (e: Event): void => { e.preventDefault() }
  const onGestureChange = (e: Event): void => { e.preventDefault() }
  document.addEventListener('gesturestart', onGestureStart)
  document.addEventListener('gesturechange', onGestureChange)
  disposers.push(() => {
    document.removeEventListener('gesturestart', onGestureStart)
    document.removeEventListener('gesturechange', onGestureChange)
  })
  // 电脑端禁止/缓解页面缩放（需求 15）：拦截 Ctrl 缩放手势/按键 +
  // 缩放偏离检测提示条（桌面浏览器缩放是浏览器级行为，JS 尽力而为）。
  disposers.push(lockDesktopZoom())
  // 手机端设置页改造（需求 16）：全窗口面板 + 边栏图标竖列/滑出展开状态机。
  disposers.push(installSettingsMobile())

  // 失焦折叠（需求 1）：进出卡片判定 + 点击兜底展开 + 触屏 Enter 换行。
  // 幂等：重复监听时各分支先查状态再动作。
  document.addEventListener('focusin', onFocusIn)
  // 程序化聚焦抑制（需求⑳）：会话切换自动聚焦的 textarea 立即撤焦，
  // 键盘压根不弹（capture 阶段先于官方 unlock effect 的后续逻辑）。
  supTrace('registered')
  document.addEventListener('focusin', suppressFocusIn, { capture: true })
  document.documentElement.dataset.meowApplyStage = 'suppressor-registered'
  document.addEventListener('focusout', onFocusOut)
  document.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
  document.addEventListener('keydown', onKeyDownCapture, { capture: true })
  // 触屏兜底折叠：点卡片外任意处 → 折叠（iOS/Android 点空白可能不移焦，
  // focusout 不触发；click 判定不会误伤滚动）。
  document.addEventListener('click', onDocumentClickCapture, { capture: true })
  // 跨断点重算折叠高度（桌面 2 行 ⇄ 窄屏 1 行）：已折叠的卡片在窗口跨过
  // 1024 断点时重写实测变量（旋转/缩窗）；未折叠的下次折叠自然按新档算。
  // 只在跨越断点那一次动作，普通 resize 零开销。
  let foldWasWide = foldLines() === FOLD_LINES_DESKTOP
  const onFoldBreakpoint = (): void => {
    const wide = foldLines() === FOLD_LINES_DESKTOP
    if (wide === foldWasWide) return
    foldWasWide = wide
    for (const card of document.querySelectorAll<HTMLElement>(
      `[data-composer-card][${FOLD_ATTR}="${FOLD_COLLAPSED}"]`,
    )) {
      const scroll = card.querySelector<HTMLElement>('[data-input-scroll]')
      if (scroll !== null) {
        card.style.setProperty('--meow-smooth-fold-height', `${foldedHeight(scroll, foldLines())}px`)
      }
    }
  }
  window.addEventListener('resize', onFoldBreakpoint)
  // 输入框焦点链路诊断（2026-08-26 "输入框卡住"bug 排障）：input/
  // beforeinput/selectionchange 环形记录，随 disposers 拆除。
  disposers.push(installFoldDiagListeners())

  // 模式图标点击展开/收起（需求 4）：capture 先收起别处的，冒泡再切换本尊。
  document.addEventListener('click', onModeLabelDismiss, { capture: true })
  document.addEventListener('click', onModeLabelToggle)
  disposers.push(() => {
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('focusin', suppressFocusIn, { capture: true })
    document.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
    document.removeEventListener('keydown', onKeyDownCapture, { capture: true })
    document.removeEventListener('click', onDocumentClickCapture, { capture: true })
    document.removeEventListener('resize', onFoldBreakpoint)
    document.removeEventListener('click', onModeLabelDismiss, { capture: true })
    document.removeEventListener('click', onModeLabelToggle)
  })

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
  disposers.push(() => { menuGuard?.disconnect() })

  // 橡皮筋抑制（需求 12）：touchstart 定位滚动祖先 + touchmove 边界拦截
  // （passive:false 才能 preventDefault）。CSS overscroll-behavior 已覆盖
  // 现代浏览器，这里是旧 iOS/安卓的兜底。
  document.addEventListener('touchstart', onTouchStartOverscroll, { passive: true })
  document.addEventListener('touchmove', onTouchMoveOverscroll, { passive: false })
  document.addEventListener('touchend', onTouchEndAxis, { passive: true })
  document.addEventListener('touchcancel', onTouchEndAxis, { passive: true })
  disposers.push(() => {
    document.removeEventListener('touchstart', onTouchStartOverscroll)
    document.removeEventListener('touchmove', onTouchMoveOverscroll)
    document.removeEventListener('touchend', onTouchEndAxis, { passive: true } as EventListenerOptions)
    document.removeEventListener('touchcancel', onTouchEndAxis, { passive: true } as EventListenerOptions)
    if (flingRaf !== 0) cancelAnimationFrame(flingRaf)
  })



  // 输入法激活 → 悬浮 Session name 条（需求 3）+ 自动聚焦键盘抑制：
  // 判定 = imeActive()（动态基线骤缩 ≥25% + 编辑焦点伴随信号，2026-08-31
  // 重写：旧"screen.height 差值 20%"在折叠屏/分屏半窗恒误报，半窗 vv
  // 天生只有半屏高）。syncIme 统一做 false→true 转换检测（resize
  // 与轮询共用 lastIme）：键盘激活且最近无用户点击输入框（dsh 切换
  // 会话自动聚焦的场景）→ 收起键盘、不显示条——"只在用户激活输入框
  // 时键盘才打开"；打字中（无转换）绝不干预。
  // 键盘动画期间 visualViewport resize 连发：除 IME 同步外顺带做聚焦
  // 可视性兜底（幂等，仅在输入框被遮时才写滚动）。
  const onEditableFocusIn = (event: FocusEvent): void => {
    const t = event.target
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement
      || (t instanceof HTMLElement && t.isContentEditable)) lastEditableFocusAt = Date.now()
  }
  document.addEventListener('focusin', onEditableFocusIn, true)
  const onVisualViewportResize = (): void => { syncIme(); ensureComposerVisible() }
  window.visualViewport?.addEventListener('resize', onVisualViewportResize)
  window.visualViewport?.addEventListener('scroll', pinBar)
  let furlTick = 0
  if (isCoarsePointer()) {
    // 500ms 轮询（IME 条 + 功能⑱折叠同步）——边栏循环动画 bug 的主角：
    // 双实例时期两个此定时器带着分歧状态互踢 furl 标记。必须可拆除。
    furlTick = window.setInterval(() => { syncIme(); syncSidebarFurl() }, 500)
  }
  disposers.push(() => {
    document.removeEventListener('focusin', onEditableFocusIn, true)
    window.visualViewport?.removeEventListener('resize', onVisualViewportResize)
    window.visualViewport?.removeEventListener('scroll', pinBar)
    if (furlTick !== 0) window.clearInterval(furlTick)
  })
  // 功能⑱：layout 就绪才允许折叠（两态的"展开"依赖 toggleSidebar，服务
  // 缺失时绝不能把用户入口藏掉）。小方块常驻 body（CSS 默认 display:none，
  // furl 态才显示）。点击按模式分流：竖条底部无插件按钮 → 两态，直接
  // 展开完整侧边栏；有插件按钮 → 三态，按一下先唤出细竖条（插件按钮
  // 可达），展开交给竖条顶部原生 toggle 接棒，收起后自动折回小方块。
  layoutReady = true
  // 需求⑲ 手机端边缘手势两段式抽屉：三档停留态全为官方原生态，插件只
  // 拥有过渡期（解除 furl + rAF 写轨道宽，rail 本体直接跟手）。依赖上面
  // 已就绪的服务。
  gestureApi = installSidebarGesture({
    layout,
    frameElement,
    setFurled,
    isFurled: furlRoot,
    isCoarsePointer,
  })
  // 手势模块平时自管双实例（新装先拆旧）；这里补登记兜"本实例整体拆除"
  // 场景（如热替换后服务缺失半途退出）：连手势监听一起清干净。
  disposers.push(() => { (w.__meowSmoothGestureDispose as (() => void) | undefined)?.() })
  const onFabClick = (): void => {
    if (railHasExtraButtons()) {
      railRevealed = true
      setFurled(false)
      return
    }
    setFurled(false)
    layout.toggleSidebar()
  }
  sidebarFab().addEventListener('click', onFabClick)
  // FAB 元素跨实例复用（querySelector 命中即返回）——不拆旧监听的话，一次
  // 点按会触发 N 个实例的 handler（两态模式连点 N 次 toggle = 开了又关）。
  disposers.push(() => { sidebarFab().removeEventListener('click', onFabClick) })
  syncSidebarFurl()
  const sessions = ctx?.sessions as { open?: (sessionId: string) => void; refresh?: () => Promise<void> } | undefined
  // 手机端：侧边栏展开时点击右侧空间 → 自动收起（click 而非 pointerdown，
  // 见 onClickDismissSidebar 注释）。
  const onDismissClick = (event: MouseEvent): void => { onClickDismissSidebar(event, layout) }
  document.addEventListener('click', onDismissClick, { capture: true })
  disposers.push(() => { document.removeEventListener('click', onDismissClick, { capture: true }) })
  // 审批/提问提醒卡片（需求 12/13）：host 轮询 + 本地 pending 汇报合并。
  // sessions 不可用时跳转回调为 undefined（卡片仍显示，提示手动切换）。
  let openSessionFn: ((sessionId: string) => void) | undefined
  let refreshSessionsFn: (() => Promise<void>) | undefined
  if (sessions === undefined || typeof sessions.open !== 'function') {
    console.warn('[meow-smooth] sessions service unavailable; banner jump disabled')
  } else {
    openSessionFn = (sessionId: string) => { sessions.open?.(sessionId) }
    if (typeof sessions.refresh === 'function') {
      refreshSessionsFn = () => sessions.refresh!()
    }
  }
  disposers.push(installPendingBanner(openSessionFn, refreshSessionsFn))
  // 通知模块（需求 15）：页面内系统通知 + PWA/SW 桥。SW notificationclick
  // 的跳转指令与横幅跳转共用同一回调。
  notifyHandle = installNotifyClient({ openSession: openSessionFn })
  disposers.push(() => { notifyHandle?.dispose() })
  slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'meow-smooth',
    order: 90,
    inject: () => ({
      onSessionSwitch: () => maybeCollapseSidebar(layout),
      reportPending: reportLocalPending,
    }),
  }, FoldDock))
  // 运行时发送按钮：登记到发送按钮旁的控件行，恒显示，运行时按 busyEnter 设置承担插话/排队，非运行等同回车发送。
  // settingsScope 为可选服务，缺省时 useBusyEnter 回退 undefined（组件按 queue 兜底）。绑定在 apply 顶层执行一次：
  // useSyncExternalStore 要求 subscribe 引用稳定，若放进 inject 回调每渲染重建会触发无限重渲染导致按钮消失。
  const settingsScope = ctx?.settingsScope
  const useBusyEnter = createBusyEnterHook(
    settingsScope === undefined ? undefined : settingsScope.bind({ namespace: 'ui-conversation' }),
  )
  slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'meow-smooth-run-send',
    order: 999,
    inject: (sessionId: SessionId): {
      submitMode: (mode: RunSendMode) => void
      useBusyEnter: () => RunSendMode | undefined
    } => {
      // 服务缺失时降级为 no-op 提交而非抛错：inject 抛错会让 slot entry 崩溃（渲染边界吞掉并弃用该条目），按钮直接消失。
      // 与 QueueDock 同构取 actx→conversation，但此处会话/服务偶发缺失不应让整个按钮消失，改为静默降级并告警。
      const actx = ctx.sessions.scope(sessionId)
      const conversation = actx?.get('conversation')
      if (actx === undefined || conversation === undefined) {
        console.warn(`[meow-smooth] run-send inject degraded for session "${sessionId}" (actx=${actx !== undefined}, conversation=${conversation !== undefined})`)
        return {
          submitMode: () => {},
          useBusyEnter,
        }
      }
      return {
        submitMode: (mode: RunSendMode) => { conversation.input.for(actx).submit(mode) },
        useBusyEnter,
      }
    },
  }, RunSendButton))

  // 打包挂 window：下一次模块执行（热替换/rev 更新）在入口调用，拆除本
  // 实例全部运行期资源（见 apply 入口注释）。单项失败不阻断其余拆除。
  w.__meowSmoothClientDispose = (): void => {
    for (const fn of disposers.splice(0)) {
      try { fn() } catch { /* 尽力而为 */ }
    }
    delete w.__meowSmoothClientDispose
  }
}
