/**
 * 渠道中立契约：事件怎么进来、回信怎么出去。
 *
 * 飞书是常驻长连接实现，GitHub 是 webhook + installation token 实现；两者只在
 * 这一层定义形状，{@link intake}、回信队列、工单执行都不认识具体渠道。
 *
 * 一条入站消息被拆成三样东西：
 * - `conversation`：会话（飞书群 / GitHub 仓库），绑定按它找；
 * - `thread`：会话里的话题（飞书根消息 / GitHub issue 号），同一话题只允许一张进行中的工单；
 * - `messageId`：渠道消息唯一 id，重投靠它去重。
 *
 * @module platform/modules/superagent/channel
 */

export type ChannelProvider = 'feishu' | 'github'

/** 连接器需要的一条已解密的渠道；密钥只在这一层出现。 */
export interface ChannelCredential {
  id: string
  userId: string
  provider: ChannelProvider
  appId: string
  appSecret: string
  status: string
}

/** 一条已归属成员、已归一形状的渠道消息。 */
export interface InboundEvent {
  provider: ChannelProvider
  /** 会话：飞书 chat_id / GitHub owner/repo。 */
  conversation: string
  /** 会话里的话题：飞书根消息 id / GitHub issue 或 PR 编号。 */
  thread: string
  /** 渠道消息唯一 id；同一渠道内去重。 */
  messageId: string
  senderId: string
  senderName: string
  text: string
  /** 明确是对它说的（@机器人、私聊、GitHub 的 @bot / assignee…）。 */
  addressed: boolean
  /** 单聊：回信不进话题；GitHub 恒为 false。 */
  direct: boolean
  at: string
}

/** 回信目标：会话 + 话题；`inThread` 为 false 时发到会话本身。 */
export interface ReplyTarget {
  conversation: string
  thread?: string
  inThread: boolean
}

/** 渠道级状态回调；渠道页据此显示「已连接 / 出错」。 */
export interface ChannelHealth {
  /** 出错原因；不传表示连接健康。 */
  error?: string
  /** 刚收到事件，顺带刷新 `last_event_at`。 */
  event?: boolean
}

/** 一条渠道的归属身份，够 intake 用，不带密钥。 */
export interface ChannelHandle {
  id: string
  userId: string
  provider: ChannelProvider
}

export interface ChannelEntry {
  channel: ChannelHandle
  credential: ChannelCredential
}

/** 适配器拿到的公共能力：事件进 intake，健康状态写回渠道。 */
export interface AdapterContext {
  onEvent(channel: ChannelHandle, event: InboundEvent): Promise<void>
  onHealth(channelId: string, health: ChannelHealth): void
}

/** `gone` 表示目标已永久消失（消息被删、issue 被锁），重试没有意义。 */
export type SendResult = 'sent' | 'gone' | 'offline'

/**
 * 一个渠道实现。
 *
 * `sync` 负责让运行态和数据库对齐；没有常驻连接的渠道（GitHub）什么都不用做。
 * 回信只在 `live` 为真时尝试，否则调用方把消息留在队列里等渠道恢复。
 */
export interface ChannelAdapter {
  readonly provider: ChannelProvider
  sync(entries: ChannelEntry[], ctx: AdapterContext): Promise<void>
  live(channelId: string): boolean
  reply(channelId: string, target: ReplyTarget, text: string, key: string): Promise<SendResult>
  /** 收到点名消息先确认（飞书贴表情）；失败不影响后续流程。 */
  acknowledge?(channelId: string, event: InboundEvent): Promise<void>
  stop(): void
}