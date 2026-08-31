/** 运行时发送按钮，conversation.input.right 槽位。
 *
 *  AI 运行时官方主按钮变停止，电脑按回车能插话/排队，手机回车被需求 4 改成换行、又无修饰键，插话途径就没了。
 *
 *  恒显示、外观与图标完全复刻官方 primary。提交经 apply 注入的 submitMode 走官方 SessionInput.submit(mode)，并按会话 ui-conversation 命名空间的 busyEnter 设置决定 mode：queue（排队）或 steer（直接推进当前 turn），从而与官方回车行为对齐。
 */
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'

/** busyEnter 可选值（与 dsh CONVERSATION_SETTINGS busyEnter 一致）。 */
export type RunSendMode = 'queue' | 'steer'

/** 官方 standardProps + 插件注入的最小面。 */
interface RunSendButtonProps {
  /** 官方 standardProp：当前 Session 快照选择器。 */
  useSession: <T>(selector: (snapshot: unknown) => T) => T
  /** 官方 standardProp：当前输入机器快照选择器。 */
  useInput: <T>(selector: (snapshot: unknown) => T) => T
  /** 插件注入：带 mode 的提交，内部走 SessionInput.submit(mode)。 */
  submitMode: (mode: RunSendMode) => void
  /** 插件注入：读取会话 busyEnter 设置的响应式 hook。 */
  useBusyEnter: () => RunSendMode | undefined
}

export function RunSendButton({
  useSession, useInput, submitMode, useBusyEnter,
}: RunSendButtonProps): ReactNode {
  const running = useSession((snapshot) => {
    const s = snapshot as { running?: boolean } | null | undefined
    return s?.running === true
  })
  const draft = useInput((snapshot) => {
    const s = snapshot as { draft?: string } | null | undefined
    return s?.draft ?? ''
  })
  const busyEnter = useBusyEnter()
  // steering 可用性用 useSession standardProp 内部推导（对齐官方：非子代理会话才可 steer）。
  const steeringAvailable = useSession((snapshot) => {
    const s = snapshot as { subagent?: unknown } | null | undefined
    return s?.subagent === null || s?.subagent === undefined
  })
  // 非运行＝灰度态 data-meow-idle，提示当前不可插话，但点击仍可用，等价普通发送。
  const idle = !running
  // disabled 只由空草稿驱动，真正不可点；非运行不真正禁用，仅视觉变灰。
  const disabled = draft.trim() === ''

  const dispatchRunEnter = (): void => {
    // 非运行＝普通发送（官方 resolve 亦退化为 queue）；运行＝按 busyEnter 设置，steering 不可用（子代理等）时退化为 queue，与官方 ComposerSubmissionPolicy.resolve 对齐。
    const mode: RunSendMode = running && steeringAvailable ? (busyEnter ?? 'queue') : 'queue'
    submitMode(mode)
  }

  return (
    <button
      type="button"
      data-meow-run-send
      data-meow-idle={idle || undefined}
      data-disabled={disabled || undefined}
      title={running ? '插话或排队发送' : '发送（回车）'}
      aria-label={running ? '插话或排队发送' : '发送（回车）'}
      disabled={disabled}
      onClick={dispatchRunEnter}
    >
      {/* 官方 primary 发送按钮同款图标。 */}
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
        />
      </svg>
    </button>
  )
}

/** 把 settingsScope 的 busyEnter 绑定适配成 useSyncExternalStore 可直接消费的处理，供 apply 里构建 useBusyEnter 使用。
 * SettingsScopeController 的 subscribe/getSnapshot 是依赖 this 的类方法，直接传引用会因 this 丢失崩溃；
 * 这里用闭包箭头包装固定 this，并在本函数内只创建一次（useSyncExternalStore 要求引用稳定）。 */
export function createBusyEnterHook(
  scope: { subscribe(cb: () => void): () => void; getSnapshot(): { value?: { busyEnter?: RunSendMode } | null } } | undefined,
): () => RunSendMode | undefined {
  if (scope === undefined) return () => undefined
  const get = () => scope.getSnapshot().value?.busyEnter
  const subscribe = (cb: () => void) => scope.subscribe(cb)
  return () => useSyncExternalStore(subscribe, get, get)
}
