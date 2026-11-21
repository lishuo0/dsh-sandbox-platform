/**
 * 渠道运行态：按 provider 把主动渠道分给各自的适配器。
 *
 * 飞书要维持长连接，GitHub 只需要 webhook（没有常驻运行态）；这一层不关心细节，
 * 只负责「从数据库读出主动渠道 → 解密 → 交给适配器」，以及把回信路由回去。
 *
 * 平台副本可能有多个，但长连接只该连一份：这里不做跨副本协调，
 * 由部署只让一个副本跑 `startSuperagent`（和定时任务循环同一个进程）。
 *
 * @module platform/modules/superagent/connector
 */

import { hostname } from 'node:os'
import type { Deps } from '../../app/deps.js'
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelEntry,
  ChannelHealth,
  ChannelProvider,
  InboundEvent,
  ReplyTarget,
  SendResult,
} from './channel.js'
import { FeishuAdapter, type PortFactory } from './feishu.js'
import { intake, intakeDefaults, type IntakeDeps } from './intake.js'
import { activeChannels, channelProvider, noteChannelHealth, openChannel } from './store.js'

/** 没注册适配器的渠道（例如 GitHub 还在接）不发信，回信留在队列里。 */
const NO_ADAPTER: SendResult = 'offline'

export class Channels {
  private readonly adapters = new Map<ChannelProvider, ChannelAdapter>()
  private readonly providers = new Map<string, ChannelProvider>()
  private syncing: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: Deps,
    adapters: ChannelAdapter[] = [new FeishuAdapter()],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter)
  }

  /**
   * 让运行中的连接和数据库里的主动渠道对齐：
   * 新渠道起连接，删掉 / 停用的渠道断连接。可重复调用。
   */
  sync(): Promise<void> {
    // 串行化，避免两次 sync 同时给同一条渠道起连接。
    this.syncing = this.syncing.then(() => this.align())
    return this.syncing
  }

  private async align(): Promise<void> {
    const active = await activeChannels(this.deps.db)
    const wanted = new Set(active.map((channel) => channel.id))
    for (const id of [...this.providers.keys()]) {
      if (!wanted.has(id)) this.providers.delete(id)
    }

    const grouped = new Map<ChannelProvider, ChannelEntry[]>()
    for (const channel of active) {
      this.providers.set(channel.id, channel.provider)
      const adapter = this.adapters.get(channel.provider)
      if (adapter === undefined) continue
      const credential = await openChannel(this.deps.db, this.deps.credentialsKey, channel.id)
      if (credential === undefined || credential.status !== 'active') continue
      const entries = grouped.get(channel.provider) ?? []
      entries.push({ channel: { id: channel.id, userId: channel.userId, provider: channel.provider }, credential })
      grouped.set(channel.provider, entries)
    }

    const ctx = this.context()
    for (const [provider, adapter] of this.adapters) {
      await adapter.sync(grouped.get(provider) ?? [], ctx)
    }
  }

  /** 适配器事件 / 健康状态统一收口：单条消息出错不能拖垮连接。 */
  private context(): AdapterContext {
    const deps = this.deps
    const intakeDeps: IntakeDeps = {
      db: deps.db,
      credentialsKey: deps.credentialsKey,
      brain: deps.brain,
      superagentDefaults: intakeDefaults(deps.config?.superagent),
      // 表情是锦上添花：贴不上（没权限、消息撤回）也只当没贴。
      acknowledge: async (channel, event) => {
        const adapter = this.adapterFor(channel.provider)
        if (adapter?.acknowledge === undefined) return
        await adapter.acknowledge(channel.id, event).catch(() => undefined)
      },
    }
    return {
      onHealth: (channelId: string, health: ChannelHealth) => {
        void noteChannelHealth(deps.db, channelId, health).catch(() => undefined)
      },
      onEvent: async (channel, event: InboundEvent) => {
        try {
          await intake(intakeDeps, channel, event)
        } catch (error) {
          // 单条消息出错不能拖垮长连接；原因留在渠道上。
          await noteChannelHealth(deps.db, channel.id, { error: messageOf(error) }).catch(() => undefined)
        }
      },
    }
  }

  private adapterFor(provider: ChannelProvider): ChannelAdapter | undefined {
    return this.adapters.get(provider)
  }

  private async providerOf(channelId: string): Promise<ChannelProvider | undefined> {
    const known = this.providers.get(channelId)
    if (known !== undefined) return known
    // 还没 sync 到（例如刚建的渠道）时直接查一次，之后由 sync 缓存。
    const provider = await channelProvider(this.deps.db, channelId)
    if (provider !== undefined) this.providers.set(channelId, provider)
    return provider
  }

  /** 渠道现在能不能发信；不能时回信留在队列里等。 */
  async live(channelId: string): Promise<boolean> {
    const provider = await this.providerOf(channelId)
    if (provider === undefined) return false
    return this.adapterFor(provider)?.live(channelId) ?? false
  }

  /** 按渠道类型把一条回信交给对应适配器。 */
  async reply(channelId: string, target: ReplyTarget, text: string, key: string): Promise<SendResult> {
    const provider = await this.providerOf(channelId)
    if (provider === undefined) return NO_ADAPTER
    const adapter = this.adapterFor(provider)
    if (adapter === undefined) return NO_ADAPTER
    return adapter.reply(channelId, target, text, key)
  }

  stopAll(): void {
    for (const adapter of this.adapters.values()) adapter.stop()
    this.providers.clear()
  }
}

/** 进程内唯一的渠道表；路由改完渠道后调用 `syncChannels()` 让它重新对齐。 */
let current: Channels | undefined

export function startChannels(deps: Deps, ports?: PortFactory): Channels {
  const channels = ports === undefined ? new Channels(deps) : new Channels(deps, [new FeishuAdapter(ports)])
  current = channels
  void channels.sync().catch((error: unknown) => {
    console.error('superagent', messageOf(error))
  })
  return channels
}

/** 路由 / 启动流程里加了或停了渠道之后，异步让连接跟上。 */
export function syncChannels(): void {
  void current?.sync().catch((error: unknown) => {
    console.error('superagent', messageOf(error))
  })
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 副本标识，和定时任务循环同一形状。 */
export function replicaOwner(): string {
  return `${hostname()}:${process.pid}`
}