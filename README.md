# dsh-meow-smooth 喵丝滑——手机端远程使用dsh，躺着coding，刷b站coding

dsh（DeepSeek Harness）前端体验增强插件，**零 dsh 本体改动**，纯客户端自包含。
装上之后，dsh 在手机上像原生 App 一样好摸，在电脑上也有更舒服的小细节。

tailscale实现手机端远程连接dsh（插件包含tailscale配置踩坑指导，AI看完应该可以帮你快速实现手机连接dsh，你就不用自己从零开始踩坑了。）

手机端ui交互优化，让手机端dsh真正可用。你可以躺着coding了。

电脑、手机都支持的通知系统。AI跑任务，你切出去刷b站了，AI跑完任务或者中途提问，会发通知给你。

还有一些ui交互方面的细节优化。

作者自己在用，亲测好用，非常提高幸福感。

dsh-meow-smooth：

<img width="725" height="594" alt="image" src="https://github.com/user-attachments/assets/e5bb97b6-051e-45a9-b7a9-8437fe400a4c" />


## 功能

### 打字舒服

- **输入框失焦自动折叠**：长草稿不再一直占着半个屏幕。写完切走，输入框自动收起来——电脑上保留 2 行（扫一眼上下文就能接着写），手机上收成 1 行（屏幕小，把地方留给内容）；点一下又展开，草稿内容和滚动位置原样保留。
- **手机上回车 = 换行**：手机键盘的回车键变成"换行"，不怕误触把半截话发出去；Shift/Ctrl/Enter 和输入法选词不受影响，桌面键盘依旧是回车发送。
- **AI 运行时多一个插话按钮**：AI 正在回话时（发送键变成停止的那一刻），发送按钮旁会多出一个小箭头——点了等价于按一次回车，按设置执行插话或排队。手机回车已改成换行、虚拟键盘又没有 Ctrl/Cmd 键，运行中插话全靠它补全；AI 空闲时它自动消失，界面跟原版一样。
- **打字时顶部栏自动让位**：唤起输入法时，对话/轨迹那些标签自动隐藏，屏幕最上方只留一条当前会话名——你知道自己正在跟谁聊；键盘收起，一切恢复原样。

### 手机上更顺滑

- **按钮行永不换行**：窗口再窄（折叠屏半窗、小屏），权限/模型/上下文/发送按钮都稳稳一行排开——空间不够时模型名自动缩短省略，权限按钮自动收成图标，不再整排掉到第二行。
- **模式选择只留图标**：agent preset 在手机上只显示一个小图标，点一下展开完整名字，点别处自动收回。
- **侧边栏更聪明**：窄屏下切换会话后，侧边栏自动收起，把屏幕还给对话；展开时点一下右侧空白就收起。
- **边缘手势抽屉**：屏幕左缘往右轻轻一划，侧边栏滑出来；再划一下展开完整侧边栏；长划一步到位。想收起就点外面或往左一划，直接收得干干净净。三档停留全是原生状态，动画用的是官方自带过渡，丝滑不卡手。
- **细竖条折成小方块**：手机上连收起后的那条细竖条也省了——它折叠成左上角一个带 DeepSeek 图标的小方块，会话标题自动让位，谁也不挡谁。点一下直接展开完整侧边栏，选完会话自动折回去。哪天装了会往侧边栏加按钮的插件，小方块还会自动让位回原生竖条，一个按钮都不藏。
- **按钮只留图标**：下载记录、后台任务、子代理这些按钮在手机上缩成紧凑的小图标，依旧一点就开。
- **顶部栏可以横滑**：Session 名永远完整显示、绝不截断，内容超宽就左右滑着看。
- **回答信息行可以横滑**：AI 回答下方那排 复制/点赞/分支 + 时间·用时·首token·吐字速度，手机上一行放不下——左右滑动就能看到后面的统计，不再被屏幕边缘切掉。
- **禁止意外缩放**：双击、双指捏合都不会再让页面意外缩放。
- **表格触摸滚动修复**：AI 画的表格，从表格任意位置起手都能正常上下滑动页面了（之前必须精准按到文字上才动）；宽表格还能直接左右滑，看得到右边的列。
- **禁用橡皮筋回弹**：页面下拉不会再回弹，更像原生 App 的手感。
- **设置页也适配了手机**：手机上设置页全屏显示，左侧边栏收成图标列，点开展开；电脑上保持官方原样。

### 通知

- **提醒卡片**：AI 跑长任务时中途要权限、或有问题等你回答——即使你没在看那个会话，屏幕上方也会弹出提醒卡片，点一下就跳过去处理。AI 回合因错误中断（接口报错、限流等）同样弹卡片提醒。
- **系统通知**：AI 跑完长任务、中途要权限或提问，哪怕你已经切出去刷 B 站了，也会弹系统通知，点通知直接回到对应会话。
- **多会话同时跑也不错过**：一次开好几个会话同时跑，你在和其中一个聊天，别的会话有动静（跑完任务 / 要权限 / 提问）同样会提醒你。
- **运行失败也提醒**：AI 回合因错误中断（接口报错等）时同样弹通知。自动重试中的瞬时小错误不打扰——只有重试不过去的最终失败才提醒，每条失败恰好一条通知。
- **手机也能收到系统通知**：桌面和安卓直接弹系统通知；iPhone 通过 Web Push 或 Bark 等通道也能收到（配置见下文）。
- **不打扰**：电脑端 dsh 页面正聚焦时不弹系统通知（官方面板/卡片负责提醒），切到别的窗口才弹。

### 手机上访问更快

dsh 的大会话在手机上看很慢——历史记录一次要拉好几 MB 的 JSON。插件内置压缩代理，把这些响应压缩 70–90%，蜂窝网络也流畅；流式输出和实时连接不受影响。默认关闭，需要时在配置里打开（见下文）。

## 安装

**从 GitHub 安装**：源码在 `src/`，`lib/` 不入仓库，安装时 npm 会触发 `prepare` 脚本现场构建，装完即用。

```powershell
dsh plugin --profile web add github:Phant0Meow/dsh-meow-smooth
```

**从 npm 安装**：包内已含构建产物 `lib/index.js` 与 `lib/client.js`，安装时不再构建。

```powershell
dsh plugin --profile web add meow-smooth
```

两种方式装完都会自动挂载，重启 DSH web 后启用，无需手工编辑任何组合文件。

> npm 源 `dsh plugin --profile web add meow-smooth` 自 `0.6.1` 起恢复可用；`0.6.0` 及更早版本的 `package.json` 带 BOM 会解析失败，请避开。GitHub 源始终最新，推荐优先使用。

## 卸载

```powershell
dsh plugin --profile web remove meow-smooth
```

彻底移除，重启 DSH web 后不再加载。

## 通知功能（可选）

页面内提醒卡片开箱即用；系统通知（Web Push / webhook）需要一点额外配置：

- **HTTPS**：Web Push / Service Worker 要求安全上下文——手机端需要一个 HTTPS 入口（Tailscale Serve、Caddy、nginx 均可），并从该入口"添加到主屏幕"；
- **iOS**：16.4+（Web Push for Home Screen Web Apps），需在 PWA（从主屏幕图标打开）里完成通知授权；
- **VAPID keys**：首次启动自动生成，持久化在 `$DSH_HOME/.meow-smooth/`；长任务完成阈值 `longTaskToolCalls`（默认 7）可在 patch config 里调整；
- **webhook 兜底（Bark 等）**：patch 配置 `webhookUrl`（如 `https://api.day.app/<Bark key>`）后，三类事件也会 POST 到该地址；iOS 订阅建立后不会双通道重复提醒。`webhookIconUrl` / `webhookAppUrl` 可分别配置通知图标与点击跳转地址；
- **iOS 已知限制**：iOS 18.x 上 PWA 通知权限弹窗偶尔不出现（WebKit 320551）、APNs 偶尔投递不到（WebKit 319865）——均为概率性问题，授权成功后通常能正常收到，Bark 可作稳定兜底；
- **多实例**：每个 dsh 实例各自在 patch 里配置，跳转/图标 URL 用各自入口。

## 手机访问加速（可选）

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

注意：多实例时每个实例用不同代理端口（如实例 A → 8444、实例 B → 8445）；默认关闭（不配置 `proxy.enabled` 就不启动），不会干扰现有部署。

## 平板/手机经 Tailscale 访问 DSH（必读：信任栅栏配置）

DSH Web 的 `/api` 有浏览器信任栅栏：Host 必须是回环地址，或命中启动时用 `--trusted-host` 声明的权威。经 Tailscale Serve 访问时 Host 是 MagicDNS 权威，**必须先把它加进信任名单，否则页面能打开但所有 /api 请求 403**（会话列表空白、插件数据加载失败）。

**一步配置**（以 MagicDNS 权威 `pc.xxx.ts.net` 为例，换成你自己的）：

```sh
# 启动 DSH 时追加 --trusted-host
dsh --profile web --host 127.0.0.1 --port 3080 --trusted-host pc.xxx.ts.net
```

**两条入口（二选一）**：

```sh
# A：不开压缩代理（默认），手机访问 https://pc.xxx.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:3080

# B：经内置压缩代理（需在 patch 配置里开启 proxy.enabled），手机访问 https://pc.xxx.ts.net:8443
tailscale serve --bg --https=8443 http://127.0.0.1:8444
```

> 提示：
> - A 入口默认无端口后缀；B 入口 URL 需带 `:8443`。
> - Tailscale Serve 的 HTTPS 同时提供 `wss://` 升级与 PWA/Web Push 所需的安全上下文。
> - 若改用 Caddy / nginx 等反向代理，同样需要让 DSH 信任代理暴露的权威（`--trusted-host`）。
> - 局域网直连同理：把网关/反代对外权威加入 `--trusted-host`。
> - 安装时请保持插件原名 `meow-smooth`（改名安装会导致前端注册 id 不匹配，页面报「Failed to load plugins」）。

已验证环境：DSH 0.1.1-rc.2 · meow-smooth 0.6.1 · Tailscale 1.102.3（Windows PC + Android 15 平板）。

## 实现方式（简要）

- **零 dsh 本体改动**：所有功能都是插件自身的前端 CSS/JS 与 host 端审计监听，不改 dsh 任何源码；
- 输入框折叠、按钮缩窄、禁缩放等：注入 CSS + 事件委托，锚定官方 DOM 结构（`data-*` 属性）；
- 审批/提问提醒：host 端监听审计流投影未决状态，插件内只读路由暴露，client 轮询 + 隐形槽位跨会话感知；
- 通知：页面内 Notification + Web Push（PWA 资源由插件提供）+ webhook（Bark 等）三级通道，按可用性自动降级；
- 压缩代理：插件内置反向代理按 `Accept-Encoding` 给 `/api/*` JSON 加 gzip，SSE/WS/静态资源透传。

## 致谢

- [better-er](https://github.com/better-er)——运行中插话/排队发送按钮（PR #6）和 tsc 类型检查的工程化打底。手机上回车改成换行之后，运行中的插话一直没入口，这个按钮把最后一块拼图补上了，谢谢！

