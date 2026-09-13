/**
 * 连接鉴权闸：给本插件经 webServer.register 直注册的路由补上官方鉴权。
 *
 * 背景：dsh 的鉴权（Host fence + 浏览器会话 cookie）由 dsh-client-connection
 * 执行，但它只包在 connection.register 的路由与 index fallback 外；
 * webServer.register 的路由不经过任何闸。本插件此前所有路由都直注册到
 * webserver——任何能触达 dsh 端口的客户端（含公网）都可以未鉴权读取
 * /pending（未决审批的命令文本、会话标题）或注册/覆盖推送订阅。
 *
 * 修复：对动态路由（读数据/改状态）包一层 connection.requestRejection——
 * 与官方 /api 路由完全同闸（Host fence 403 → 未认证 401 → 放行）。
 * 纯静态资源（manifest.json / icon-*.png / sw.js）保持开放：零数据，
 * 且 PWA 安装与系统通知图标可能由不带 cookie 的浏览器层发起。
 */

/** connection 服务最小面（只依赖 requestRejection；可选调用防旧版差异）。 */
export interface ConnectionAuthFace {
  requestRejection?: (req: unknown) => number | undefined
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

/**
 * 包一层鉴权闸。
 *
 * - connection / requestRejection 缺失（异常装配）：**保守拒绝**（503）——
 *   鉴权能力不可用时静默放行等于退回"无鉴权"形态，宁可不可用。
 * - requestRejection 返回数字（403/401）：原样写回该状态码，语义与
 *   connection.register 的包装层一致。
 * - 返回 undefined：放行原 handler。
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
    if (typeof reject !== 'function') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('meow-smooth: authentication service unavailable')
      return
    }
    const rejection = reject.call(connection, req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    handler(req, res)
  }
}