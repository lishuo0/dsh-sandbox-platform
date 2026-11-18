/**
 * 平台输入队列（§4.3）。
 *
 * 浏览器发来的 prompt 只入平台队列，立即回 `accepted`；平台在会话的脑侧
 * SSE 上等 `status=idle`，再按 `created_at` 顺序用原 `requestId` 调脑的
 * `POST /brain/v1/sessions/{id}/messages`（`mode:'queue'`）。脑的 inbox
 * 正常应为空——平台是唯一排队者，避免「平台排一条、脑再排一条」。
 *
 * 队列落 `dsh_session_queue`，重启后按会话恢复；进程内存里只保留每个会话的
 * 一个「泵」，有排队消息或回合在跑时保持订阅，静默后关闭。
 *
 * @module client/mux/queue
 */

import { randomUUID } from 'node:crypto'
import type { BrainClient } from '../../brain/client.js'
import type { Db } from '../../kernel/db.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { sessionWorkspace } from '../../modules/workspaces/service.js'

/** 队列项在浏览器帧里的形状，和上游 `SessionQueuedItem` 一致。 */
export interface QueueItemView {
  readonly id: string
  readonly placement: 'queued'
  readonly rpcId: string
  readonly content: readonly unknown[]
}

/** 一条待派发的消息。 */
interface StoredItem {
  readonly itemId: string
  readonly requestId: string
  readonly userId: string
  readonly content: string
}

/** `session/updateQueue` 的三动作。 */
export type QueueAction = 'edit' | 'remove' | 'steer'

export interface QueueService {
  /** 入队一条消息，返回客户端可见的 `itemId`（= 队列项 id）。 */
  enqueue(input: { userId: string; sessionId: string; requestId: string; text: string }): Promise<{ itemId: string }>
  /** 一个会话当前的排队项，按派发顺序。 */
  items(sessionId: string): Promise<QueueItemView[]>
  /** 编辑 / 移除 / 立即并入当前回合。 */
  update(input: {
    userId: string
    sessionId: string
    itemId: string
    action: QueueAction
    text?: string
  }): Promise<{ ok: true } | { ok: false; code: 'session/queue-item-not-found' | 'session/steer-unavailable' }>
  /** 立即尝试派发（入队后调用）。 */
  wake(sessionId: string): void
  /** 停止所有泵并清空内存状态；队列表本身保留。 */
  close(): void
}

interface Pump {
  readonly controller: AbortController
  running: boolean
  /** 是否已经看到过至少一帧状态；未看到前不派发，避免把运行中的回合当成空闲。 */
  known: boolean
  idleTimer: NodeJS.Timeout | undefined
  /** 一次派发在途；防止状态帧与入队唤醒同时触发导致重复发送。 */
  sending: boolean
  /** 脑暂时不可达时的重试；空闲后没有新的状态帧会再来触发派发。 */
  retryTimer: NodeJS.Timeout | undefined
}

const ITEM_LIMIT = 200

/** 把 prompt 的 content 数组收成一段文本；平台的脑接口只收文本。 */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 浏览器帧里的 content：原文按上游 `PromptContentPart` 收成 text 数组。 */
function contentView(text: string): readonly unknown[] {
  return text === '' ? [] : [{ type: 'text', text }]
}

export function createQueueService(deps: { db: Db; objects: ObjectStore; brain: BrainClient }): QueueService {
  const pumps = new Map<string, Pump>()

  const rows = async (sessionId: string): Promise<StoredItem[]> => {
    const result = await deps.db.query<{
      item_id: string
      request_id: string
      user_id: string
      content: string
    }>(
      `SELECT item_id, request_id, user_id, content FROM dsh_session_queue
       WHERE session_id = $1 ORDER BY created_at ASC, item_id ASC LIMIT ${ITEM_LIMIT}`,
      [sessionId],
    )
    return result.rows.map(row => ({
      itemId: row.item_id,
      requestId: row.request_id,
      userId: row.user_id,
      content: row.content,
    }))
  }

  const deleteItem = async (sessionId: string, itemId: string): Promise<boolean> => {
    const result = await deps.db.query(
      `DELETE FROM dsh_session_queue WHERE session_id = $1 AND item_id = $2`,
      [sessionId, itemId],
    )
    return (result.rowCount ?? 0) > 0
  }

  const stopPump = (sessionId: string): void => {
    const pump = pumps.get(sessionId)
    if (pump === undefined) return
    pumps.delete(sessionId)
    if (pump.idleTimer !== undefined) clearTimeout(pump.idleTimer)
    if (pump.retryTimer !== undefined) clearTimeout(pump.retryTimer)
    pump.controller.abort()
  }

  /** 队列空且回合空闲时，宽限期后关闭泵，避免为静默会话常驻连接。 */
  const maybeStop = async (sessionId: string, pump: Pump): Promise<void> => {
    const pending = await rows(sessionId)
    if (pending.length > 0 || pump.running) return
    if (pump.idleTimer !== undefined) return
    pump.idleTimer = setTimeout(() => {
      const current = pumps.get(sessionId)
      if (current !== pump) return
      void rows(sessionId).then((items) => {
        if (items.length === 0 && !pump.running) stopPump(sessionId)
      }, () => undefined)
    }, 5_000)
    pump.idleTimer.unref?.()
  }

  /** 一次派发失败后自我重试；成功、状态帧到达或泵关闭时清掉。 */
  const scheduleRetry = (sessionId: string, pump: Pump): void => {
    if (pump.controller.signal.aborted || pump.retryTimer !== undefined) return
    pump.retryTimer = setTimeout(() => {
      pump.retryTimer = undefined
      if (pumps.get(sessionId) !== pump) return
      void dispatch(sessionId, pump).catch(() => undefined)
    }, 2_000)
    pump.retryTimer.unref?.()
  }

  /**
   * 派发队首。脑不可达或会话尚未就绪时留在队列里并安排重试：空闲会话不会再有
   * 新的 `status` 帧，只等状态帧会把消息永远卡在队列里。
   */
  const dispatch = async (sessionId: string, pump: Pump): Promise<void> => {
    if (pump.running || pump.sending) return
    const pending = await rows(sessionId)
    const first = pending[0]
    if (first === undefined) {
      if (pump.retryTimer !== undefined) {
        clearTimeout(pump.retryTimer)
        pump.retryTimer = undefined
      }
      await maybeStop(sessionId, pump)
      return
    }
    let workspaceId = ''
    try {
      workspaceId = (await sessionWorkspace(deps.db, deps.objects, first.userId, sessionId)).id
    } catch {
      // 会话可能刚被删除；下一行同样不可派发。
      return
    }
    pump.sending = true
    let sent: { ok: boolean }
    try {
      sent = await deps.brain.sendMessage({
        userId: first.userId,
        workspaceId,
        sessionId,
        requestId: first.requestId,
        text: first.content,
        mode: 'queue',
      })
    } finally {
      pump.sending = false
    }
    if (!sent.ok) {
      scheduleRetry(sessionId, pump)
      return
    }
    if (pump.retryTimer !== undefined) {
      clearTimeout(pump.retryTimer)
      pump.retryTimer = undefined
    }
    await deleteItem(sessionId, first.itemId)
    pump.running = true
    pump.known = true
  }

  const pumpFor = (sessionId: string, userId: string, workspaceId: string): void => {
    const existing = pumps.get(sessionId)
    if (existing !== undefined) {
      if (existing.idleTimer !== undefined) {
        clearTimeout(existing.idleTimer)
        existing.idleTimer = undefined
      }
      return
    }
    const pump: Pump = {
      controller: new AbortController(),
      running: false,
      known: false,
      idleTimer: undefined,
      sending: false,
      retryTimer: undefined,
    }
    pumps.set(sessionId, pump)
    const run = async (): Promise<void> => {
      try {
        await deps.brain.sessionFrames(
          { userId, workspaceId, sessionId },
          pump.controller.signal,
          (frame) => {
            if (frame.type === 'status') {
              pump.known = true
              pump.running = frame.running === true
              // 状态帧是权威的回合状态：作废任何在途失败重试。
              if (pump.retryTimer !== undefined) {
                clearTimeout(pump.retryTimer)
                pump.retryTimer = undefined
              }
              if (!pump.running) void dispatch(sessionId, pump).catch(() => undefined)
            }
            if (frame.type === 'ready' && !pump.running) {
              // ready 之后紧跟一帧 status；等它到达再派发。
            }
          },
        )
      } catch {
        // 脑不可达：稍后重试，只要队列里还有东西。
      }
      if (pump.controller.signal.aborted) return
      const pending = await rows(sessionId).catch(() => [] as StoredItem[])
      if (pending.length > 0 || pump.running) {
        setTimeout(() => { void run() }, 2_000).unref?.()
      } else {
        stopPump(sessionId)
      }
    }
    void run()
  }

  return {
    async enqueue(input) {
      const itemId = `msg_${randomUUID()}`
      await deps.db.query(
        `INSERT INTO dsh_session_queue (session_id, item_id, request_id, user_id, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.sessionId, itemId, input.requestId, input.userId, input.text],
      )
      return { itemId }
    },

    async items(sessionId) {
      return (await rows(sessionId)).map(item => ({
        id: item.itemId,
        placement: 'queued' as const,
        rpcId: item.requestId,
        content: contentView(item.content),
      }))
    },

    async update(input) {
      const found = (await rows(input.sessionId)).find(item => item.itemId === input.itemId)
      if (found === undefined) return { ok: false, code: 'session/queue-item-not-found' }
      if (input.action === 'remove') {
        await deleteItem(input.sessionId, input.itemId)
        return { ok: true }
      }
      if (input.action === 'edit') {
        await deps.db.query(
          `UPDATE dsh_session_queue SET content = $3 WHERE session_id = $1 AND item_id = $2`,
          [input.sessionId, input.itemId, input.text ?? found.content],
        )
        return { ok: true }
      }
      // steer：立即并入当前回合，出队；失败时保留在队列里，语义不变。
      const pump = pumps.get(input.sessionId)
      if (pump === undefined || !pump.running) return { ok: false, code: 'session/steer-unavailable' }
      const workspaceId = await ownedWorkspaceId(deps.db, input.userId, input.sessionId)
      const sent = await deps.brain.sendMessage({
        userId: input.userId,
        workspaceId,
        sessionId: input.sessionId,
        requestId: found.requestId,
        text: input.text ?? found.content,
        mode: 'steer',
      })
      if (!sent.ok) return { ok: false, code: 'session/steer-unavailable' }
      await deleteItem(input.sessionId, input.itemId)
      return { ok: true }
    },

    wake(sessionId) {
      void (async () => {
        const pending = await rows(sessionId)
        if (pending.length === 0) return
        const first = pending[0] as StoredItem
        const workspace = await sessionWorkspace(deps.db, deps.objects, first.userId, sessionId)
          .catch(() => undefined)
        if (workspace === undefined) return
        pumpFor(sessionId, first.userId, workspace.id)
        // 泵若已确认空闲，脑不会再发新的 `status`：入队本身就是派发触发点。
        const pump = pumps.get(sessionId)
        if (pump !== undefined && pump.known && !pump.running) {
          void dispatch(sessionId, pump).catch(() => undefined)
        }
      })().catch(() => undefined)
    },

    close() {
      for (const sessionId of [...pumps.keys()]) stopPump(sessionId)
    },
  }
}

async function ownedWorkspaceId(db: Db, userId: string, sessionId: string): Promise<string> {
  const rows = await db.query<{ workspace_id: string | null }>(
    `SELECT workspace_id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  )
  return rows.rows[0]?.workspace_id ?? ''
}
