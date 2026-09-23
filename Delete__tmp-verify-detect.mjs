// 临时验证：detectOfficialGzip 三路判定 + compress-proxy 防双重压缩 + setMode 切换。
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

// ── 场景 1：gzip 上游（模拟 dsh 0.1.2+ 官方压缩）→ 探测 true，且第一轮即中 ──
const gzipServer = http.createServer((req, res) => {
  const body = zlib.gzipSync(Buffer.from(`console.log("${'x'.repeat(3000)}")`))
  res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip' })
  res.end(body)
})
await once((r) => gzipServer.listen(0, '127.0.0.1', r))
const gzipPort = gzipServer.address().port
const t1 = Date.now()
const r1 = await detectOfficialGzip(gzipPort)
check('detect gzip upstream → true', r1 === true, `took ${Date.now() - t1}ms`)
gzipServer.close()

// ── 场景 2：plain 上游（模拟旧版 dsh，200 无压缩）→ 探测 false，毫秒级定论 ──
const plainServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/javascript' })
  res.end('console.log("' + 'x'.repeat(3000) + '")')
})
await once((r) => plainServer.listen(0, '127.0.0.1', r))
const t2 = Date.now()
const r2 = await detectOfficialGzip(plainServer.address().port)
check('detect plain upstream → false', r2 === false, `took ${Date.now() - t2}ms`)
plainServer.close()

// ── 场景 3：连接拒绝（端口空置）→ 重试耗尽 → false（保守回退）──
const t3 = Date.now()
const r3 = await detectOfficialGzip(59999)
const elapsed3 = Date.now() - t3
check('detect dead port → false after retries', r3 === false, `took ${elapsed3}ms (expect ≥ ~750ms for 6×150ms)`)
check('retry timing sane', elapsed3 >= 700, `elapsed ${elapsed3}ms`)

// ── 场景 4：防双重压缩——上游已 gzip 的 unary JSON，代理 gzip 模式下必须原样透传 ──
const encodedServer = http.createServer((req, res) => {
  // 模拟官方已压缩的 /api/history 响应
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, big: 'y'.repeat(5000) })))
  res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
  res.end(body)
})
await once((r) => encodedServer.listen(0, '127.0.0.1', r))
const { server: proxy1 } = startCompressProxy({ port: 0, targetPort: encodedServer.address().port, mode: 'gzip' })
await once((r) => proxy1.on('listening', r))
const proxyPort1 = proxy1.address().port
const p1 = await fetch(`http://127.0.0.1:${proxyPort1}/api/history`, {
  method: 'POST', headers: { 'accept-encoding': 'gzip' }, body: '{}',
})
const buf1 = Buffer.from(await p1.arrayBuffer())
// 官方已 gzip 的 body：透传应保持原字节（长度不变）；若被二次压缩则长度必变
const upstreamBody = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, big: 'y'.repeat(5000) })))
check('upstream-encoded body passed through byte-identical', buf1.equals(upstreamBody), `len ${buf1.length} vs upstream ${upstreamBody.length}`)
check('single content-encoding: gzip', p1.headers.get('content-encoding') === 'gzip', `got ${p1.headers.get('content-encoding')}`)
proxy1.close(); encodedServer.close()

// ── 场景 5：gzip 模式 + 未压缩上游 → 正常压缩（旧版路径回归）──
const legacyServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, big: 'z'.repeat(5000) }))
})
await once((r) => legacyServer.listen(0, '127.0.0.1', r))
const { server: proxy2 } = startCompressProxy({ port: 0, targetPort: legacyServer.address().port })
await once((r) => proxy2.on('listening', r))
const p2 = await fetch(`http://127.0.0.1:${proxy2.address().port}/api/history`, {
  method: 'POST', headers: { 'accept-encoding': 'gzip' }, body: '{}',
})
const buf2 = Buffer.from(await p2.arrayBuffer())
let gunzipped = null
try { gunzipped = zlib.gunzipSync(buf2).toString() } catch { /* not gzip */ }
check('legacy path still compresses', p2.headers.get('content-encoding') === 'gzip' && gunzipped !== null && JSON.parse(gunzipped).ok === true)
proxy2.close(); legacyServer.close()

// ── 场景 6：setMode('passthrough') 后同一 server 不再压缩、连接不断 ──
const { server: proxy3, setMode } = startCompressProxy({ port: 0, targetPort: 0 })
await once((r) => proxy3.on('listening', r))
const proxyPort3 = proxy3.address().port
const liveServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, big: 'w'.repeat(5000) }))
})
await once((r) => liveServer.listen(0, '127.0.0.1', r))
// 把代理上游切到 liveServer（port 0 是占位——直接重建验证 setMode 语义即可）
proxy3.close()
const { server: proxy4, setMode: setMode4 } = startCompressProxy({ port: 0, targetPort: liveServer.address().port })
await once((r) => proxy4.on('listening', r))
const pre = await fetch(`http://127.0.0.1:${proxy4.address().port}/api/x`, { method: 'POST', headers: { 'accept-encoding': 'gzip' }, body: '{}' })
const preGzip = pre.headers.get('content-encoding') === 'gzip'
await pre.arrayBuffer()
setMode4('passthrough')
const post = await fetch(`http://127.0.0.1:${proxy4.address().port}/api/x`, { method: 'POST', headers: { 'accept-encoding': 'gzip' }, body: '{}' })
const postBody = JSON.parse(Buffer.from(await post.arrayBuffer()).toString())
check('mode switch: gzip before / passthrough after', preGzip === true && post.headers.get('content-encoding') === null && postBody.ok === true)
proxy4.close(); liveServer.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length > 0 ? 1 : 0)
