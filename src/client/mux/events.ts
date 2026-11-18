/**
 * `$events`：浏览器侧的转发事件通道（会话级实时面的补充）。
 *
 * `$events` 只承载交互请求（审批、提问、计划评审）与结算撤回，不承载任何
 * 跨会话的业务推送。请求由会话跟随流从脑的 `waterfall` 帧抬上来，按
 * `(userId, sessionId)` 找对应的客户端代次；答复经 `$events/result` 回到脑。
 *
 * 平台在这里保存 `eventId(requestId) → sessionId` 与
 * `callId → eventId` 两张表：前者用于答复路由，后者用于
 * `userQuestions/answer`（它只带 `callId`）。
 */

import type { BrainClient } from '../../brain/client.js'

export interface ForwardedSink {
  readonly clientId: string
  send(frame: unknown): void
}

export interface ForwardedEvents {
  /** 绑定一条 `$events` 客户端代次；返回解绑函数。 */
  attach(userId: string, sink: ForwardedSink): () => void
  /** 是否有该成员的事件客户端（没有就不必为它缓存应答路由）。 */
  has(userId: string): boolean
  /** 广播一帧给该成员的全部客户端代次。 */
  emit(userId: string, frame: unknown): void
  /** 记录一次待答请求的路由信息。 */
  register(eventId: string, userId: string, sessionId: string, callId?: string): void
  /** 按 `eventId` 找到归属。 */
  owner(eventId: string): { userId: string; sessionId: string } | undefined
  /** 按 `callId` 找到 `eventId`。 */
  eventOfCall(callId: string): string | undefined
  /** 结算后清理。 */
  settle(eventId: string): void
  /** 取消该成员的全部代次。 */
  detachAll(userId: string): void
}

export function createForwardedEvents(): ForwardedEvents {
  const sinks = new Map<string, Set<ForwardedSink>>()
  const owners = new Map<string, { userId: string; sessionId: string }>()
  const callIndex = new Map<string, string>()

  const remove = (eventId: string): void => {
    owners.delete(eventId)
    for (const [callId, mapped] of callIndex) {
      if (mapped === eventId) callIndex.delete(callId)
    }
  }

  return {
    attach(userId, sink) {
      let set = sinks.get(userId)
      if (set === undefined) {
        set = new Set()
        sinks.set(userId, set)
      }
      set.add(sink)
      return () => {
        set.delete(sink)
        if (set.size === 0) sinks.delete(userId)
      }
    },

    has(userId) {
      return (sinks.get(userId)?.size ?? 0) > 0
    },

    emit(userId, frame) {
      for (const sink of [...(sinks.get(userId) ?? [])]) {
        try {
          sink.send(frame)
        } catch {
          /* 单一代次写失败不影响其它代次 */
        }
      }
    },

    register(eventId, userId, sessionId, callId) {
      owners.set(eventId, { userId, sessionId })
      if (callId !== undefined) callIndex.set(callId, eventId)
    },

    owner(eventId) {
      return owners.get(eventId)
    },

    eventOfCall(callId) {
      return callIndex.get(callId)
    },

    settle(eventId) {
      remove(eventId)
    },

    detachAll(userId) {
      sinks.delete(userId)
    },
  }
}

/** 脑的 `waterfall.kind` → 浏览器转发的 Cordis 事件名。 */
export function forwardedEventName(kind: unknown): string | undefined {
  if (kind === 'approval') return 'approval/request'
  if (kind === 'questions' || kind === 'plan') return 'user-questions/request'
  return undefined
}

/** 从一个 water-/question 请求里取前景 `callId`（用于 `userQuestions/answer`）。 */
export function callIdOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return undefined
  const wait = (request as { wait?: unknown }).wait
  if (typeof wait === 'object' && wait !== null) {
    const callId = (wait as { callId?: unknown }).callId
    if (typeof callId === 'string') return callId
  }
  const callId = (request as { callId?: unknown }).callId
  return typeof callId === 'string' ? callId : undefined
}

/**
 * 把一个 `$events/result` 的 outcome 收窄成脑的答复体。
 *
 * `next` 表示浏览器没有处理它：按拒绝结算，让工具 fail closed，而不是挂着。
 */
export function answerOutcome(
  outcome: unknown,
): { kind: 'result'; value: unknown } | { kind: 'rejected'; error: string } {
  if (typeof outcome !== 'object' || outcome === null) {
    return { kind: 'rejected', error: 'invalid-outcome' }
  }
  const kind = (outcome as { kind?: unknown }).kind
  if (kind === 'result') return { kind: 'result', value: (outcome as { value?: unknown }).value }
  if (kind === 'rejected') {
    const error = (outcome as { error?: unknown }).error
    const text = typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : 'rejected'
    return { kind: 'rejected', error: text }
  }
  return { kind: 'rejected', error: 'unhandled' }
}

/** 答复体经脑的 `POST …/answers` 交回 answerer。 */
export async function sendAnswer(
  brain: BrainClient,
  input: { userId: string; workspaceId: string; sessionId: string; requestId: string },
  outcome: { kind: 'result'; value: unknown } | { kind: 'rejected'; error: string },
): Promise<void> {
  await brain.answer({
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    outcome,
  })
}
