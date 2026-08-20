// push-test.mjs — 向已存订阅发一条测试推送（验证 APNs/WNS 可达与发送链路）。
// 用法：node scripts/push-test.mjs [dataDir]（默认 ~/.dsh/.meow-smooth）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.argv[2] ?? join(homedir(), '.dsh', '.meow-smooth')
const vapid = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'))
const subs = JSON.parse(readFileSync(join(dir, 'subscriptions.json'), 'utf8'))
const webPush = (await import('web-push')).default
webPush.setVapidDetails('mailto:meow-smooth@users.noreply.github.com', vapid.publicKey, vapid.privateKey)

console.log('subs=', subs.length)
for (const sub of subs) {
  const kind = sub.endpoint.includes('apple.com') ? 'APNs(iOS)' : sub.endpoint.includes('windows.com') ? 'WNS(Windows)' : 'other'
  try {
    const res = await webPush.sendNotification(sub, JSON.stringify({
      title: 'meow-smooth 测试推送',
      body: '链路测试：如果你看到这条，push 全链路通了',
      tag: 'push-test',
    }), { TTL: 600 })
    console.log(`${kind}: OK status=${res.statusCode}`)
  } catch (error) {
    const e = error
    console.log(`${kind}: FAIL statusCode=${e.statusCode} body=${typeof e.body === 'string' ? e.body.slice(0, 200) : ''} msg=${e.message?.slice(0, 160)}`)
  }
}
