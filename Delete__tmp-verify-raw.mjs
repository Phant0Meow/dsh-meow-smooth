// 临时验证 v3：rawRequest 版（POST 压缩路径 + GET 透传路径 + 防双压）。
// 跑完本文件按「绝不删除」协议改名 Delete_ 前缀留痕。
import http from 'node:http'
import zlib from 'node:zlib'
import { detectOfficialGzip, startCompressProxy } from './_tmp-detect-test.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const once = (fn) => new Promise((resolve) => fn(resolve))
function rawRequest(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ── 1：防双重压缩——上游已 gzip 的 POST /api JSON，代理 gzip 模式下原样透传 ──
const upstreamBody = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, big: 'y'.repeat(5000) })))
const encodedServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
  res.end(upstreamBody)
})
await once((r) => encodedServer.listen(0, '127.0.0.1', r))
const p1 = startCompressProxy({ port: 0, targetPort: encodedServer.address().port, mode: 'gzip' })
await once((r) => p1.server.on('listening', r))
const r1 = await rawRequest(p1.server.address().port, 'POST', '/api/history', { 'accept-encoding': 'gzip' })
check('upstream-encoded body byte-identical (no double gzip)', r1.body.equals(upstreamBody), `len ${r1.body.length} vs ${upstreamBody.length}`)
check('single content-encoding: gzip', r1.headers['content-encoding'] === 'gzip', String(r1.headers['content-encoding']))
p1.server.close(); encodedServer.close()

// ── 2：gzip 模式 + 未压缩上游 + POST /api → 压缩（旧版路径回归）──
const legacyBody = Buffer.from(JSON.stringify({ ok: true, big: 'z'.repeat(5000) }))
const legacyServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(legacyBody)
})
await once((r) => legacyServer.listen(0, '127.0.0.1', r))
const p2 = startCompressProxy({ port: 0, targetPort: legacyServer.address().port })
await once((r) => p2.server.on('listening', r))
const r2 = await rawRequest(p2.server.address().port, 'POST', '/api/history', { 'accept-encoding': 'gzip' })
let gunzipped = null
try { gunzipped = JSON.parse(zlib.gunzipSync(r2.body).toString()).ok } catch { /* not gzip */ }
check('legacy path still compresses (gzip, roundtrip ok)',
  r2.headers['content-encoding'] === 'gzip' && gunzipped === true && r2.body.length < legacyBody.length,
  `body ${r2.body.length}B vs plain ${legacyBody.length}B`)
p2.server.close(); legacyServer.close()

// ── 3：GET 非 /api 路径 → 透传不压（回归透传分支）──
const passthroughServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('plain-static')
})
await once((r) => passthroughServer.listen(0, '127.0.0.1', r))
const p3 = startCompressProxy({ port: 0, targetPort: passthroughServer.address().port })
await once((r) => p3.server.on('listening', r))
const r3 = await rawRequest(p3.server.address().port, 'GET', '/plugins/other/asset.js', { 'accept-encoding': 'gzip' })
check('non-/api GET passes through untouched', r3.body.toString() === 'plain-static' && r3.headers['content-encoding'] === undefined)
p3.server.close(); passthroughServer.close()

// ── 4：setMode 切换——同一 server 先压后不压 ──
const liveServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(legacyBody)
})
await once((r) => liveServer.listen(0, '127.0.0.1', r))
const p4 = startCompressProxy({ port: 0, targetPort: liveServer.address().port })
await once((r) => p4.server.on('listening', r))
const pre = await rawRequest(p4.server.address().port, 'POST', '/api/x', { 'accept-encoding': 'gzip' })
p4.setMode('passthrough')
const post = await rawRequest(p4.server.address().port, 'POST', '/api/x', { 'accept-encoding': 'gzip' })
check('setMode: gzip before / passthrough after, same server',
  pre.headers['content-encoding'] === 'gzip' && post.headers['content-encoding'] === undefined && post.body.equals(legacyBody))
p4.server.close(); liveServer.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length > 0 ? 1 : 0)
