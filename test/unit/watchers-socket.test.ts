import { describe, expect, it } from 'vitest'
import type { BrainClient, BrainSessionSocket } from '../../src/brain/client.js'
import { createSessionWatchers } from '../../src/client/mux/watchers.js'

/**
 * 平台 → 脑的实时面：一个会话一条上游连接，首选会话 WebSocket，答复也走这条
 * 连接；Upgrade 建不起来时退回 SSE + REST 答复。
 */

const call = { userId: 'u1', workspaceId: 'ws_1', sessionId: 's_1' }

interface FakeBrain {
  brain: BrainClient
  /** socket 模式下由测试调用：把一帧投给订阅者。 */
  push(frame: Record<string, unknown>): void
  /** 关掉当前会话 socket；触发重连。 */
  drop(): void
  /** 记录带内答复。 */
  readonly answers: Array<{ requestId: string; outcome: unknown }>
  readonly sockets: number
  readonly streams: number
}

function fakeBrain(mode: 'socket' | 'sse'): FakeBrain {
  let emit: ((frame: Record<string, unknown>) => void) | undefined
  let closeSocket: (() => void) | undefined
  const answers: Array<{ requestId: string; outcome: unknown }> = []
  let sockets = 0
  let streams = 0

  const brain = {
    openSessionSocket: async (
      _input: unknown,
      signal: AbortSignal,
      onFrame: (frame: Record<string, unknown>) => void,
    ): Promise<BrainSessionSocket> => {
      if (mode === 'sse') throw new Error('brain-unreachable')
      sockets += 1
      emit = onFrame
      let closed = false
      const listeners: Array<() => void> = []
      signal.addEventListener('abort', () => socket.close(), { once: true })
      const socket: BrainSessionSocket = {
        get closed() {
          return closed
        },
        async answer(requestId, outcome) {
          answers.push({ requestId, outcome })
          return true
        },
        close() {
          if (closed) return
          closed = true
          for (const listener of listeners) listener()
        },
        onClose(listener) {
          if (closed) listener()
          else listeners.push(listener)
        },
      }
      closeSocket = () => socket.close()
      // 和真实脑一样，握手后立刻下发 ready + status。
      queueMicrotask(() => {
        onFrame({ type: 'ready', sessionId: 's_1', seq: 3 })
        onFrame({ type: 'status', running: true })
      })
      return socket
    },
    sessionFrames: async (
      _input: unknown,
      signal: AbortSignal,
      onFrame: (frame: Record<string, unknown>) => void,
    ): Promise<void> => {
      streams += 1
      emit = onFrame
      onFrame({ type: 'ready', sessionId: 's_1', seq: 3 })
      onFrame({ type: 'status', running: true })
      // 和真实 SSE 一样一直开着，直到订阅者取消。
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  } as unknown as BrainClient

  return {
    brain,
    push(frame) {
      emit?.(frame)
    },
    drop() {
      closeSocket?.()
    },
    answers,
    get sockets() {
      return sockets
    },
    get streams() {
      return streams
    },
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('会话上游订阅', () => {
  it('优先用会话 socket：帧按会话投递，答复走同一连接', async () => {
    const fake = fakeBrain('socket')
    const watchers = createSessionWatchers({ brain: fake.brain })
    const frames: Array<Record<string, unknown>> = []
    const stop = watchers.watch(call, (frame) => frames.push(frame as Record<string, unknown>))
    await settle()

    expect(fake.sockets).toBe(1)
    expect(fake.streams).toBe(0)
    expect(frames.map((frame) => frame.type)).toEqual(['ready', 'status'])
    expect(watchers.statusOf('s_1')).toEqual({ running: true, known: true })
    expect(watchers.cursorOf('s_1')).toBe(3)

    fake.push({ type: 'waterfall', requestId: 'req_1', kind: 'approval', request: {} })
    expect(watchers.pending('s_1')).toHaveLength(1)

    await expect(watchers.answer('s_1', 'req_1', { kind: 'result', value: 'approved' })).resolves.toBe(true)
    expect(fake.answers).toEqual([{ requestId: 'req_1', outcome: { kind: 'result', value: 'approved' } }])

    stop()
    watchers.close()
  })

  it('Upgrade 建不起来时退回 SSE，答复交回 REST', async () => {
    const fake = fakeBrain('sse')
    const watchers = createSessionWatchers({ brain: fake.brain })
    const frames: Array<Record<string, unknown>> = []
    const stop = watchers.watch(call, (frame) => frames.push(frame as Record<string, unknown>))
    await settle()

    expect(fake.sockets).toBe(0)
    expect(fake.streams).toBe(1)
    expect(frames.map((frame) => frame.type)).toEqual(['ready', 'status'])

    // 没有 socket：调用方据此回退到 `POST /answers`。
    expect(await watchers.answer('s_1', 'req_1', { kind: 'result', value: 'approved' })).toBeUndefined()

    stop()
    watchers.close()
  })

  it('多个订阅者共用一条上游连接，全部取消后才断开', async () => {
    const fake = fakeBrain('socket')
    const watchers = createSessionWatchers({ brain: fake.brain })
    const first: unknown[] = []
    const second: unknown[] = []
    const stopFirst = watchers.watch(call, (frame) => first.push(frame))
    const stopSecond = watchers.watch(call, (frame) => second.push(frame))
    await settle()

    expect(fake.sockets).toBe(1)
    fake.push({ type: 'event', seq: 4, event: { type: 'user', data: {} } })
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(3)

    stopFirst()
    fake.push({ type: 'event', seq: 5, event: { type: 'user', data: {} } })
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(4)

    stopSecond()
    watchers.close()
  })
})