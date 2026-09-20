/**
 * 连接鉴权闸：给本插件经 webServer.register 直注册的路由补上官方鉴权。
 *
 * 背景：dsh 的鉴权由 dsh-client-connection 执行，但它只包在 connection.register
 * 的路由与 index fallback 外；webServer.register 的路由不经过任何闸。
 * 本插件此前所有路由都直注册到 webserver——任何能触达 dsh 端口的客户端
 * （含公网）都可以未鉴权读取 /pending（未决审批的命令文本、会话标题）
 * 或注册/覆盖推送订阅。
 *
 * 修复：对动态路由（读数据/改状态）包一层与官方 /api 完全同闸的鉴权：
 * - dsh ≥0.1.5：connection.requestRejection（Host fence 403 → 未认证 401 → 放行）。
 * - dsh ≤0.1.2（如 0.1.1-rc.2）：connection 服务存在但没有 requestRejection
 *   方法（该方法 0.1.5 才加入）。旧版官方 /api 的闸是纯 Host/Origin fence
 *   （isTrustedApiRequest：loopback/LAN IP 字面量/声明 trustedHosts 之外 403；
 *   sec-fetch-site: cross-site 403；Origin 与 Host 不同源 403）——没有 cookie
 *   层，因为旧版本来就没有浏览器会话鉴权。这里逐语义复刻同一把 fence，
 *   trustedHosts 从同一权威源读：connection.trustedHosts 字段由 bundle patch
 *   从 ctx.webRuntime.trustedHosts 注入（与官方 /api 路由同源同值）。
 *   回退到 fence 后旧宿主的防护与官方 /api 恰好等价，绝不比官方更松。
 * - connection 服务整个缺失（异常装配）：保守拒绝（503）——鉴权能力
 *   不可用时静默放行等于退回"无鉴权"形态，宁可不可用。
 *
 * 纯静态资源（manifest.json / icon-*.png / sw.js）保持开放：零数据，
 * 且 PWA 安装与系统通知图标可能由不带 cookie 的浏览器层发起。
 */

/** connection 服务最小面：0.1.5+ 的 requestRejection 与旧版的 trustedHosts。 */
export interface ConnectionAuthFace {
  requestRejection?: (req: unknown) => number | undefined
  /** 旧版（≤0.1.2）Host fence 的权威列表：bundle patch 注入的
   *  `ctx.webRuntime.trustedHosts`（LAN IP 字面量 + --trusted-host 附加项）。 */
  trustedHosts?: readonly string[]
}

/** 从插件 ctx 取 connection 服务：先属性访问（inject 已声明时 cordis 严格
 *  模式唯一可靠路径），回退 ctx.get——两版 cordis 兼容（同 webServer 取法）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function connectionAuthOf(ctx: any): ConnectionAuthFace | undefined {
  let connection: ConnectionAuthFace | undefined
  try { connection = ctx.connection as ConnectionAuthFace | undefined } catch { connection = undefined }
  if ((connection === undefined || connection.requestRejection === undefined) && typeof ctx.get === 'function') {
    try { connection = ctx.get('connection') as ConnectionAuthFace | undefined } catch { connection = undefined }
  }
  return connection
}

// --- 旧版（≤0.1.2）Host fence：逐语义复刻 0.1.1-rc.2 dsh-client-connection
// 的 isTrustedApiRequest（api-request-trust.js），行为必须与官方 /api 一致。 ---

interface ParsedAuthority { hostname: string; host: string; port: string }

function fenceHeader(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined
  const h = headers as Record<string, unknown>
  // Fetch Headers 形态（官方 header() 同款兼容）：get() 优先。
  const getter = (h as { get?: unknown }).get
  if (typeof getter === 'function') {
    try { const v = (h as { get: (n: string) => unknown }).get(name); if (typeof v === 'string') return v } catch { /* 非标准 get，走索引 */ }
  }
  const value = h[name]
  if (typeof value === 'string') return value
  const lower = h[name.toLowerCase()]
  return typeof lower === 'string' ? lower : undefined
}

function parseAuthority(authority: string): ParsedAuthority | undefined {
  try {
    const url = new URL(`http://${authority}`)
    return { hostname: url.hostname, host: url.host, port: url.port }
  } catch { return undefined }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 官方语义：无显式端口的条目按"HTTPS 解析得到的默认端口"参与判断——
 *  `:80`/`:443` 仍算显式端口（两种 special scheme 默认端口不同）。 */
function canonicalAuthority(entry: string, entryUrl: ParsedAuthority): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: ParsedAuthority, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // 条目无显式端口（canonical == hostname）→ 只比主机名（任意端口）；
    // 带显式端口 → 比 host（主机名+端口）。
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** 旧版官方 /api 的完整 Host fence（0.1.1-rc.2 逐语义复刻）。 */
function legacyHostFence(req: unknown, trustedHosts: readonly string[]): boolean {
  const host = fenceHeader((req as { headers?: unknown })?.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (fenceHeader((req as { headers?: unknown })?.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = fenceHeader((req as { headers?: unknown })?.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/**
 * 包一层鉴权闸。
 *
 * - connection.requestRejection 可用（0.1.5+）：返回数字（403/401）原样
 *   写回，语义与 connection.register 的包装层一致；undefined 放行。
 * - connection 存在但无 requestRejection（≤0.1.2）：回退旧版官方同款
 *   Host fence（见文件头注释），不过 → 403，过 → 放行。
 * - connection 整个缺失：保守拒绝（503）。
 *
 * 泛型 R 透传各路由 handler 自己声明的 res 类型（writeHead 的 headers
 * 参数可可选可必选，各处不一；闸身只用字面量调用，兼容两种形态）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authGate<R extends { writeHead: (...args: any[]) => void; end: (...args: any[]) => void }>(
  connection: ConnectionAuthFace | undefined,
  handler: (req: unknown, res: R) => void,
): (req: unknown, res: R) => void {
  return (req, res) => {
    const reject = connection?.requestRejection
    if (typeof reject === 'function') {
      const rejection = reject.call(connection, req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      handler(req, res)
      return
    }
    // 旧版宿主（≤0.1.2）：connection 存在但没有 requestRejection →
    // 复刻旧版官方 /api 的 Host fence；trustedHosts 缺省为空（等价于
    // 官方默认 config.trustedHosts = []，loopback 永远放行）。
    if (connection !== undefined) {
      if (!legacyHostFence(req, connection.trustedHosts ?? [])) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      handler(req, res)
      return
    }
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('meow-smooth: authentication service unavailable')
  }
}
