/**
 * meow-smooth — 压缩代理（手机访问加速，零 dsh 本体改动）。
 *
 * 背景：dsh 的 history 等 unary RPC 响应是未压缩 JSON（1-8MB 窗口），
 * 手机经 tailscale 蜂窝下载很慢。本模块在 dsh 进程内起一个本地反向
 * 代理：POST /api/* 的 JSON 响应按 Accept-Encoding 加 gzip（实测压缩
 * 到 ~10%），其余（SSE 长连接、静态资源、插件路由、WebSocket）原样
 * 透传——不破坏流式、不碰信任围栏（Host/Origin 头原样转发，dsh 对
 * 域名+端口本就放行）。
 *
 * 版本自适应：dsh 0.1.2+ webserver 已内置 compression:'gzip'（官方压
 * 缩 unary JSON 与静态资源）。startCompressProxy 先按旧版行为以 gzip
 * 模式启动，index.ts 随后经 detectOfficialGzip 异步探测本体——探测到
 * 官方压缩即 setMode('passthrough') 切纯透传（同一 server 零断流），
 * tailscale serve 指向无需变动。无论何种模式，上游响应若已带
 * content-encoding 一律原样透传，杜绝 gzip on gzip 双重压缩。
 *
 * 启用：cordis.patch.yml 的 meow-smooth config 加
 *   proxy: { enabled: true, port: 8444 }
 * （targetPort 自动从 dsh 启动参数 --port 解析，无需配置），然后把
 * tailscale serve（或任意反代）指向 127.0.0.1:<port>。默认关闭。
 */

import http from 'node:http'
import zlib from 'node:zlib'

/** 压缩代理运行模式：gzip=对 unary /api/* JSON 压缩（旧版 dsh）；
 *  passthrough=纯透传（新版 dsh 官方已压缩，代理只为保住既有反代链路）。 */
export type CompressProxyMode = 'gzip' | 'passthrough'

/** 压缩代理配置（index.ts Config.proxy 传入）。 */
export interface CompressProxyOptions {
  /** 代理监听端口（默认 8444）。 */
  port: number
  /** 上游 dsh 监听端口（默认从 process.argv 的 --port 解析）。 */
  targetPort: number
  /** 初始模式（默认 'gzip'）；新版探测结果由 setMode 运行时切换。 */
  mode?: CompressProxyMode
}

/** 从 dsh 启动参数解析 --port（插件运行在 dsh 进程内，argv 即 dsh 的）。 */
export function resolveTargetPort(): number {
  const argv = process.argv
  const idx = argv.indexOf('--port')
  if (idx !== -1 && idx + 1 < argv.length) {
    const value = Number(argv[idx + 1])
    if (Number.isFinite(value) && value > 0 && value < 65536) return value
  }
  return 3080
}

/**
 * 启动压缩代理（监听 127.0.0.1:port，转发 127.0.0.1:targetPort）。
 * @param options - 端口与初始模式配置。
 * @returns server（调用方经 ctx.effect 负责 close）与 setMode（探测
 *          官方 gzip 后切 passthrough 用，运行时切换零断流）。
 */
export function startCompressProxy(options: CompressProxyOptions): {
  server: http.Server
  setMode: (mode: CompressProxyMode) => void
} {
  const { port, targetPort } = options
  let mode: CompressProxyMode = options.mode ?? 'gzip'
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        // Host/Origin/Accept-Encoding 等全部原样透传：信任围栏按原 Host 校验，
        // 手机域名（node.tailxxxx.ts.net:8443）在 trusted-host 白名单内放行。
        headers: { ...req.headers },
      },
      (up) => {
        const contentType = up.headers['content-type'] ?? ''
        const wantsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip')
        const isUnaryJson = req.method === 'POST'
          && (req.url ?? '').startsWith('/api/')
          && contentType.includes('application/json')
        // 防双重压缩：上游已带 content-encoding（dsh 0.1.2+ 官方 gzip）
        // 时无论 mode 一律透传——再压一层浏览器解开后是内层 gzip 字节流。
        const upstreamEncoded = up.headers['content-encoding'] !== undefined
        if (mode === 'gzip' && isUnaryJson && wantsGzip && !upstreamEncoded) {
          const headers = { ...up.headers }
          delete headers['content-length']
          res.writeHead(up.statusCode ?? 200, { ...headers, 'content-encoding': 'gzip', 'vary': 'accept-encoding' })
          up.pipe(zlib.createGzip()).pipe(res)
        } else {
          res.writeHead(up.statusCode ?? 200, up.headers)
          up.pipe(res)
        }
      },
    )
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`meow-smooth compress-proxy: upstream error: ${error.message}`)
    })
    req.pipe(upstream)
  })

  // WebSocket upgrade 透传（双向 pipe；dsh 前端用 WS 连 events.mux/host）。
  server.on('upgrade', (req, socket, head) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      // 显式 Upgrade/Connection 头：Node http.request 默认按 keep-alive 管理
      // connection，不显式传会把 Upgrade 请求降级成普通请求（上游 426）。
      headers: { ...req.headers, connection: 'Upgrade', upgrade: 'websocket' },
    })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${
        Object.entries(upRes.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')
      }\r\n\r\n`)
      // 上游 101 后已到达的初始数据必须写回【浏览器】方向（之前误写上游导致丢帧断流）。
      if (upHead.length > 0) socket.write(upHead)
      socket.pipe(upSocket).pipe(socket)
    })
    // 上游拒绝（如 426 Upgrade Required）：把状态码透传给浏览器并关闭，不留悬空。
    upstream.on('response', (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}\r\n\r\n`)
      socket.end()
      upRes.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  server.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.warn(`[meow-smooth] compress proxy port ${port} already in use — set proxy.port in config`)
    } else {
      console.warn(`[meow-smooth] compress proxy error: ${error.message}`)
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[meow-smooth] compress proxy on 127.0.0.1:${port} -> 127.0.0.1:${targetPort} (mode: ${mode})`)
  })
  return {
    server,
    setMode(next: CompressProxyMode) {
      if (mode === next) return
      mode = next
      console.log(`[meow-smooth] compress proxy mode switched to ${next} (zero downtime, same server)`)
    },
  }
}

/**
 * 探测 dsh 本体是否已内置响应压缩（0.1.2+ webserver compression:'gzip'）。
 *
 * 方法：对本体的公开路由 /plugins/meow-smooth/client.js 发带
 * Accept-Encoding: gzip 的 GET，看响应 content-encoding 是否为 gzip——
 * 直接测实际行为而非解析版本号，官方压缩被配置关闭时也能正确回退。
 * 该路由由本插件 apply 内同步注册，探测异步进行必然晚于注册。
 *
 * 判定：200 + content-encoding: gzip → true；200 且未压缩 → false
 * （定论，毫秒级返回）；404/5xx/连接拒绝/超时 → 重试，耗尽后返回
 * false（保守按旧版处理——误判方向的代价是多一层无损透传而非断网）。
 *
 * @param targetPort - dsh 本体端口。
 * @param attempts - 最大尝试次数（默认 6）。
 * @param delayMs - 重试间隔毫秒（默认 150）。
 * @returns 官方 gzip 是否已生效。
 */
export async function detectOfficialGzip(targetPort: number, attempts = 6, delayMs = 150): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const verdict = await new Promise<'gzip' | 'plain' | 'unready'>((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: targetPort, path: '/plugins/meow-smooth/client.js', headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          res.resume()
          if (res.statusCode !== 200) { resolve('unready'); return }
          resolve(res.headers['content-encoding'] === 'gzip' ? 'gzip' : 'plain')
        },
      )
      req.setTimeout(1000, () => { req.destroy(new Error('detect timeout')); })
      req.on('error', () => resolve('unready'))
    })
    if (verdict === 'gzip') return true
    if (verdict === 'plain') return false
  }
  return false
}
