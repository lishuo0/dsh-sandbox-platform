/**
 * 回信投递：把 outbox 里的消息交给渠道适配器发回去。
 *
 * 消息先落库再发，所以平台重启、渠道掉线、模型中途失败都不会丢回信；
 * 渠道没在线时不消耗重试次数，只是往后放几分钟等连接回来。
 *
 * @module platform/modules/superagent/delivery
 */

import type { Deps } from '../../app/deps.js'
import type { SendResult } from './channel.js'
import type { Channels } from './connector.js'
import { claimOutbox, deferOutbox, discardOutbox, finishOutbox } from './store.js'

/** 渠道没在线时的等待时间；也是发送循环的空转间隔。 */
const OFFLINE_RETRY_MS = 5 * 60_000

export async function deliverOutbox(
  deps: Deps,
  channels: Channels,
  owner: string,
  limit = 8,
): Promise<number> {
  const items = await claimOutbox(deps.db, owner, limit)
  let sent = 0
  for (const item of items) {
    if (item.threadRootId === undefined) {
      await discardOutbox(deps.db, item, 'missing-thread-root')
      continue
    }
    let result: SendResult
    try {
      result = await channels.reply(
        item.channelId,
        {
          conversation: item.externalChatId,
          thread: item.threadRootId,
          inThread: item.body.replyInThread !== false,
        },
        item.body.text,
        item.id,
      )
    } catch (error) {
      await finishOutbox(deps.db, item, error instanceof Error ? error.message : String(error))
      continue
    }
    // 渠道暂时不可用：放回队列，不算失败，等渠道连上再发。
    if (result === 'offline') {
      await deferOutbox(deps.db, item, OFFLINE_RETRY_MS)
      continue
    }
    // 目标已经不存在（消息被删 / issue 被锁）：重试没有意义。
    if (result === 'gone') {
      await discardOutbox(deps.db, item, 'gone')
      continue
    }
    await finishOutbox(deps.db, item)
    sent += 1
  }
  return sent
}

/** 定时跑投递；`owner` 是这个副本的标识，和其他副本互不抢同一条。 */
export function startDeliveryLoop(deps: Deps, channels: Channels, owner: string, intervalMs = 2000): () => void {
  let stopped = false
  let running = false
  const timer = setInterval(() => {
    if (stopped || running) return
    running = true
    void deliverOutbox(deps, channels, owner)
      .catch((error: unknown) => console.error('superagent outbox', error))
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}