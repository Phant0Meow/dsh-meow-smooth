/** web-push（CJS）最小类型声明：插件构建零 @deepseek-ai 依赖，而 web-push
 *  自带类型缺失，tsc 需要 ambient declare 才能通过 import('web-push')。
 *  实际 API 运行时由 notify-host 的 WebPushMod 结构子集约束。 */

declare module 'web-push' {
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string }
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void
  export function sendNotification(
    subscription: unknown,
    payload: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  const _default: object
  export default _default
}
