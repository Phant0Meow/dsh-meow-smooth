import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

process.on('unhandledRejection', e => console.log('UNHANDLED:', e))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'meow-dbg-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const payloads = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => { console.log('WEBHOOK GOT:', raw.slice(0, 120)); payloads.push(raw); res.writeHead(200); res.end('ok') })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('webhook port:', port)

const { installNotifyHost } = await import('../src/notify-host.ts')
let captured = null
const handle = installNotifyHost({
  on(type, fn) { if (type === 'session/event') captured = fn; return () => {} },
}, { longTaskToolCalls: 7, webhookUrl: `http://127.0.0.1:${port}/bark` })

captured({ id: 'sx' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { message: 'dbg', code: 'X' } } } })
console.log('queue:', JSON.stringify(handle.completionEvents()))
await sleep(800)
console.log('payload count:', payloads.length)
server.close()
