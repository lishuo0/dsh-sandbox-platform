/**
 * 漏消息补偿：长连接被别处分走、短暂断开、事件重投丢失时，从飞书会话历史里补回来。
 *
 * 飞书在同一个应用有多条长连接时会把事件分给其中一条，平台可能整条消息都收不到。
 * 所以除了长连接，还要按绑定逐个会话拉最近的聊天记录，交给同一条 {@link intake}
 * 流程——去重靠消息表里的唯一键，补漏重复拉到也不会重复回复。
 *
 * 只在平台自己的一个副本上跑（和渠道、投递、执行循环同一个进程）。
 *
 * @module platform/modules/superagent/catchup
 */

import type { ChannelHandle } from './channel.js'
import type { Channels } from './connector.js'
import { createFeishuApi, feishuInbound, parseMessageRecord, type FeishuApi, type FeishuCredential } from './feishu.js'
import { intake, type IntakeDeps } from './intake.js'
import {
  activeChannels,
  bindingsForChannel,
  lastInboundAt,
  noteChannelHealth,
  openChannel,
} from './store.js'

/** 有水位线时最多往前补多久：平台重启后不会把很久以前的消息翻出来回复。 */
export const CATCHUP_MAX_BACKFILL_MS = 30 * 60_000
/** 没有水位线（这个会话还没收过任何消息）时只补最近几分钟。 */
export const CATCHUP_COLD_START_MS = 5 * 60_000
/** 从最近一条已收到的消息往前留的重叠，专治「中间漏一条、后一条又收到了」。 */
export const CATCHUP_OVERLAP_MS = 2 * 60_000
/** 默认轮询间隔。 */
export const CATCHUP_INTERVAL_MS = 30_000

/** 建 API 的方式；测试换成假的，不碰网络。 */
export type FeishuApiFactory = (credential: FeishuCredential) => FeishuApi

export interface CatchupRuntime {
  apiFor: FeishuApiFactory
  /** 只补正在连着长连接的渠道，避免在连接不可用时白跑模型。 */
  isLive(channelId: string): boolean | Promise<boolean>
}

/**
 * 这一次补漏从什么时间点开始拉。
 *
 * 水位线（最近一次落库时间）往前留点重叠；没有水位线时只看最近的冷启动窗口，
 * 不会把绑定之前的历史翻出来。绑定创建时间是最低边界。
 */
export function catchupStart(
  bindingCreatedAt: string,
  lastAt: string | undefined,
  now: number,
): number {
  const created = Date.parse(bindingCreatedAt)
  const cold = now - CATCHUP_COLD_START_MS
  if (lastAt === undefined) {
    return Math.max(Number.isFinite(created) ? created : 0, cold)
  }
  const last = Date.parse(lastAt)
  const floor = Number.isFinite(last) ? last - CATCHUP_OVERLAP_MS : cold
  return Math.max(
    Number.isFinite(created) ? created : 0,
    floor,
    now - CATCHUP_MAX_BACKFILL_MS,
  )
}

/** 补一条渠道下所有绑定的漏消息；返回真正处理过的条数（去重和未绑定的不算）。 */
export async function catchUpChannel(
  deps: IntakeDeps,
  channel: ChannelHandle,
  api: FeishuApi,
  now = Date.now(),
): Promise<number> {
  const bindings = await bindingsForChannel(deps.db, channel.id)
  if (bindings.length === 0) return 0
  const botOpenId = await api.botOpenId()
  let handled = 0
  for (const binding of bindings) {
    const lastAt = await lastInboundAt(deps.db, channel.id, binding.externalChatId)
    const start = catchupStart(binding.createdAt, lastAt, now)
    if (start >= now) continue
    // 历史接口不返回 chat_type；拿不到会话信息时按私聊绑定名兜底。
    const direct = (await api.isDirectChat(binding.externalChatId)) ?? binding.chatName === '私聊'
    const records = await api.listMessages(binding.externalChatId, {
      startAt: new Date(start).toISOString(),
      endAt: new Date(now).toISOString(),
    })
    for (const record of records) {
      const parsed = parseMessageRecord(record, {
        chatId: binding.externalChatId,
        direct,
        ...(botOpenId === undefined ? {} : { botOpenId }),
      })
      if (parsed === undefined) continue
      const event = feishuInbound(parsed)
      // 飞书的 start_time 只精确到秒；落在边界之前的再挡一次。
      const at = Date.parse(event.at)
      if (Number.isFinite(at) && at < start) continue
      const result = await intake(deps, channel, event)
      if (result.action !== 'duplicate' && result.action !== 'not-addressed' && result.action !== 'unbound') {
        handled += 1
      }
    }
  }
  return handled
}

/** 对所有在线渠道补一遍；单条渠道失败只记健康状态，不影响别的渠道。 */
export async function catchUpAll(
  deps: IntakeDeps,
  runtime: CatchupRuntime,
  now = Date.now(),
): Promise<void> {
  for (const channel of await activeChannels(deps.db)) {
    // 补漏只针对飞书：GitHub 的事件重投由 webhook 的 delivery 重试负责。
    if (channel.provider !== 'feishu') continue
    if (!(await runtime.isLive(channel.id))) continue
    try {
      const credential = await openChannel(deps.db, deps.credentialsKey, channel.id)
      if (credential === undefined || credential.status !== 'active') continue
      await catchUpChannel(
        deps,
        channel,
        runtime.apiFor({ appId: credential.appId, appSecret: credential.appSecret }),
        now,
      )
    } catch (error) {
      await noteChannelHealth(deps.db, channel.id, { error: messageOf(error) }).catch(() => undefined)
    }
  }
}

/**
 * 按凭证缓存 API：每 30 秒重建一个飞书客户端太浪费，凭证没换就复用。
 * 换了 app secret（例如泄露后重置）自然换成新客户端。
 */
export function cachedFeishuApis(factory: FeishuApiFactory = createFeishuApi): FeishuApiFactory {
  const cache = new Map<string, { key: string; api: FeishuApi }>()
  return (credential) => {
    const key = `${credential.appId}\u0000${credential.appSecret}`
    const hit = cache.get(credential.appId)
    if (hit !== undefined && hit.key === key) return hit.api
    const api = factory(credential)
    cache.set(credential.appId, { key, api })
    return api
  }
}

/** 定时补漏；启动后先等渠道连上，再按间隔跑。 */
export function startCatchupLoop(
  deps: IntakeDeps,
  channels: Channels,
  intervalMs = CATCHUP_INTERVAL_MS,
): () => void {
  let stopped = false
  let running = false
  const runtime: CatchupRuntime = {
    apiFor: cachedFeishuApis(),
    isLive: (channelId) => channels.live(channelId),
  }
  const tick = (): void => {
    if (stopped || running) return
    running = true
    void catchUpAll(deps, runtime)
      .catch((error: unknown) => console.error('superagent catchup', error))
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(tick, 5_000)
  initial.unref()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(timer)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}