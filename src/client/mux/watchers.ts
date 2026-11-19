/**
 * 会话上游实时面的共享订阅。
 *
 * 平台对脑的实时面只应该有一条连接。首选会话级 WebSocket
 * （`GET /brain/v1/session/socket`，Upgrade），帧集与 SSE 完全相同；答复也从
 * 这条连接上行，所以答复不会落到另一台脑上。
 *
 * SSE（`GET /brain/v1/sessions/{id}/stream`）保留为回退：Upgrade 建不起来时
 * （入口不支持、旧脑版本）自动退回，帧集不变，答复改走 REST。
 *
 * 浏览器的会话流、`$events` 的审批/提问转发、`session/state` 的运行状态都
 * 共用这一条。这里按会话维护一个订阅器，引用计数归零后关闭。
 *
 * 只解析平台需要的帧：`ready`/`event`/`status`/`stream`/`waterfall`/`cancel`。
 * `waterfall` 留在内存里，晚连上的订阅者先补投（否则审批会 fail closed）。
 */

import type { BrainClient, BrainSessionSocket } from '../../brain/client.js'

export interface WatchKey {
  readonly userId: string
  readonly workspaceId: string
  readonly sessionId: string
}

/** 上游帧；字段与脑的会话 SSE 一致。 */
export interface WatchFrame {
  readonly type?: string
  readonly [key: string]: unknown
}

export interface SessionWatchers {
  /** 订阅一条会话；返回取消函数。第一次订阅才会建立上游连接。 */
  watch(key: WatchKey, listener: (frame: WatchFrame) => void): () => void
  /** 最近一次 `status` 帧；没有订阅或未收到时为 undefined。 */
  statusOf(sessionId: string): { running: boolean; known: boolean } | undefined
  /** 最近的日志偏移（`ready` 或 `event` 帧）。 */
  cursorOf(sessionId: string): number | undefined
  /** 当前待答请求；`$events` 重连时补投。 */
  pending(sessionId: string): readonly WatchFrame[]
  /** 结算（答复/撤回）后移除。 */
  settle(sessionId: string, requestId: string): void
  /**
   * 在会话 socket 上带内答复。
   * @returns true 脑已结算；false 该请求已撤销或不属于本会话；undefined 当前
   *   没有 socket（调用方退回 REST）。
   */
  answer(sessionId: string, requestId: string, outcome: unknown): Promise<boolean | undefined>
  /** 停止所有上游连接。 */
  close(): void
}

interface Entry {
  readonly key: WatchKey
  readonly controller: AbortController
  readonly listeners: Set<(frame: WatchFrame) => void>
  running: boolean
  known: boolean
  cursor: number | undefined
  waterfalls: Map<string, WatchFrame>
  stopped: boolean
  /** 当前会话 socket；回退到 SSE 时为 undefined。 */
  socket: BrainSessionSocket | undefined
}

export function createSessionWatchers(deps: { brain: BrainClient }): SessionWatchers {
  const entries = new Map<string, Entry>()

  const start = (entry: Entry): void => {
    const call = { userId: entry.key.userId, workspaceId: entry.key.workspaceId, sessionId: entry.key.sessionId }
    const signal = entry.controller.signal

    const run = async (): Promise<void> => {
      try {
        await deps.brain.openSessionSocket(call, signal, frame => deliver(entry, frame as WatchFrame))
          .then(socket => new Promise<void>((resolve) => {
            entry.socket = socket
            socket.onClose(resolve)
          }))
      } catch {
        // socket 建不起来（入口不支持 Upgrade、旧脑版本）：退回 SSE。
        if (entry.stopped || signal.aborted) return
        try {
          await deps.brain.sessionFrames(call, signal, frame => deliver(entry, frame as WatchFrame))
        } catch {
          // 脑不可达：留由下一次订阅重试；已有订阅者会收到断开。
        }
      } finally {
        entry.socket = undefined
      }
      if (entry.stopped || signal.aborted) return
      // 上游断线后短暂重试，直到没有订阅者。
      setTimeout(() => {
        if (!entry.stopped && entry.listeners.size > 0) void run()
      }, 2_000).unref?.()
    }
    void run()
  }

  const deliver = (entry: Entry, frame: WatchFrame): void => {
    if (frame.type === 'ready') {
      const seq = Number(frame.seq)
      if (Number.isSafeInteger(seq)) entry.cursor = seq
    }
    if (frame.type === 'event') {
      const seq = Number(frame.seq)
      if (Number.isSafeInteger(seq)) entry.cursor = seq
    }
    if (frame.type === 'status') {
      entry.known = true
      entry.running = frame.running === true
    }
    if (frame.type === 'waterfall') {
      const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
      if (requestId !== undefined) entry.waterfalls.set(requestId, frame)
    }
    if (frame.type === 'cancel') {
      const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
      if (requestId !== undefined) entry.waterfalls.delete(requestId)
    }
    for (const listener of [...entry.listeners]) {
      try {
        listener(frame)
      } catch {
        // 订阅者自己的错误不打断其它订阅者。
      }
    }
  }

  return {
    watch(key, listener) {
      let entry = entries.get(key.sessionId)
      if (entry === undefined) {
        entry = {
          key,
          controller: new AbortController(),
          listeners: new Set(),
          running: false,
          known: false,
          cursor: undefined,
          waterfalls: new Map(),
          stopped: false,
          socket: undefined,
        }
        entries.set(key.sessionId, entry)
        start(entry)
      }
      entry.listeners.add(listener)
      // 晚连上的订阅者先补投待答请求与已知状态。
      for (const frame of entry.waterfalls.values()) {
        try {
          listener(frame)
        } catch {
          /* ignore */
        }
      }
      if (entry.known) {
        try {
          listener({ type: 'status', running: entry.running })
        } catch {
          /* ignore */
        }
      }
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size > 0) return
        entry.stopped = true
        entry.controller.abort()
        entries.delete(key.sessionId)
      }
    },

    statusOf(sessionId) {
      const entry = entries.get(sessionId)
      if (entry === undefined) return undefined
      return { running: entry.running, known: entry.known }
    },

    cursorOf(sessionId) {
      return entries.get(sessionId)?.cursor
    },

    pending(sessionId) {
      return [...(entries.get(sessionId)?.waterfalls.values() ?? [])]
    },

    settle(sessionId, requestId) {
      entries.get(sessionId)?.waterfalls.delete(requestId)
    },

    async answer(sessionId, requestId, outcome) {
      // 只认已连上的 socket。超时/中途断开都返回 undefined，由调用方走 REST；
      // 两条路共用脑上的同一张待答表，重复结算只会得到 false。
      const socket = entries.get(sessionId)?.socket
      if (socket === undefined || socket.closed) return undefined
      try {
        return await socket.answer(requestId, outcome)
      } catch {
        return undefined
      }
    },

    close() {
      for (const entry of entries.values()) {
        entry.stopped = true
        entry.controller.abort()
      }
      entries.clear()
    },
  }
}
