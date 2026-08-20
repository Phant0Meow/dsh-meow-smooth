# meow-smooth 喵丝滑

dsh（DeepSeek Harness）前端行为增强插件，**零 dsh 本体改动**，纯 client 端自包含。

## 功能

1. **输入框失焦折叠**：composer 输入框失去焦点时，自适应高度折叠回 1 行；
   再次聚焦/点击输入框区域展开回草稿实际高度，滚动位置保留。长草稿不再
   常年占着半个屏幕。
2. **手机端模型选择器折叠宽度**：视口 < 1024px 时模型名压到 96px 宽并
   省略号截断（隐藏 effort 文字），不再把输入框左侧按钮挤掉。
3. **手机端禁止页面缩放**：viewport meta 加 `maximum-scale=1` +
   `user-scalable=no`，CSS `touch-action: manipulation` 防双击缩放，
   iOS gesture 事件拦截捏合。
4. **手机端输入框换行**：触屏（粗指针）设备上 Enter 不再发送、改为插入
   换行（键盘回车键显示"换行"）；Shift/Ctrl/Alt/Meta+Enter 与输入法选词
   不受影响。桌面键盘保持 Enter 发送。
5. **窄屏选中会话收起侧边栏**：视口宽度 < 1024px（dsh 布局契约
   `SIDEBAR_AUTO_COLLAPSE`，手机/窄窗口）时，切换 Session 后侧边栏自动收成
   56px rail，把屏幕还给对话内容。
6. **手机端点击侧边栏外自动收起**：窄屏侧边栏展开时，点击右侧空间（边栏
   以外区域）自动收起。用 click（pointerup 之后）判定——拖拽滚动不产生
   click，被点元素的动作先于收起重排完成，不会误点。
7. **手机端 Session log 按钮缩窄**：隐藏按钮文字只留下载图标，并去掉
   `min-width: 111px` 与宽 padding，缩成紧凑图标按钮。
8. **手机端模式选择栏缩窄**：agent preset label 只留 icon，腾空间给
   Session name；**点击图标展开显示模式名**，点击别处自动收回。
9. **打字时隐藏 header、悬浮 Session name 条**：输入法激活（键盘占屏
   ≥20% 物理屏高，screen.height 差值判定，Android 页面 resize 也不受影响）
   → 隐藏原生 header，body 层 fixed 悬浮条显示当前会话名（z-index 9999，
   offsetTop 补偿 iOS 平移）；键盘收起销毁恢复。会话切换自动聚焦弹出的
   键盘会被抑制（blur 收起，不显示条）。
10. **手机端后台任务数 / 子代理按钮缩窄**：header 动作区的两个下拉按钮
    只留状态小图标（隐藏计数文字与右侧下拉箭头），空闲（无运行中任务/
    子代理）时中性灰点兜底；点小图标即打开下拉列表。
11. **手机端 header 横向滑动**：Session name 完整显示、绝不截断，其余
    动作按钮按上面优化后的窄形态依次排在 name 后面；内容超宽时 header
    行可左右滑动看到更多内容（滚动条隐藏）。

12. **手机端禁用橡皮筋回弹**：页面整体下拉回弹被禁用（app 化观感）——
    CSS `overscroll-behavior: none`（html/body 与 root 全树，含安卓下拉
    刷新）+ JS touchmove 边界兜底（旧 iOS/安卓）；可滚动容器内正常滑动
    不受影响，到边界即拦。
13. **手机端审批/提问提醒卡片**：AI 工作中的权限申请与提问在手机端可能
    因窗口未开/未在目标会话而不显示。host 端审计投影 + 只读路由
    `GET /plugins/meow-smooth/pending` 暴露全部未决审批细节（toolName/
    reason/命令/失效标记，含服务重启后从审计日志恢复的孤儿项）与未决
    提问（`ask_user_question` 工具调用登记、`tool/result` 移除——提问无
    专用审计事件，从工具调用审计跟踪，host 重启扫描恢复孤儿；条目携带
    host 折叠的会话标题，修"未命名会话"）；client 3s 轮询，本地提问/
    计划审状态由隐形 dock 经 useSessions 汇报（官方帧驱动，跨会话）作为
    host 投影未覆盖时的补充。合并后顶部显示系统通知样式的圆角卡片（v2：
    两行文字、下滑弹出动画、整卡点击进入目标会话、上滑手势隐藏且同条目
    30s 静默防重弹）：官方面板接管则隐藏；跳转失败/面板未接管（iOS
    会话实例重建限制）→ 卡片 fail 提示与恢复办法。纯通知，不做输入。
    **桌面卡片策略**：电脑端（细指针）当前会话不弹卡片（官方面板即
    足够），非当前会话照常弹（方便跳转）；触屏保留"当前会话+面板未
    接管时显示卡片"（iOS 实例重建下点卡片刷新恢复问题窗的兜底）。
    系统通知（Web Push/页面内通知）因 iOS 18.6.2 系统 bug（权限弹窗不
    出现 + APNs 投递不到）在 iPhone 上暂不可用，代码保留待系统修复。
14. **失焦折叠稳定性修复**：折叠判定对比实测 1 行高（line-height +
    padding）而非滚动窗当前高度——旧逻辑把"无溢出"误判为"只有 1 行"，
    导致多行草稿（≤14 行内）永不折叠；折叠高度用 JS 实测写入 CSS 变量
    `--meow-smooth-one-line`（30px 兜底），任何主题都精确等于默认 1 行高；
    触屏点卡片外 click 兜底折叠（iOS/Android 点空白可能不移焦，
    focusout 不触发）。
15. **通知（权限申请 / 提问 / 长任务完成）**：三处事件在页面不可见时弹
    系统通知（桌面/Android 页面内 Notification API；iOS PWA 与浏览器
    关闭场景由 Web Push 兜底）：
    - 权限申请：审批 pending → "有权限申请待处理"
    - 提问：`ask_user_question` 工具调用（question 无审计事件，按工具名
      检测）→ "有提问待回答"
    - 长任务完成：turn 内工具调用 ≥ `longTaskToolCalls`（默认 7，patch
      可配）的 turn 结束时 → "任务完成"
    点击通知 → 聚焦页面 + 跳转目标会话。PWA（manifest/SW/图标）由
    meow-smooth 提供；VAPID keys 与订阅持久化在 `$DSH_HOME/.meow-smooth/`。
    **HTTPS 前置**：Web Push / SW 要求 secure context——手机端用
    `https://<你的 MagicDNS 域名>:<serve 端口>`（Tailscale Serve 或任意
    HTTPS 反代）访问并重新"添加到主屏幕"；iOS 需 16.4+。
    **iOS 已知限制**：iOS 18.x 上 PWA 通知权限弹窗不出现（WebKit 320551）
    且 APNs 接受但投递不到（WebKit 319865）——iPhone 上系统通知暂不可用
    （注：授权成功后实际可收到，两项 bug 为概率性问题；已实测 3080 上
    iOS 系统通知与 Bark 双通道均成功）。
    **替代通道（webhook）**：patch 配置 `webhookUrl`（如
    `https://api.day.app/<Bark key>`）后，三处事件 POST
    `{ title, body, group, kind, sessionId }` 到该 URL。**优先级：Web Push
    （iOS 系统通知）优先，无订阅/全部失败才走 webhook（Bark 兜底）**——
    iOS 订阅建立后不会双通道重复提醒。Bark 可选 `webhookIconUrl`（通知
    图标，如插件图标路由）与 `webhookAppUrl`（点击通知跳转地址）。
    **多实例**：每个实例（3080/3081 等）各自在 patch 里配置，跳转/图标
    URL 用各自入口（443 与 8443 不同）。
    **桌面聚焦感知**：client 轮询上报页面聚焦状态（`x-meow-focus` 头），
    host 在任一页面聚焦时抑制系统通知推送（卡片气泡负责提醒）；SW 侧以
    `Client.focused` 兜底（同 origin 聚焦不弹）。效果：电脑端 DSH 页面
    聚焦时不弹系统通知，切到其他标签/窗口（其他 app）时弹。多入口
    （localhost / 127.0.0.1）由 host 统一判定（SW 无法跨 origin 感知）。
    注意：同一浏览器的多 origin 会各自注册推送订阅，推送时每条订阅都
    会收到——建议收敛使用单一入口（如 localhost），避免重复通知。
16. **手机端设置页改造**：视口 < 1024px 时设置面板全窗口显示（无空隙），
    左侧 sidebar 收成 56px 图标竖列（宽度与主界面边栏收起 rail 一致，
    36px 圆钮只留图标，右侧 1px 边线区分区域）；点边栏任意处（图标或
    背景）不切换标签页、边栏滑出展开（220ms 动画）完整显示图标+文字，
    展开态点边栏按钮正常切页，点右侧空白区域边栏收回 56px（不切页）。
    桌面宽屏完全保持官方原样（无属性注入、无点击拦截）。

## 实现（不碰 dsh 本体）

- **手机端设置页（`src/settings-mobile.ts`）**：状态机挂在设置面板
  `div[role="dialog"] > nav`（SettingsRoot 独有结构，Modal 系 dialog 不命中）
  的 `data-meow-smooth-settings` 属性（collapsed/expanded/缺席=桌面原样）；
  MutationObserver 侦测面板挂载（打开即收起态 + 首帧 noanim 标记压制
  插入闪动动画，下一帧摘除）、matchMedia 跨断点复位；点击拦截在
  document capture（先于 React 根容器委托）——收起态点边栏任意处
  （按钮或背景）`stopPropagation` 让官方 onSelect 收不到（只展开不切页），
  展开态点右侧非交互元素收回；宽度/标签走 CSS transition（220ms 滑出）；
  nav 右侧 1px 边线用 `::after` 伪元素（不占布局，随宽度动画贴右缘）。
- **失焦折叠**：注入全局 CSS，折叠态 = 卡片上的 `data-meow-smooth="collapsed"`
  属性把 `[data-input-scroll]` 的 `max-height` 压到 1 行（mirror/backdrop/textarea
  三层结构不动）；`document` 级 `focusin`/`focusout` 事件委托判定进出卡片，
  `pointerdown`（capture）兜底"点卡片即展开"，`scrollTop` 存 `WeakMap` 展开时恢复。
  1 行判定与折叠高度共用 `oneLineHeight()`（实测 line-height + padding，
  写入 `--meow-smooth-one-line` 变量）；触屏点卡片外 `click`（capture）兜底折叠。
- **审批/提问提醒（host + client 双端）**：
  - host（`src/index.ts`）：`ctx.on('session/event')` 监听审计流
    `approval/asked`/`approval/decided` 投影未决审批；`tool/call`
    （`ask_user_question`）登记未决提问、`tool/result`
    （`message.source.callId` 配对）移除（提问无专用审计事件，从工具
    调用审计跟踪）；启动时扫描已挂会话恢复两类孤儿项（覆盖 apiproxy
    内存 pending 在 host 重启后丢失的场景）；
    `ctx.on('approval/request')` waterfall 纯观察补 reason（必须 `next()`
    放行）；`ctx.webServer.register` 挂只读路由 `/plugins/meow-smooth/pending`
    （需 `inject` 声明必需服务，实测 cordis 装配形态要求 inject 非空
    ctx.get 才能命中服务 store）。
  - client（`src/client.ts`）：3s 轮询 pending 路由（approvals + questions
    host 投影为准）+ 隐形 dock（`conversation.composer.dock`）用
    `useSessions` 汇报跨会话 `pendingInteraction`（approval/question/
    plan-review，含标题，host 未覆盖时补充，同会话提问以 host 为准）；
    合并后窄屏（< 1024px）fixed 顶部横幅（z-index 9998，IME 条 9999
    优先）；点"查看"→ `ctx.sessions.open` 跳转（失败重试 3 次），
    1.5s 后检测官方面板（`[data-approval-key]` 等），接管则隐藏，未接管
    展开详情（toolName/reason/命令/失效提示）。
- **通知（`src/notify-host.ts` + `src/notify-client.ts`）**：
  - host：长任务完成检测（turn/start + tool/call 计数，turn/end ≥ 阈值入
    队，`/pending` 返回 events）；PWA 资源路由（manifest/sw.js/icon-180.png
    ——zlib 手写 PNG，`Service-Worker-Allowed: /` 放开 SW scope）；Web Push
    推送器（`web-push` 动态 import——CJS 包 bundle 进 ESM 会动态 require
    崩溃，必须 external + 运行时加载；API 在 `import('web-push').default`
    上）；VAPID/订阅持久化 `$DSH_HOME/.meow-smooth/`；404/410 清失效订阅。
  - client：首次用户手势请求 Notification 权限；pending 新增 + 页面
    hidden → 系统通知（approval 用 approvalId 去重，提问用 会话:类型，
    pending 消失即移除）；完成事件 localStorage 去重；secure context 下
    注册 SW + push 订阅上报；SW notificationclick → postMessage 跳转会话。
- **模型名折叠**：`@media (max-width: 1023px)` 命中
  `[data-slot="conversation.input.model"]` 的 trigger（slot renderer 标准输出锚点），
  压宽 + 隐藏 effort 文字，label 自带省略号。
- **禁缩放**：原地补全 viewport meta（`maximum-scale=1, user-scalable=no`）、
  `touch-action: manipulation`、iOS `gesturestart/gesturechange` preventDefault。
- **手机换行**：`keydown`（capture，早于 React onKeyDown）拦截触屏 Enter，
  插入 `\n` 并派发 `InputEvent('input')` 让受控层（keyboard.setDraft）感知；
  粗指针判定用 `matchMedia('(pointer: coarse)')`。
- **窄屏收起侧边栏**：隐形槽位挂 `conversation.composer.dock`（InputZone 随
  会话快照重渲染），`session.sessionId` 变化时判定「frame 宽 < 1024 && 侧边栏
  展开（frame 无 `data-sidebar-collapsed`）」→ 调 `ctx.layout.toggleSidebar()`
  （窄屏语义 = flip `narrowExpanded`，收起）。首次挂载只记录不动作。

- **后台任务数 / 子代理按钮缩窄**：`@media (max-width: 1023px)` 下按结构
  定位 `button[aria-expanded]:not([aria-haspopup])`（job-list）与
  `button[aria-haspopup="tree"]`（subagent-catalog），隐藏计数 span 与
  无 `data-state` 的 chevron svg，只留 StateDot 小图标；空闲态用 `:has()`
  判定补中性灰点兜底——按钮始终可见可点，菜单开合本就在按钮 onClick。
- **header 横向滑动**：同媒体查询内把 titleRow（header 首个子 div）改
  `overflow-x: auto`，titleCluster/crumbs 改 `flex: none; min-width:
  max-content`，crumb 按钮去 `max-width: 220px` 与 ellipsis——name 全宽，
  其余内容依次排后，超宽即滑动；滚动条隐藏（`scrollbar-width` +
  `::-webkit-scrollbar`），触屏原生滑动。


- **禁用橡皮筋**：`overscroll-behavior: none` 拦现代浏览器（含 Chrome
  安卓下拉刷新与滚动链）；旧 iOS 兜底 = touchstart 定位最近可滚动祖先
  （overflow auto/scroll 且有溢出）+ touchmove（passive:false）在滑动
  方向已到边界时 preventDefault——容器内滚动照常，编辑控件（textarea/
  input）放行防选择句柄失效。
## 安装

前置要求：dsh（DeepSeek Harness）0.x、Node.js ≥ 22。

```sh
npm install   # esbuild（构建）+ web-push（运行时，host 端 Web Push）
npm run build # 双产物：lib/index.js（host）+ lib/client.js（browser）
```

构建**零 dsh 本体依赖**：代码只用到两个官方类型（`SessionId` / `ILayout`），
已在 `src/client.ts` 内以最小接口本地声明（结构类型兼容官方定义，官方接口
新增方法不影响）——不需要安装任何 `@deepseek-ai/*` 包，也不需要 dsh 源码
workspace。（`scripts/link-workspace.ps1` 是历史开发工具，为旧版构建建
node_modules junction 镜像，当前构建不再需要。）

装配（二选一）：

- **profile 装配**：把 `cordis.patch.yml` 的 insert 条目加进目标 profile 的
  `cordis.patch.yml`（或把本包加入 profile 的 bundles 列表），重启 dsh 生效；
- **npm 包安装**：`npm pack` 产出 tgz，在 dsh profile 里 `npm install <tgz>`，
  浏览器端经 `dsh.client.platform: web` 声明由 dsh-client-modules 装配，
  host 侧经 `cordis.patch.yml` insert 条目加载（审批审计投影 + 只读状态路由）。

### 通知功能（功能 15）额外要求

- **HTTPS**：Web Push / Service Worker 要求 secure context——手机端需要一个
  HTTPS 入口（Tailscale Serve、Caddy、nginx 均可），并从该入口"添加到主屏幕"；
- **iOS**：16.4+（Web Push for Home Screen Web Apps），需在 PWA（从主屏幕图标
  打开）里完成通知授权；
- **VAPID keys**：首次启动自动生成，持久化在 `$DSH_HOME/.meow-smooth/`。
  长任务完成阈值 `longTaskToolCalls`（默认 7）可在 patch config 里调整。

### 手机访问加速（压缩代理，可选）

dsh 的 history 等 unary RPC 响应是**不压缩的 JSON**（大会话窗口可达 1-8MB，
手机经蜂窝/tailscale 下载很慢）。meow-smooth 内置压缩代理（**零 dsh 本体
改动**）：插件在 dsh 进程内起一个本地反向代理，把 `POST /api/*` 的 JSON
响应按 `Accept-Encoding` 加 gzip（实测压缩 70-90%）；SSE 长连接、静态资源、
WebSocket 原样透传——不破坏流式，Host/Origin 头原样转发（信任围栏不受影响）。

开启步骤：

1. profile 的 `cordis.patch.yml` 里 meow-smooth 条目加：

   ```yaml
   - insert:
       - id: meow-smooth
         name: 'meow-smooth'
         config:
           enabled: true
           proxy:
             enabled: true
             port: 8444   # 代理监听端口；targetPort 自动从 dsh --port 解析
   ```

   重启 dsh 生效（代理随插件生命周期启停，热重载/卸载自动关闭）。
2. 把手机访问入口（反代）指向代理端口（示例：Tailscale Serve）：

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:8444
   ```

   手机用 `https://<你的 MagicDNS 域名>:8443` 访问即自动加速。

注意：多实例时每个实例用不同代理端口（如 3080 → 8444、3081 → 8445）；
默认关闭（不配置 `proxy.enabled` 就不启动），不会干扰现有部署。

## 免责声明

本插件是喵版定制（dsh-meow 生态），与官方上游无关联。
