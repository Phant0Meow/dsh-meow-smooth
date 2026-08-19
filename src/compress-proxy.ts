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
 * 启用：cordis.patch.yml 的 meow-smooth config 加
 *   proxy: { enabled: true, port: 8444 }
 * （targetPort 自动从 dsh 启动参数 --port 解析，无需配置），然后把
 * tailscale serve（或任意反代）指向 127.0.0.1:<port>。默认关闭。
 */

import http from 'node:http'
import zlib from 'node:zlib'

/** 压缩代理配置（index.ts Config.proxy 传入）。 */
export interface CompressProxyOptions {
  /** 代理监听端口（默认 8444）。 */
  port: number
  /** 上游 dsh 监听端口（默认从 process.argv 的 --port 解析）。 */
  targetPort: number
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
 * @param options - 端口配置。
 * @returns 代理 server（调用方经 ctx.effect 负责 close）。
 */
export function startCompressProxy(options: CompressProxyOptions): http.Server {
  const { port, targetPort } = options
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
        if (isUnaryJson && wantsGzip) {
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
    console.log(`[meow-smooth] compress proxy on 127.0.0.1:${port} -> 127.0.0.1:${targetPort} (gzip unary /api/* JSON)`)
  })
  return server
}
