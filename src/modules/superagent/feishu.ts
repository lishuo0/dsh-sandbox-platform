/**
 * 飞书长连接接入。
 *
 * 每个渠道用自己的 app_id / app_secret 起一条 WebSocket，收 `im.message.receive_v1`；
 * 回信走同一个 app 的 OpenAPI，按消息 id 回复到话题里。
 *
 * 这一层只做「事件 → 统一形状」和「文本 → 发出去」，不认识工单、不碰数据库；
 * 平台的其他部分通过 {@link FeishuPort} 拿到它，测试里换成假实现即可。
 *
 * @module platform/modules/superagent/feishu
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelEntry,
  ChannelHealth,
  InboundEvent,
  ReplyTarget,
  SendResult,
} from './channel.js'

/** 收到的一条飞书消息，字段已经按平台需要的形状归一。 */
export interface FeishuEvent {
  chatId: string
  /** 单聊为 true；群聊为 false。 */
  direct: boolean
  messageId: string
  /** 所在话题的根消息；顶层消息没有。 */
  rootId?: string
  parentId?: string
  senderId: string
  senderName: string
  text: string
  /** 是否点名了机器人（@ 或在单聊里）。 */
  mentioned: boolean
  at: string
}

export interface FeishuHooks {
  onEvent(event: FeishuEvent): Promise<void>
  onHealth(health: ChannelHealth): void
}

/** 一条渠道的长连接 + 发信能力。 */
export interface FeishuPort {
  start(): Promise<void>
  stop(): void
  /**
   * 回复到 `messageId` 所在的话题；`uuid` 让飞书不会重复发送同一条。
   * 单聊不支持话题（`thread: false`）。
   */
  reply(messageId: string, text: string, uuid: string, options?: { thread?: boolean }): Promise<void>
  /**
   * 给消息贴一个表情回复。收到活的第一时间用，让成员知道「看到了」，
   * 不用干等模型判断。失败只当没贴上，不影响后续流程。
   */
  react(messageId: string, emoji: string): Promise<void>
}

export interface FeishuCredential {
  appId: string
  appSecret: string
}

/** 自建应用 id 的形状；不合法时 SDK 会静默不连，必须提前拦住。 */
export function validAppId(appId: string): boolean {
  return /^cli_[0-9a-fA-F]{16}$/.test(appId)
}

/** 机器人所在的群，给「集成」页选绑定用。 */
export interface FeishuChat {
  id: string
  name: string
  /** group / topic；单聊不在列表接口里。 */
  mode: string
}

interface ChatListResponse {
  code?: number
  msg?: string
  data?: {
    items?: Array<{ chat_id?: string; name?: string; chat_mode?: string }>
    has_more?: boolean
    page_token?: string
  }
}

/**
 * 翻页拉完机器人所在的群。
 *
 * 需要应用开通 `im:chat:readonly`；没权限时飞书回业务错误，原样抛给调用方，
 * 页面据此提示成员去开放平台补权限。
 */
export async function fetchChatPages(
  request: (params: Record<string, unknown>) => Promise<ChatListResponse>,
): Promise<FeishuChat[]> {
  const chats: FeishuChat[] = []
  let pageToken = ''
  // 防御性上限：群多到 2000 个也不该在页面上卡死。
  for (let page = 0; page < 20; page += 1) {
    const response = await request({ page_size: 100, ...(pageToken === '' ? {} : { page_token: pageToken }) })
    if (response.code !== undefined && response.code !== 0) {
      throw new FeishuError(response.code, response.msg ?? 'feishu error')
    }
    for (const item of response.data?.items ?? []) {
      const id = typeof item.chat_id === 'string' ? item.chat_id : ''
      if (id === '') continue
      chats.push({
        id,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : id,
        mode: typeof item.chat_mode === 'string' ? item.chat_mode : '',
      })
    }
    const next = response.data?.page_token
    if (response.data?.has_more !== true || typeof next !== 'string' || next === '') break
    pageToken = next
  }
  return chats
}

/** 用渠道自己的凭证拉群列表。凭证失效 / 缺权限时抛错，由路由转成可读提示。 */
export async function listFeishuChats(credential: FeishuCredential): Promise<FeishuChat[]> {
  if (!validAppId(credential.appId)) {
    throw new Error(`飞书应用 id 不合法：${credential.appId}`)
  }
  const client = new Lark.Client({
    appId: credential.appId,
    appSecret: credential.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  })
  return fetchChatPages(
    (params) =>
      client.request({
        method: 'GET',
        url: '/open-apis/im/v1/chats',
        params,
      }) as Promise<ChatListResponse>,
  )
}

/** 飞书消息体 → 纯文本；文本与富文本取正文，其它类型（图片、文件）没有可判断的内容。 */
export function messageText(type: string, content: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return typeof content === 'string' && content.trim() !== '' ? content : undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  // 富文本：{title, content: [[{tag:'text', text}, ...], ...]}
  if (!Array.isArray(record.content)) return undefined
  const lines = record.content.map((block) =>
    Array.isArray(block)
      ? block
          .map((node) => (isTextNode(node) ? node.text : ''))
          .join('')
      : '',
  )
  const title = typeof record.title === 'string' ? record.title : ''
  const text = [title, ...lines].filter((line) => line.trim() !== '').join('\n')
  return text === '' ? undefined : text
}

function isTextNode(node: unknown): node is { tag: 'text'; text: string } {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as { tag?: unknown }).tag === 'text' &&
    typeof (node as { text?: unknown }).text === 'string'
  )
}

/** 把事件里的 @_user_1 这类占位换成「@名字」，模型和成员看到的都一样。 */
export function withMentionNames(text: string, mentions: ReadonlyArray<{ key: string; name: string }>): string {
  return mentions.reduce((result, mention) => result.replaceAll(mention.key, `@${mention.name}`), text)
}

/** 从事件里挑出平台需要的字段；不认识的形状一律当作没收到。 */
export function parseEvent(data: unknown, botOpenId: string | undefined): FeishuEvent | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const raw = data as {
    sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string }
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      create_time?: string
      root_id?: string
      parent_id?: string
      mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string; user_id?: string; union_id?: string } }>
    }
  }
  const sender = raw.sender
  const message = raw.message
  if (sender === undefined || message === undefined) return undefined
  // 机器人（含自己）发的消息不再触发，否则会自己跟自己聊。
  if (sender.sender_type !== 'user') return undefined
  if (!message.message_id || !message.chat_id) return undefined
  const text = messageText(message.message_type ?? '', message.content ?? '')
  if (text === undefined) return undefined

  const mentions = (message.mentions ?? []).flatMap((mention) =>
    typeof mention.key === 'string' && typeof mention.name === 'string'
      ? [{ key: mention.key, name: mention.name, ids: mention.id ?? {} }]
      : [],
  )
  const direct = message.chat_type === 'p2p'
  const mentioned =
    botOpenId === undefined
      ? mentions.length > 0
      : mentions.some((mention) =>
          [mention.ids.open_id, mention.ids.user_id, mention.ids.union_id].includes(botOpenId),
        )
  const time = message.create_time === undefined ? Date.now() : Number(message.create_time) || Date.parse(message.create_time)
  return {
    chatId: message.chat_id,
    direct,
    messageId: message.message_id,
    ...(message.root_id ? { rootId: message.root_id } : {}),
    ...(message.parent_id ? { parentId: message.parent_id } : {}),
    senderId: sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '',
    senderName: '',
    text: withMentionNames(text, mentions),
    mentioned: direct || mentioned,
    at: new Date(Number.isFinite(time) ? time : Date.now()).toISOString(),
  }
}

/** 会话历史接口返回的一条消息；和事件里的 `message` 同义，只是字段位置不同。 */
export interface FeishuMessageRecord {
  message_id?: string
  chat_id?: string
  msg_type?: string
  create_time?: string
  deleted?: boolean
  root_id?: string
  parent_id?: string
  sender?: {
    /** 历史接口用 `id`；事件里是 `sender_id.open_id`，两种都认。 */
    id?: string
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type?: string
  }
  body?: { content?: string }
  mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string; user_id?: string; union_id?: string } }>
}

/**
 * 历史消息 → 统一事件。
 *
 * 历史接口不返回 `chat_type`，单聊与否由调用方查会话信息后传入；
 * 机器人自己发的、已删除的、没有文本的都不进平台。
 */
export function parseMessageRecord(
  record: FeishuMessageRecord,
  options: { chatId: string; direct: boolean; botOpenId?: string },
): FeishuEvent | undefined {
  if (record.deleted === true) return undefined
  if (record.sender?.sender_type !== 'user') return undefined
  if (!record.message_id) return undefined
  const chatId = record.chat_id ?? options.chatId
  if (chatId === '') return undefined
  const text = messageText(record.msg_type ?? '', record.body?.content ?? '')
  if (text === undefined) return undefined

  const mentions = (record.mentions ?? []).flatMap((mention) =>
    typeof mention.key === 'string' && typeof mention.name === 'string'
      ? [{ key: mention.key, name: mention.name, ids: mention.id ?? {} }]
      : [],
  )
  const botOpenId = options.botOpenId
  const mentioned =
    botOpenId === undefined
      ? mentions.length > 0
      : mentions.some((mention) =>
          [mention.ids.open_id, mention.ids.user_id, mention.ids.union_id].includes(botOpenId),
        )
  const sender = record.sender
  const time = record.create_time === undefined ? Date.now() : Number(record.create_time) || Date.parse(record.create_time)
  return {
    chatId,
    direct: options.direct,
    messageId: record.message_id,
    ...(record.root_id ? { rootId: record.root_id } : {}),
    ...(record.parent_id ? { parentId: record.parent_id } : {}),
    senderId: sender?.id ?? sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '',
    senderName: '',
    text: withMentionNames(text, mentions),
    mentioned: options.direct || mentioned,
    at: new Date(Number.isFinite(time) ? time : Date.now()).toISOString(),
  }
}

interface MessageListResponse {
  code?: number
  msg?: string
  data?: {
    items?: FeishuMessageRecord[]
    has_more?: boolean
    page_token?: string
  }
}

interface ChatInfoResponse {
  code?: number
  msg?: string
  data?: { chat_mode?: string }
}

/** 补漏用的飞书读写面；和长连接解耦，测试里换成假实现。 */
export interface FeishuApi {
  /** 机器人自己的 open_id，用来判断有没有被 @；拿不到时退化为「有 @ 就算」。 */
  botOpenId(): Promise<string | undefined>
  /** 按时间区间拉会话历史，升序返回。 */
  listMessages(chatId: string, window: { startAt: string; endAt?: string }): Promise<FeishuMessageRecord[]>
  /** 会话是不是单聊；拿不到返回 undefined，由调用方按绑定信息兜底。 */
  isDirectChat(chatId: string): Promise<boolean | undefined>
}

/**
 * 真实的历史消息读取实现。
 *
 * 需要应用开通 `im:message:readonly`（单聊还要能读自己的会话）；
 * 缺权限时飞书回业务错误，由调用方记录到渠道健康状态里。
 */
export function createFeishuApi(credential: FeishuCredential): FeishuApi {
  if (!validAppId(credential.appId)) {
    throw new Error(`飞书应用 id 不合法：${credential.appId}`)
  }
  const client = new Lark.Client({
    appId: credential.appId,
    appSecret: credential.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  })
  let botOpenId: string | undefined
  let botLoaded = false
  const directChats = new Map<string, boolean>()

  async function identify(): Promise<string | undefined> {
    if (botLoaded) return botOpenId
    botLoaded = true
    try {
      const info = (await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })) as { code?: number; bot?: { open_id?: string } }
      if (typeof info?.bot?.open_id === 'string') botOpenId = info.bot.open_id
    } catch {
      // 认不出自己不阻断补漏；群里的 @ 判断退化为「有 @ 就算点名」。
    }
    return botOpenId
  }

  return {
    botOpenId: identify,

    async listMessages(chatId, window) {
      const start = Math.floor((Date.parse(window.startAt) || Date.now()) / 1000)
      const end = window.endAt === undefined ? undefined : Math.floor((Date.parse(window.endAt) || Date.now()) / 1000)
      const items: FeishuMessageRecord[] = []
      let pageToken = ''
      // 防御性上限：一次补漏最多翻 10 页（50 条/页），不会把页面拖死。
      for (let page = 0; page < 10; page += 1) {
        const response = (await client.request({
          method: 'GET',
          url: '/open-apis/im/v1/messages',
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            start_time: String(start),
            ...(end === undefined ? {} : { end_time: String(end) }),
            sort_type: 'ByCreateTimeAsc',
            page_size: 50,
            ...(pageToken === '' ? {} : { page_token: pageToken }),
          },
        })) as MessageListResponse
        if (response.code !== undefined && response.code !== 0) {
          throw new FeishuError(response.code, response.msg ?? 'feishu error')
        }
        items.push(...(response.data?.items ?? []))
        const next = response.data?.page_token
        if (response.data?.has_more !== true || typeof next !== 'string' || next === '') break
        pageToken = next
      }
      return items
    },

    async isDirectChat(chatId) {
      const cached = directChats.get(chatId)
      if (cached !== undefined) return cached
      try {
        const response = (await client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        })) as ChatInfoResponse
        if (response.code !== undefined && response.code !== 0) return undefined
        const direct = response.data?.chat_mode === 'p2p'
        directChats.set(chatId, direct)
        return direct
      } catch {
        return undefined
      }
    },
  }
}

/** 飞书 OpenAPI 的业务错误（HTTP 200 但 `code !== 0`）。 */
export class FeishuError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 真实的长连接实现。
 *
 * 连接断开由 SDK 自己重连；这里只在首次连上、报错、收到事件时把状态交给上层。
 * 机器人自己的 open_id 用来判断消息有没有点名它——拿不到时退化为「有 @ 就算点名」。
 */
export function createFeishuPort(credential: FeishuCredential, hooks: FeishuHooks): FeishuPort {
  if (!validAppId(credential.appId)) {
    throw new Error(`飞书应用 id 不合法：${credential.appId}`)
  }
  let botOpenId: string | undefined
  let running = false
  const client = new Lark.Client({
    appId: credential.appId,
    appSecret: credential.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  })
  const socket = new Lark.WSClient({
    appId: credential.appId,
    appSecret: credential.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
    onReady: () => hooks.onHealth({ event: true }),
    onError: (error: Error) => hooks.onHealth({ error: describe(error) }),
  })

  async function identify(): Promise<void> {
    try {
      const info = (await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })) as { code?: number; bot?: { open_id?: string } }
      if (typeof info?.bot?.open_id === 'string') botOpenId = info.bot.open_id
    } catch (error) {
      // 认不出自己不影响收消息，只是「有没有 @ 我」的判断退化为「有没有 @」。
      hooks.onHealth({ error: describe(error) })
    }
  }

  return {
    async start() {
      await identify()
      const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.warn }).register({
        'im.message.receive_v1': async (data: unknown) => {
          const event = parseEvent(data, botOpenId)
          if (event === undefined) return
          hooks.onHealth({ event: true })
          await hooks.onEvent(event)
        },
      })
      await socket.start({ eventDispatcher: dispatcher })
      running = true
    },

    stop() {
      if (!running) return
      running = false
      socket.close({ force: true })
    },

    async react(messageId: string, emoji: string) {
      const response = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw new FeishuError(response.code, response.msg ?? 'feishu error')
      }
    },

    async reply(messageId: string, text: string, uuid: string, options?: { thread?: boolean }) {
      const response = await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
          // 话题只在群里用；单聊里飞书不认这个话题参数。
          reply_in_thread: options?.thread !== false,
          // 同一条回信重试时飞书按 uuid 去重，群里不会出现两条。
          uuid,
        },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw new FeishuError(response.code, response.msg ?? 'feishu error')
      }
    },
  }
}

/** 飞书事件 → 渠道中立事件：会话是群，话题是根消息（顶层消息自成一话题）。 */
export function feishuInbound(event: FeishuEvent): InboundEvent {
  return {
    provider: 'feishu',
    conversation: event.chatId,
    thread: event.rootId ?? event.messageId,
    messageId: event.messageId,
    senderId: event.senderId,
    senderName: event.senderName,
    text: event.text,
    addressed: event.mentioned,
    direct: event.direct,
    at: event.at,
  }
}

/** 建连线的方式；测试换成假的，不碰网络。 */
export type PortFactory = (credential: FeishuCredential, hooks: FeishuHooks) => FeishuPort

/** 收到消息先贴的表情：👍 表示「看到了，正在处理」。 */
const ACK_EMOJI = 'THUMBSUP'

/**
 * 飞书渠道实现：每个渠道维持一条长连接，回信走同一个 app 的 OpenAPI。
 *
 * 这是「常驻连接型」适配器的样板；GitHub 那种 webhook 型适配器没有 `sync` 里的连接动作，
 * 只实现回信和在线判断。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly provider = 'feishu' as const
  private readonly running = new Map<string, FeishuPort>()

  constructor(private readonly makePort: PortFactory = createFeishuPort) {}

  async sync(entries: ChannelEntry[], ctx: AdapterContext): Promise<void> {
    const wanted = new Set(entries.map((entry) => entry.channel.id))
    for (const [id, port] of this.running) {
      if (wanted.has(id)) continue
      port.stop()
      this.running.delete(id)
    }
    for (const { channel, credential } of entries) {
      if (this.running.has(channel.id)) continue
      const hooks: FeishuHooks = {
        onHealth: (health) => ctx.onHealth(channel.id, health),
        onEvent: async (event) => {
          ctx.onHealth(channel.id, { event: true })
          await ctx.onEvent(channel, feishuInbound(event))
        },
      }
      const port = this.makePort({ appId: credential.appId, appSecret: credential.appSecret }, hooks)
      try {
        await port.start()
        this.running.set(channel.id, port)
        // 连上了就把上一轮的错误清掉。
        ctx.onHealth(channel.id, { event: false })
      } catch (error) {
        ctx.onHealth(channel.id, { error: describe(error) })
      }
    }
  }

  live(channelId: string): boolean {
    return this.running.has(channelId)
  }

  async reply(channelId: string, target: ReplyTarget, text: string, key: string): Promise<SendResult> {
    const port = this.running.get(channelId)
    if (port === undefined) return 'offline'
    if (target.thread === undefined) throw new Error('missing-thread-root')
    await port.reply(target.thread, text, key, { thread: target.inThread })
    return 'sent'
  }

  async acknowledge(channelId: string, event: InboundEvent): Promise<void> {
    await this.running.get(channelId)?.react(event.messageId, ACK_EMOJI)
  }

  stop(): void {
    for (const port of this.running.values()) port.stop()
    this.running.clear()
  }
}

/** 取一层可读的原因；SDK 的错误里往往是 `{code,msg}` 的 JSON。 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const { code, msg, message } = error as { code?: unknown; msg?: unknown; message?: unknown }
    if (typeof code === 'number' && typeof msg === 'string') return `${code}: ${msg}`
    if (typeof message === 'string') return message
  }
  return String(error)
}
