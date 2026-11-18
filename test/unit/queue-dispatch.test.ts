import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainClient } from '../../src/brain/client.js'
import type { Db } from '../../src/kernel/db.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { createQueueService, type QueueService } from '../../src/client/mux/queue.js'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.js'

/**
 * 队列泵的派发触发点。
 *
 * 回归点：泵只在脑的 `status(running:false)` 帧上派发。一个空闲会话在收过最后
 * 一条状态帧后不会再发状态；此时浏览器发第二条消息，`wake` 只重新挂泵、没有
 * 新状态帧可等，消息就永远留在 `dsh_session_queue` 里（现象：发送完成但没有
 * 任何响应，刷新也看不到）。
 */

const S = 's_queue00000000000000000000000000'
const W = 'ws_queue0000000000000000000000000'
const U = 'u_queue'

interface SentCall {
  sessionId: string
  requestId: string
  text: string
  mode: string | undefined
}

let database: TestDatabase
let db: Db
let service: QueueService
let sent: SentCall[]
let failures: number
/** 每个 `sessionFrames` 订阅的帧投递函数；`push` 往所有订阅者写一帧。 */
let subscribers: Array<(frame: unknown) => void>

const brain = (): BrainClient => ({
  sendMessage: async (input: { sessionId: string; requestId: string; text: string; mode?: string }) => {
    if (failures > 0) {
      failures -= 1
      return { ok: false, status: 503, code: 'gateway/internal' }
    }
    sent.push({ sessionId: input.sessionId, requestId: input.requestId, text: input.text, mode: input.mode })
    return { ok: true, status: 202, code: '' }
  },
  sessionFrames: async (
    _input: { sessionId: string },
    signal: AbortSignal,
    onFrame: (frame: unknown) => void,
  ) => {
    subscribers.push(onFrame)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  },
}) as unknown as BrainClient

const push = (frame: unknown): void => {
  for (const deliver of subscribers) deliver(frame)
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

const queued = async (): Promise<string[]> => {
  const rows = await db.query<{ request_id: string }>(
    `SELECT request_id FROM dsh_session_queue WHERE session_id = $1 ORDER BY created_at ASC, item_id ASC`,
    [S],
  )
  return rows.rows.map((row) => row.request_id)
}

beforeEach(async () => {
  database = await createTestDatabase()
  db = database.pool
  sent = []
  failures = 0
  subscribers = []
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, 'u', 'x')`, [U])
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, 'w', '/tmp/q', '/desk')`,
    [W, U],
  )
  await db.query(`INSERT INTO dsh_sessions (id, user_id, workspace_id) VALUES ($1, $2, $3)`, [S, U, W])
  service = createQueueService({ db, objects: {} as ObjectStore, brain: brain() })
})

afterEach(async () => {
  service.close()
  await database.drop()
})

describe('队列泵的派发触发点', () => {
  it('空闲后再入队的消息不必等新的状态帧，立即派发', async () => {
    await service.enqueue({ userId: U, sessionId: S, requestId: 'r1', text: 'first' })
    service.wake(S)
    await waitUntil(() => subscribers.length === 1)
    push({ type: 'status', running: false })
    await waitUntil(() => sent.length === 1)
    expect(sent[0]).toMatchObject({ requestId: 'r1', text: 'first', mode: 'queue' })

    // 第一轮结束，脑报空闲。泵留在原地确认空闲，之后不会再有状态帧。
    push({ type: 'status', running: false })
    await waitUntil(async () => (await queued()).length === 0)

    // 泵仍在、已确认空闲；第二条消息必须靠入队唤醒派发。
    await service.enqueue({ userId: U, sessionId: S, requestId: 'r2', text: 'second' })
    service.wake(S)
    await waitUntil(() => sent.length === 2)
    expect(sent[1]).toMatchObject({ requestId: 'r2', text: 'second', mode: 'queue' })
    expect(await queued()).toEqual([])
  })

  it('回合运行中先不派发，等到空闲状态帧再发', async () => {
    await service.enqueue({ userId: U, sessionId: S, requestId: 'r1', text: 'first' })
    service.wake(S)
    await waitUntil(() => subscribers.length === 1)
    push({ type: 'status', running: true })
    await flush()
    expect(sent).toEqual([])

    push({ type: 'status', running: false })
    await waitUntil(() => sent.length === 1)
    expect(sent[0]?.requestId).toBe('r1')
  })

  it('派发失败后留在队列并自动重试，成功才出队', async () => {
    failures = 1
    await service.enqueue({ userId: U, sessionId: S, requestId: 'r1', text: 'first' })
    service.wake(S)
    await waitUntil(() => subscribers.length === 1)
    push({ type: 'status', running: false })
    // 第一次发送失败：消息仍在队列里，且不会再有任何状态帧来触发。
    await flush()
    expect(sent).toEqual([])
    expect(await queued()).toEqual(['r1'])
    // 重试由泵自己安排（2s 退避），不依赖外部事件。
    await waitUntil(() => sent.length === 1, 3_000)
    expect(sent[0]?.requestId).toBe('r1')
    expect(await queued()).toEqual([])
  })
})
