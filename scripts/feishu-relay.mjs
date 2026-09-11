// feishu-relay.mjs — 把插件的 Bark 形状 webhook 转成飞书自定义机器人卡片。
// 用法：node scripts/feishu-relay.mjs
// 配置：同目录 feishu-relay.config.json（样例见 feishu-relay.config.example.json）；
//       也可用环境变量 FEISHU_RELAY_CONFIG 指向别处的配置文件。
//
// 数据流：
//   dsh-meow-smooth（notify-host.ts 的 sendWebhook）
//     → POST http://127.0.0.1:<port>/   body = {kind,title,body,tag,sessionId?,group,icon?,url?}（Bark 形状）
//   feishu-relay（本文件）
//     → POST https://open.feishu.cn/open-apis/bot/v2/hook/<token>
//        body = {msg_type:'interactive', card, timestamp?, sign?}
//
// 为什么需要这一层：插件只发 Bark 形状的报文，不认识飞书；飞书要求
// `msg_type` / `card` 结构。转换放在本进程里，插件源码不必知道飞书的任何细节，
// 群机器人凭据也不进插件源码与插件配置。
//
// 凭据：同目录配置文件的 `webhookUrl` 与（可选）`secret`。webhook 地址形如
// https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx —— token 在 URL 路径里，
// 本身就是 bearer 凭据，所以这个配置文件不得提交、不得外传（已在 .gitignore 中）。
//
// 官方依据：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
// （签名算法、卡片结构、限流、错误码均取自该页）
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { readFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.FEISHU_RELAY_CONFIG ?? join(HERE, 'feishu-relay.config.json')

/** 飞书对自定义机器人的限流：单租户单机器人 100 次/分钟、5 次/秒。串行发送天然满足。 */
const SEND_GAP_MS = 250

/**
 * 事件类型 → 卡片标题栏配色与中文标签。
 * 配色取自飞书卡片 header.template 的官方取值。
 * @param kind - 插件 payload 的事件类型。
 * @returns 该类型的配色与标签；未知类型回落为灰色「通知」。
 */
function styleOf(kind) {
  switch (kind) {
    case 'approval': return { template: 'orange', label: '待审批' }
    case 'question': return { template: 'blue', label: '待回答' }
    case 'completed': return { template: 'green', label: '任务完成' }
    case 'failed': return { template: 'red', label: '运行失败' }
    case 'started': return { template: 'turquoise', label: '启动' }
    default: return { template: 'grey', label: '通知' }
  }
}

/**
 * 计算飞书 webhook 的签名。
 *
 * 官方算法（Java/Go/Python 三份示例一致，且与直觉相反）：把 `timestamp + "\n" + secret`
 * 当作 **HMAC 的密钥**，对 **空消息** 求 HmacSHA256，结果做 Base64。
 * 不是"secret 当密钥、时间戳当消息"。
 *
 * @param secret - 群机器人「签名校验」里复制的密钥。
 * @param timestamp - 秒级时间戳；距飞书服务器当前时间须在 1 小时内。
 * @returns Base64 编码的签名字符串。
 */
export function feishuSign(secret, timestamp) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

/**
 * 卡片按钮最终会用的跳转地址：插件 payload 自带 url 时优先，否则用 relay
 * 拼好的 fallback（带 launch token 的那个）。构建卡片与写日志都必须走这里——
 * 日志若按 fallback 记账，会把「payload 带 url 的不带 token 按钮」误报成 btn=token。
 * @param payload - 插件 webhook 的原始 JSON。
 * @param fallbackAppUrl - relay 拼出的地址；payload 带 url 时被覆盖。
 * @returns 按钮实际使用的地址；空串表示不加按钮。
 */
function resolveButtonUrl(payload, fallbackAppUrl) {
  return typeof payload.url === 'string' && payload.url !== '' ? payload.url : fallbackAppUrl
}

/**
 * 把插件报文构造成飞书 interactive 卡片。
 * @param payload - 插件 webhook 的原始 JSON。
 * @param fallbackAppUrl - payload 未带 url 时使用的跳转地址（config.appUrl）。
 * @returns 飞书卡片结构（请求体的 card 字段）。
 */
export function buildCard(payload, fallbackAppUrl) {
  const style = styleOf(payload.kind)
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'DSH'
  const text = typeof payload.body === 'string' && payload.body !== '' ? payload.body : style.label
  const appUrl = resolveButtonUrl(payload, fallbackAppUrl)

  const elements = [{ tag: 'markdown', content: text }]
  if (typeof appUrl === 'string' && appUrl !== '') {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '打开 DSH' },
      type: 'primary',
      width: 'default',
      size: 'medium',
      // 自定义机器人只支持按钮/文字链跳转 URL，不支持回调到服务端；这里正是它支持的那一半。
      behaviors: [{ type: 'open_url', default_url: appUrl, pc_url: '', ios_url: '', android_url: '' }],
    })
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `【${style.label}】${title}` }, template: style.template },
    body: { direction: 'vertical', elements },
  }
}

/** 只读日志开头这么多字节——token 行是启动就绪信号，出现在最前面。 */
const LAUNCH_LOG_HEAD_BYTES = 256 * 1024

/**
 * 从 dsh 的输出日志里取本次进程的 launch token。
 *
 * dsh 启动时会打印一行 `dsh web: <url>?token=... (LAN: <url>?token=...)`
 * （packages/bundle/web-app/src/index.ts:271，`printUrl` 默认为真）。但**这两条地址
 * 都是本机/LAN 的**——`localWebUrl` 固定返回 `http://127.0.0.1:<port>`（同文件
 * :149-153），手机上到不了。所以只取其中的 token，再拼到 config.appUrl 上。
 *
 * 为什么必须带 token：浏览器会话 cookie 是 `SameSite=Strict`、按浏览器各存各的、
 * 且绑定 hostname+port（packages/client/connection/src/browser-auth.ts:106-108,122），
 * 从手机上的 IM 点进裸域名必然 401。token 与 authority 无关——`authorizeIndex` 按请求的
 * Host 签发 cookie（同文件 :245-263），所以同一个 token 拼到任意可达域名都有效。
 * token 每进程随机（同文件 :52-58），只能每次发送时现读。
 *
 * 编码：Windows PowerShell 5.1 的 `Tee-Object -FilePath` 默认写 **UTF-16LE**
 * （带 BOM），所以按 BOM 判定编码后再解码，不能假定 UTF-8。
 *
 * @param file - dsh 输出日志路径；空串表示不启用。
 * @returns 本次进程的 launch token；读不到时返回空串（按钮退化为裸域名）。
 */
function readLaunchToken(file) {
  if (file === '') return ''
  let fd = -1
  try {
    const size = statSync(file).size
    if (size === 0) return ''
    const length = Math.min(size, LAUNCH_LOG_HEAD_BYTES)
    const buffer = Buffer.alloc(length)
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, length, 0)
    let text
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      text = buffer.subarray(2).toString('utf16le')
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      // UTF-16BE：交换字节对后按 LE 解码；swap16 要求偶数长度。
      const body = buffer.subarray(2, 2 + ((buffer.length - 2) & ~1))
      body.swap16()
      text = body.toString('utf16le')
    } else {
      text = buffer.toString('utf8')
    }
    // 带 `dsh web:` 前缀的行不止一条：打开默认浏览器时 dsh 还会打印
    // 「dsh web: opening the default browser; pass --no-open to disable」，
    // 那一行没有 token。所以从后往前找**第一条真正带 token 的**。
    const lines = [...text.matchAll(/dsh web:[^\n]*/gu)]
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      // 同一行里本机与 LAN 两条地址各带一次 token，取第一个即可（两者相同）。
      const token = /[?&]token=([A-Za-z0-9_-]+)/u.exec(lines[index][0])
      if (token !== null) return token[1]
    }
    return ''
  } catch {
    // 文件不存在、还没来得及写、或读不动，都不该影响转发。
    return ''
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/**
 * 读取并校验配置文件。
 * @returns 归一化后的配置。
 */
function loadConfig() {
  // 去掉 UTF-8 BOM：Windows 记事本与 PowerShell 的 `Out-File -Encoding utf8`
  // 都会给文件加 BOM，而 JSON.parse 不认，会报 "Unexpected token"。
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
  const port = Number(raw.port ?? 2587)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`config.port 非法：${String(raw.port)}`)
  }
  return {
    port,
    host: typeof raw.host === 'string' && raw.host !== '' ? raw.host : '127.0.0.1',
    webhookUrl: typeof raw.webhookUrl === 'string' ? raw.webhookUrl : '',
    secret: typeof raw.secret === 'string' ? raw.secret : '',
    appUrl: typeof raw.appUrl === 'string' ? raw.appUrl : '',
    // 默认开：relay 一起来就等 dsh 打出 launch token，然后发一张「DSH 已启动」
    // 入口卡片——token 每进程轮换，而卡片只在事件发生时才发，重启后到下一个
    // 事件之间新浏览器是进不来的。
    startupNotice: raw.startupNotice !== false,
    launchUrlFile: typeof raw.launchUrlFile === 'string' && raw.launchUrlFile !== ''
      ? raw.launchUrlFile
      : join(HERE, 'dsh-stdout.log'),
    logFile: typeof raw.logFile === 'string' && raw.logFile !== '' ? raw.logFile : join(HERE, 'relay.log'),
  }
}

function makeLogger(logFile) {
  return (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
    console.log(line)
    try { appendFileSync(logFile, `${line}\n`) } catch { /* 日志写不进去不能拖垮转发 */ }
  }
}

/**
 * 转发一条卡片到飞书。
 * @param cfg - 归一化配置。
 * @param card - buildCard 的产物。
 * @returns 是否被飞书接受（只看 code === 0；StatusCode/StatusMessage 是官方标注的冗余字段）。
 */
async function sendToFeishu(cfg, card) {
  const body = { msg_type: 'interactive', card }
  if (cfg.secret !== '') {
    // 秒级时间戳；官方要求距服务器时间不超过 3600 秒。
    const timestamp = Math.floor(Date.now() / 1000)
    body.timestamp = String(timestamp)
    body.sign = feishuSign(cfg.secret, timestamp)
  }
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON 响应保留原文用于排查 */ }
  return { ok: parsed !== null && parsed.code === 0, status: res.status, body: text }
}

/** 串行发送队列：保证任意两条之间至少间隔 SEND_GAP_MS，天然避开 5 次/秒的限流。 */
function createQueue(cfg, log) {
  let tail = Promise.resolve()
  let last = 0
  return (payload) => {
    tail = tail.then(async () => {
      const wait = last + SEND_GAP_MS - Date.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      last = Date.now()
      try {
        // 用 dsh 本次进程的 launch token 拼按钮地址：cookie 是 SameSite=Strict
        // 且各浏览器独立，从 IM 点裸域名会 401（见 readLaunchToken 注释）。
        const token = readLaunchToken(cfg.launchUrlFile)
        const appUrl = token !== '' && cfg.appUrl !== ''
          ? `${cfg.appUrl}${cfg.appUrl.includes('?') ? '&' : '?'}token=${token}`
          : cfg.appUrl
        // 标签按**按钮实际用的地址**算，不能用 fallback（见 resolveButtonUrl 注释）。
        const buttonUrl = resolveButtonUrl(payload, appUrl)
        const result = await sendToFeishu(cfg, buildCard(payload, appUrl))
        const button = buttonUrl === '' ? 'none' : (buttonUrl.includes('token=') ? 'token' : 'plain')
        if (result.ok) log(`sent kind=${payload.kind} title=${payload.title ?? ''} btn=${button}`)
        else log(`FAIL kind=${payload.kind} btn=${button} http=${result.status} body=${result.body.slice(0, 300)}`)
      } catch (error) {
        log(`ERROR kind=${payload.kind} ${String(error).slice(0, 300)}`)
      }
    })
    return tail
  }
}

if (process.argv.includes('--selftest')) {
  // 与官方 Python 示例同一输入，便于交叉核对：
  //   string_to_sign = '{}\n{}'.format(timestamp, secret)
  //   hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest() → base64
  console.log(`secret=demo timestamp=1599360473 sign=${feishuSign('demo', 1599360473)}`)
  process.exit(0)
}

if (process.argv.includes('--sample')) {
  // 无凭据预览卡片结构，用来核对四种事件的颜色与文案。
  const samples = [
    { kind: 'approval', title: '修一下登录页', body: '有权限申请待处理，点击查看…' },
    { kind: 'question', title: '修一下登录页', body: '有提问待回答，点击查看…' },
    { kind: 'completed', title: '修一下登录页', body: '任务完成（23 次工具调用），点击查看…' },
    { kind: 'failed', title: '修一下登录页', body: '运行失败：RATE_LIMIT', code: 'RATE_LIMIT' },
  ]
  for (const payload of samples) {
    console.log(JSON.stringify({ msg_type: 'interactive', card: buildCard(payload, 'https://example.ts.net') }))
  }
  process.exit(0)
}

const cfg = loadConfig()
const log = makeLogger(cfg.logFile)
const enqueue = createQueue(cfg, log)

if (cfg.webhookUrl === '') {
  log('警告：配置文件的 webhookUrl 为空，转发不会真正送达飞书（仅打印日志）。')
}
if (cfg.secret === '') {
  log('提示：未配置 secret，请求不带 timestamp/sign（对应飞书「签名校验」关闭）。')
}

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'feishu-relay' }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    return
  }

  const chunks = []
  req.on('data', (chunk) => { chunks.push(chunk) })
  req.on('end', () => {
    // 先回 200：插件是 fire-and-forget，不关心我们的结果，转发慢不能反过来拖住 dsh。
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))

    if (cfg.webhookUrl === '') return
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      log(`丢弃非法 JSON：${String(error).slice(0, 200)}`)
      return
    }
    if (payload === null || typeof payload !== 'object') {
      log('丢弃非对象报文')
      return
    }
    void enqueue(payload)
  })
})

server.on('error', (error) => {
  log(`服务启动失败：${String(error)}`)
  process.exitCode = 1
})

/**
 * 启动通告：等 launch token 出现在日志里，就发一张「DSH 已启动」入口卡片。
 *
 * 为什么需要：token 每进程轮换，而卡片只在审批/提问/完成/失败时才发 —— 重启后到
 * 下一次事件之间，任何**没有 cookie 的浏览器**（新设备、清了 cookie、满 30 天）
 * 都拿不到入口：那条带 token 的 URL 只打在电脑控制台，人在手机上够不着。
 *
 * 前提：`launchUrlFile` 指向的日志必须属于**本次** dsh 进程。若日志里还留着上一轮
 * 的 token，这里会立刻读到并发出一个点不进去的链接（比不发还糟）——所以启动方式应
 * 先清空该日志再拉起本进程。
 */
const STARTUP_NOTICE_POLL_MS = 2000
const STARTUP_NOTICE_TIMEOUT_MS = 5 * 60_000

async function announceStartup() {
  if (!cfg.startupNotice || cfg.webhookUrl === '') return
  const deadline = Date.now() + STARTUP_NOTICE_TIMEOUT_MS
  for (;;) {
    if (readLaunchToken(cfg.launchUrlFile) !== '') {
      log('启动通告：已读到 launch token，发送入口卡片')
      await enqueue({
        kind: 'started',
        title: 'DSH 已启动',
        body: '点下面的按钮进入 DSH。这条链接带的是本次进程的 token，随时点都能进。',
        tag: 'startup',
      })
      return
    }
    if (Date.now() >= deadline) {
      log(`启动通告放弃：${String(STARTUP_NOTICE_TIMEOUT_MS / 1000)} 秒内日志里没出现 launch token`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, STARTUP_NOTICE_POLL_MS))
  }
}

server.listen(cfg.port, cfg.host, () => {
  log(`feishu-relay listening on http://${cfg.host}:${cfg.port} (签名校验=${cfg.secret !== '' ? '开' : '关'})`)
  void announceStartup()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`收到 ${signal}，退出`)
    server.close(() => process.exit(0))
  })
}
