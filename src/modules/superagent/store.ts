/**
 * 工单自动化的仓储层。
 *
 * 所有读写都按成员过滤：渠道、绑定、工单、执行、回信都属于创建它的成员，
 * 没有跨成员可见的全局状态。唯一不带 `user_id` 条件的是录入路径上的
 * 「按渠道找绑定」——渠道本身就是某个成员的，找到之后一律带上它的 `user_id`。
 *
 * 时间、布尔、JSON 三种值按方言归一（见 `kernel/row.ts`）；`$1` 占位与
 * `now()` 由 SQLite 适配层翻译，服务层只写一套 SQL。
 *
 * @module platform/modules/superagent/store
 */

import { randomUUID } from 'node:crypto'
import type { Db, Querier } from '../../kernel/db.js'
import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import { asBool, asBuffer, asJson, asStringArray } from '../../kernel/row.js'
import { open, seal } from '../../kernel/seal.js'
import type { ChannelCredential, ChannelProvider } from './channel.js'

export type { ChannelCredential, ChannelProvider }
export type TicketStage = 'accepted' | 'working' | 'review' | 'done' | 'failed' | 'stopped'
export type MessageStatus = 'pending' | 'accepted' | 'ignored' | 'skipped' | 'failed'

/** 生成一个带前缀的 id；各表共用，前缀只为人读日志方便。 */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

/** 时间列在两种方言下的统一形状。 */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : ''
}

/**
 * 进 jsonb 列的值统一序列化。
 * 不交给驱动：PostgreSQL 会把 JS 数组写成 `{...}` 数组字面量，jsonb 读不进来。
 */
function jsonColumn(value: unknown): string {
  return JSON.stringify(value)
}

// ---------------------------------------------------------------- 渠道

/** 成员看到的渠道；密钥永远不出这一层。 */
export interface ChannelView {
  id: string
  provider: ChannelProvider
  name: string
  appId: string
  /** 新建绑定时继承的默认接活规则（一句一条）；单个绑定仍可覆盖。 */
  defaultRules: string[]
  status: string
  lastError?: string
  lastEventAt?: string
  createdAt: string
}

function channelView(row: Record<string, unknown>): ChannelView {
  return {
    id: String(row.id),
    provider: String(row.provider) as ChannelProvider,
    name: String(row.name ?? ''),
    appId: String(row.app_id),
    defaultRules: asStringArray(row.default_rules ?? []),
    status: String(row.status ?? 'active'),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.last_event_at ? { lastEventAt: iso(row.last_event_at) } : {}),
    createdAt: iso(row.created_at),
  }
}

/** 列出成员自己的渠道。 */
export async function listChannels(db: Querier, userId: string): Promise<ChannelView[]> {
  const rows = await db.query(
    `SELECT id, provider, name, app_id, default_rules, status, last_error, last_event_at, created_at
       FROM dsh_superagent_channels
      WHERE user_id = $1
      ORDER BY created_at`,
    [userId],
  )
  return rows.rows.map(channelView)
}

/** 新增一条渠道；app secret 只以密文落库。 */
export async function createChannel(
  db: Querier,
  key: Buffer,
  userId: string,
  input: {
    provider: ChannelProvider
    name?: string
    appId: string
    appSecret: string
    defaultRules?: string[]
  },
): Promise<ChannelView> {
  const id = newId('sa_ch')
  try {
    await db.query(
      `INSERT INTO dsh_superagent_channels
         (id, user_id, provider, name, app_id, secret_ciphertext, default_rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        userId,
        input.provider,
        input.name ?? '',
        input.appId,
        seal(key, input.appSecret),
        jsonColumn(input.defaultRules ?? []),
      ],
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'channel-exists')
    throw error
  }
  return (await channelById(db, userId, id)) as ChannelView
}

/** 读一条成员自己的渠道。 */
export async function channelById(db: Querier, userId: string, channelId: string): Promise<ChannelView | undefined> {
  const rows = await db.query(
    `SELECT id, provider, name, app_id, default_rules, status, last_error, last_event_at, created_at
       FROM dsh_superagent_channels
      WHERE user_id = $1 AND id = $2`,
    [userId, channelId],
  )
  return rows.rows[0] === undefined ? undefined : channelView(rows.rows[0])
}

/** 改渠道；`appSecret` 省略表示不改，`undefined` 的其它字段同样不动。 */
export async function updateChannel(
  db: Querier,
  key: Buffer,
  userId: string,
  channelId: string,
  patch: {
    name?: string
    appSecret?: string
    status?: 'active' | 'disabled'
    defaultRules?: string[]
  },
): Promise<ChannelView> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.defaultRules !== undefined) {
    params.push(jsonColumn(patch.defaultRules))
    sets.push(`default_rules = $${params.length}`)
  }
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.appSecret !== undefined) {
    params.push(seal(key, patch.appSecret))
    sets.push(`secret_ciphertext = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
  }
  if (sets.length > 0) {
    params.push(userId, channelId)
    await db.query(
      `UPDATE dsh_superagent_channels
          SET ${sets.join(', ')}, updated_at = now()
        WHERE user_id = $${params.length - 1} AND id = $${params.length}`,
      params,
    )
  }
  const found = await channelById(db, userId, channelId)
  if (found === undefined) throw new HttpError(404, 'channel-not-found')
  return found
}

/** 删渠道；绑定、工单、回信随外键一起走。 */
export async function deleteChannel(db: Querier, userId: string, channelId: string): Promise<void> {
  const result = await db.query(`DELETE FROM dsh_superagent_channels WHERE user_id = $1 AND id = $2`, [userId, channelId])
  if (result.rowCount === 0) throw new HttpError(404, 'channel-not-found')
}

/** 连接器启动时读当前用户的渠道（含解密的 app secret）。 */
export async function openChannel(db: Querier, key: Buffer, channelId: string): Promise<ChannelCredential | undefined> {
  const rows = await db.query(
    `SELECT id, user_id, provider, app_id, secret_ciphertext, status
       FROM dsh_superagent_channels
      WHERE id = $1`,
    [channelId],
  )
  const row = rows.rows[0]
  if (row === undefined) return undefined
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider) as ChannelProvider,
    appId: String(row.app_id),
    appSecret: open(key, asBuffer(row.secret_ciphertext)),
    status: String(row.status ?? 'active'),
  }
}

/** 一条渠道的类型；回信只拿到 channelId 时用它找对应的适配器。 */
export async function channelProvider(db: Querier, channelId: string): Promise<ChannelProvider | undefined> {
  const rows = await db.query(`SELECT provider FROM dsh_superagent_channels WHERE id = $1`, [channelId])
  return rows.rows[0] === undefined ? undefined : (String(rows.rows[0].provider) as ChannelProvider)
}

/** 全部主动渠道，连接器按 provider 分给各自的适配器。 */
export async function activeChannels(db: Querier): Promise<Array<{ id: string; userId: string; provider: ChannelProvider }>> {
  const rows = await db.query(
    `SELECT id, user_id, provider FROM dsh_superagent_channels WHERE status = 'active' ORDER BY created_at`,
  )
  return rows.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider) as ChannelProvider,
  }))
}

/** 记录连接状态；失败原因留在库里给「集成」页看。 */
export async function noteChannelHealth(
  db: Querier,
  channelId: string,
  health: { error?: string | undefined; event?: boolean },
): Promise<void> {
  if (health.error !== undefined) {
    await db.query(`UPDATE dsh_superagent_channels SET last_error = $1, updated_at = now() WHERE id = $2`, [
      health.error,
      channelId,
    ])
    return
  }
  await db.query(
    `UPDATE dsh_superagent_channels
        SET last_error = NULL, last_event_at = CASE WHEN $1 THEN now() ELSE last_event_at END, updated_at = now()
      WHERE id = $2`,
    [health.event === true, channelId],
  )
}

// ---------------------------------------------------------------- 绑定

export interface BindingView {
  id: string
  userId: string
  channelId: string
  provider: ChannelProvider
  channelName: string
  workspaceId: string
  workspaceName: string
  externalChatId: string
  chatName: string
  policy: Record<string, unknown>
  policyVersion: number
  status: string
  createdAt: string
}

const BINDING_SELECT = `SELECT b.id, b.user_id, b.channel_id, c.provider, c.name AS channel_name,
          b.workspace_id, w.name AS workspace_name, b.external_chat_id, b.chat_name,
          b.policy, b.policy_version, b.status, b.created_at
     FROM dsh_superagent_bindings b
     JOIN dsh_superagent_channels c ON c.id = b.channel_id
     JOIN dsh_workspaces w ON w.id = b.workspace_id`

function bindingView(row: Record<string, unknown>): BindingView {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    channelId: String(row.channel_id),
    provider: String(row.provider) as ChannelProvider,
    channelName: String(row.channel_name ?? ''),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name ?? ''),
    externalChatId: String(row.external_chat_id),
    chatName: String(row.chat_name ?? ''),
    policy: asJson<Record<string, unknown>>(row.policy ?? '{}'),
    policyVersion: Number(row.policy_version ?? 1),
    status: String(row.status ?? 'active'),
    createdAt: iso(row.created_at),
  }
}

/** 列出成员自己的绑定。 */
export async function listBindings(db: Querier, userId: string): Promise<BindingView[]> {
  const rows = await db.query(`${BINDING_SELECT} WHERE b.user_id = $1 ORDER BY b.created_at DESC`, [userId])
  return rows.rows.map(bindingView)
}

/** 读一条成员自己的绑定。 */
export async function bindingById(db: Querier, userId: string, bindingId: string): Promise<BindingView | undefined> {
  const rows = await db.query(`${BINDING_SELECT} WHERE b.user_id = $1 AND b.id = $2`, [userId, bindingId])
  return rows.rows[0] === undefined ? undefined : bindingView(rows.rows[0])
}

/**
 * 把群绑到成员自己的一块工作区。
 *
 * 渠道和工作区都必须属于调用者——没有授权这一步，谁都能把别人的仓库接到自己群里。
 * 另一个成员已经在同一个群里绑了别的工作区不算冲突：各绑各的。
 */
export async function createBinding(
  db: Querier,
  userId: string,
  input: {
    channelId: string
    workspaceId: string
    externalChatId: string
    chatName?: string
    policy?: Record<string, unknown>
  },
): Promise<BindingView> {
  // 顺带完成归属检查：没配规则就继承机器人的默认规则。
  const channel = await channelDefaults(db, userId, input.channelId)
  if (channel === undefined) throw new HttpError(404, 'channel-not-found')
  if (!(await ownsWorkspace(db, userId, input.workspaceId))) throw new HttpError(404, 'workspace-not-found')
  const policy = { ...(input.policy ?? {}) }
  const rules = policy.rules
  if ((rules === undefined || (Array.isArray(rules) && rules.length === 0)) && channel.defaultRules.length > 0) {
    policy.rules = rulesFromInstructions(channel.defaultRules)
  }
  const id = newId('sa_bind')
  try {
    await db.query(
      `INSERT INTO dsh_superagent_bindings
         (id, user_id, channel_id, workspace_id, external_chat_id, chat_name, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        userId,
        input.channelId,
        input.workspaceId,
        input.externalChatId,
        input.chatName ?? '',
        jsonColumn(policy),
      ],
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'binding-exists')
    throw error
  }
  return (await bindingById(db, userId, id)) as BindingView
}

/** 改绑定；只允许改目标工作区、规则和启停。 */
export async function updateBinding(
  db: Querier,
  userId: string,
  bindingId: string,
  patch: {
    workspaceId?: string
    policy?: Record<string, unknown>
    chatName?: string
    status?: 'active' | 'paused'
  },
): Promise<BindingView> {
  if (patch.workspaceId !== undefined && !(await ownsWorkspace(db, userId, patch.workspaceId))) {
    throw new HttpError(404, 'workspace-not-found')
  }
  const sets: string[] = []
  const params: unknown[] = []
  const set = (column: string, value: unknown): void => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (patch.workspaceId !== undefined) set('workspace_id', patch.workspaceId)
  if (patch.chatName !== undefined) set('chat_name', patch.chatName)
  if (patch.status !== undefined) set('status', patch.status)
  if (patch.policy !== undefined) {
    // 清空规则等于「跟随机器人默认」：机器人配了默认规则就补回来，没配就交给部署兜底。
    let policy = patch.policy
    const rules = policy.rules
    if (Array.isArray(rules) && rules.length === 0) {
      const channel = await channelDefaultsForBinding(db, userId, bindingId)
      if (channel !== undefined && channel.defaultRules.length > 0) {
        policy = { ...policy, rules: rulesFromInstructions(channel.defaultRules) }
      }
    }
    set('policy', jsonColumn(policy))
    // 规则换了就要换版本号，进行中的工单按旧版本判断，历史可复现。
    sets.push('policy_version = policy_version + 1')
  }
  if (sets.length > 0) {
    params.push(userId, bindingId)
    await db.query(
      `UPDATE dsh_superagent_bindings
          SET ${sets.join(', ')}, updated_at = now()
        WHERE user_id = $${params.length - 1} AND id = $${params.length}`,
      params,
    )
  }
  const found = await bindingById(db, userId, bindingId)
  if (found === undefined) throw new HttpError(404, 'binding-not-found')
  return found
}

interface ChannelDefaults {
  defaultRules: string[]
}

function channelDefaultsOf(row: Record<string, unknown> | undefined): ChannelDefaults | undefined {
  if (row === undefined) return undefined
  return {
    defaultRules: asStringArray(row.default_rules ?? []),
  }
}

/** 成员是否拥有这条渠道，以及它的默认规则。 */
async function channelDefaults(
  db: Querier,
  userId: string,
  channelId: string,
): Promise<ChannelDefaults | undefined> {
  const rows = await db.query(
    `SELECT default_rules FROM dsh_superagent_channels WHERE id = $1 AND user_id = $2`,
    [channelId, userId],
  )
  return channelDefaultsOf(rows.rows[0])
}

/** 一条绑定所属机器人的默认规则。 */
async function channelDefaultsForBinding(
  db: Querier,
  userId: string,
  bindingId: string,
): Promise<ChannelDefaults | undefined> {
  const rows = await db.query(
    `SELECT c.default_rules
       FROM dsh_superagent_bindings b
       JOIN dsh_superagent_channels c ON c.id = b.channel_id
      WHERE b.user_id = $1 AND b.id = $2`,
    [userId, bindingId],
  )
  return channelDefaultsOf(rows.rows[0])
}

/** 把「一句一条」的机器人默认规则变成绑定里的规则对象。 */
function rulesFromInstructions(instructions: readonly string[]): Array<{ id: string; enabled: boolean; instruction: string }> {
  return instructions.map((instruction, index) => ({ id: `r${index + 1}`, enabled: true, instruction }))
}

/** 成员是否拥有这块工作区。 */
async function ownsWorkspace(db: Querier, userId: string, workspaceId: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [workspaceId, userId])
  return rows.rows.length > 0
}

/** 解绑。 */
export async function deleteBinding(db: Querier, userId: string, bindingId: string): Promise<void> {
  const result = await db.query(`DELETE FROM dsh_superagent_bindings WHERE user_id = $1 AND id = $2`, [
    userId,
    bindingId,
  ])
  if (result.rowCount === 0) throw new HttpError(404, 'binding-not-found')
}

/** 录入路径：这个群里有没有活着的绑定。 */
export async function bindingForChat(
  db: Querier,
  channelId: string,
  chatId: string,
): Promise<BindingView | undefined> {
  const rows = await db.query(
    `${BINDING_SELECT} WHERE b.channel_id = $1 AND b.external_chat_id = $2 AND b.status = 'active'`,
    [channelId, chatId],
  )
  return rows.rows[0] === undefined ? undefined : bindingView(rows.rows[0])
}

/** 一条渠道下所有活着的绑定；补漏轮询按它逐个会话拉历史。 */
export async function bindingsForChannel(db: Querier, channelId: string): Promise<BindingView[]> {
  const rows = await db.query(
    `${BINDING_SELECT} WHERE b.channel_id = $1 AND b.status = 'active' ORDER BY b.created_at`,
    [channelId],
  )
  return rows.rows.map(bindingView)
}

/** 私聊没绑定时的兜底工作区：成员设的默认工作区，没设就用最近活跃的一块。 */
export async function defaultWorkspaceId(db: Querier, userId: string): Promise<string | undefined> {
  const rows = await db.query(
    `SELECT id FROM dsh_workspaces
      WHERE user_id = $1 AND state = 'active'
      ORDER BY is_default DESC, last_active_at DESC
      LIMIT 1`,
    [userId],
  )
  return rows.rows[0] === undefined ? undefined : String(rows.rows[0].id)
}

// ---------------------------------------------------------------- 消息

/** 收到的一条消息，落库时已带上归属。 */
export interface InboundMessage {
  bindingId: string
  userId: string
  channelId: string
  externalChatId: string
  externalMessageId: string
  threadKey: string
  senderId: string
  senderName: string
  body: string
  addressed: boolean
}

/** 落一条入站消息；返回是否新消息（渠道重投时 `fresh` 为 false）。 */
export async function recordInbound(
  db: Querier,
  message: InboundMessage,
): Promise<{ id: string; fresh: boolean }> {
  const id = newId('sa_msg')
  const inserted = await db.query(
    `INSERT INTO dsh_superagent_messages
       (id, user_id, binding_id, channel_id, external_chat_id, external_message_id,
        thread_key, sender_id, sender_name, body, addressed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (channel_id, external_message_id) DO NOTHING
     RETURNING id`,
    [
      id,
      message.userId,
      message.bindingId,
      message.channelId,
      message.externalChatId,
      message.externalMessageId,
      message.threadKey,
      message.senderId,
      message.senderName,
      message.body,
      message.addressed,
    ],
  )
  const fresh = inserted.rows.length > 0
  if (fresh) return { id, fresh }
  const existing = await db.query(
    `SELECT id FROM dsh_superagent_messages WHERE channel_id = $1 AND external_message_id = $2`,
    [message.channelId, message.externalMessageId],
  )
  return { id: String(existing.rows[0]?.id ?? id), fresh: false }
}

/** 一条消息的评估结果与用工。 */
export interface MessageDecisionPatch {
  status: MessageStatus
  promptVersion?: string
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  decision?: unknown
  error?: string
}

/** 写回评估结果。 */
export async function recordDecision(db: Querier, messageId: string, patch: MessageDecisionPatch): Promise<void> {
  await db.query(
    `UPDATE dsh_superagent_messages
        SET status = $1, prompt_version = $2, provider = $3, model = $4,
            input_tokens = $5, output_tokens = $6, decision = $7, last_error = $8,
            evaluated_at = now()
      WHERE id = $9`,
    [
      patch.status,
      patch.promptVersion ?? null,
      patch.provider ?? null,
      patch.model ?? null,
      patch.inputTokens ?? null,
      patch.outputTokens ?? null,
      patch.decision === undefined ? null : jsonColumn(patch.decision),
      patch.error ?? null,
      messageId,
    ],
  )
}

/** 一个话题里待评估的消息，按收到顺序。 */
export async function pendingMessages(
  db: Querier,
  bindingId: string,
  threadKey: string,
  limit = 20,
): Promise<Array<{ id: string; body: string; senderId: string; senderName: string; addressed: boolean; receivedAt: string }>> {
  const rows = await db.query(
    `SELECT id, body, sender_id, sender_name, addressed, received_at
       FROM dsh_superagent_messages
      WHERE binding_id = $1 AND thread_key = $2 AND status = 'pending'
      ORDER BY received_at, external_message_id
      LIMIT $3`,
    [bindingId, threadKey, limit],
  )
  return rows.rows.map((row) => ({
    id: String(row.id),
    body: String(row.body ?? ''),
    senderId: String(row.sender_id ?? ''),
    senderName: String(row.sender_name ?? ''),
    addressed: asBool(row.addressed),
    receivedAt: iso(row.received_at),
  }))
}

/**
 * 这个会话最近一次落库的时间；补漏从这里往前留一点重叠，避免漏掉
 * 「中间一条没收到、后面一条收到了」的空档。
 */
export async function lastInboundAt(
  db: Querier,
  channelId: string,
  chatId: string,
): Promise<string | undefined> {
  const rows = await db.query(
    `SELECT MAX(received_at) AS at
       FROM dsh_superagent_messages
      WHERE channel_id = $1 AND external_chat_id = $2`,
    [channelId, chatId],
  )
  const at = rows.rows[0]?.at
  return at === undefined || at === null ? undefined : iso(at)
}

// ---------------------------------------------------------------- 工单

export interface TicketView {
  id: string
  bindingId: string
  channelId: string
  workspaceId: string
  threadKey: string
  title: string
  scope: string
  reason: string
  intentEvidence: string
  rules: string[]
  stage: TicketStage
  sessionId?: string
  autoMerge: boolean
  outcome: Record<string, unknown>
  createdAt: string
  updatedAt: string
  closedAt?: string
}

function ticketView(row: Record<string, unknown>): TicketView {
  return {
    id: String(row.id),
    bindingId: String(row.binding_id),
    channelId: String(row.channel_id),
    workspaceId: String(row.workspace_id),
    threadKey: String(row.thread_key),
    title: String(row.title ?? ''),
    scope: String(row.scope ?? ''),
    reason: String(row.reason ?? ''),
    intentEvidence: String(row.intent_evidence ?? ''),
    rules: asStringArray(row.rules ?? []),
    stage: String(row.stage ?? 'accepted') as TicketStage,
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    autoMerge: asBool(row.auto_merge),
    outcome: asJson<Record<string, unknown>>(row.outcome ?? '{}'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.closed_at ? { closedAt: iso(row.closed_at) } : {}),
  }
}

/** 接单：把评估结论落成工单，同一事务里排一条执行。 */
export async function createTicket(
  db: Db,
  input: {
    userId: string
    bindingId: string
    channelId: string
    workspaceId: string
    threadKey: string
    externalRootId?: string
    title: string
    scope: string
    reason: string
    intentEvidence: string
    rules: string[]
    messageId?: string
    autoMerge?: boolean
  },
): Promise<TicketView> {
  const id = newId('sa_tk')
  await db.transaction(async (q) => {
    await q.query(
      `INSERT INTO dsh_superagent_tickets
         (id, user_id, binding_id, channel_id, workspace_id, thread_key, external_root_id,
          title, scope, reason, intent_evidence, rules, message_id, auto_merge)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        input.userId,
        input.bindingId,
        input.channelId,
        input.workspaceId,
        input.threadKey,
        input.externalRootId ?? null,
        input.title,
        input.scope,
        input.reason,
        input.intentEvidence,
        jsonColumn(input.rules),
        input.messageId ?? null,
        input.autoMerge === true,
      ],
    )
    await q.query(
      `INSERT INTO dsh_superagent_assignments (id, ticket_id, user_id) VALUES ($1, $2, $3)`,
      [newId('sa_as'), id, input.userId],
    )
  })
  return (await ticketById(db, input.userId, id)) as TicketView
}

/** 读成员自己的工单。 */
export async function ticketById(db: Querier, userId: string, ticketId: string): Promise<TicketView | undefined> {
  const rows = await db.query(`SELECT * FROM dsh_superagent_tickets WHERE user_id = $1 AND id = $2`, [userId, ticketId])
  return rows.rows[0] === undefined ? undefined : ticketView(rows.rows[0])
}

/** 列出成员自己的工单，可按阶段过滤。 */
export async function listTickets(
  db: Querier,
  userId: string,
  options: { stage?: TicketStage; limit?: number } = {},
): Promise<TicketView[]> {
  const params: unknown[] = [userId]
  let where = 'user_id = $1'
  if (options.stage !== undefined) {
    params.push(options.stage)
    where += ` AND stage = $${params.length}`
  }
  params.push(options.limit ?? 200)
  const rows = await db.query(
    `SELECT * FROM dsh_superagent_tickets WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  )
  return rows.rows.map(ticketView)
}

/** 工单卡片：列表页还要认出「哪个群、哪块工作区」。 */
export interface TicketCardView extends TicketView {
  channelName: string
  workspaceName: string
  chatName: string
}

/** 列出成员自己的工单卡片，可按阶段过滤。 */
export async function listTicketCards(
  db: Querier,
  userId: string,
  options: { stage?: TicketStage; limit?: number } = {},
): Promise<TicketCardView[]> {
  const params: unknown[] = [userId]
  let where = 't.user_id = $1'
  if (options.stage !== undefined) {
    params.push(options.stage)
    where += ` AND t.stage = $${params.length}`
  }
  params.push(options.limit ?? 200)
  const rows = await db.query(
    `SELECT t.*, c.name AS channel_name, w.name AS workspace_name, b.chat_name AS chat_name
       FROM dsh_superagent_tickets t
       JOIN dsh_superagent_channels c ON c.id = t.channel_id
       JOIN dsh_workspaces w ON w.id = t.workspace_id
       LEFT JOIN dsh_superagent_bindings b ON b.id = t.binding_id
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return rows.rows.map((row) => ({
    ...ticketView(row),
    channelName: String(row.channel_name ?? ''),
    workspaceName: String(row.workspace_name ?? ''),
    chatName: String(row.chat_name ?? ''),
  }))
}

/**
 * 成员手动结束一张单：结束 / 停止后这个话题不再挡着新活。
 * 已经结束的单不接受第二次结束，返回 undefined 由路由回 409。
 */
export async function closeTicket(
  db: Db,
  userId: string,
  ticketId: string,
  stage: 'done' | 'stopped',
): Promise<TicketView | undefined> {
  let closed = false
  await db.transaction(async (q) => {
    const result = await q.query(
      `UPDATE dsh_superagent_tickets
          SET stage = $1, closed_at = now(), updated_at = now()
        WHERE user_id = $2 AND id = $3 AND stage IN ('accepted', 'working', 'review')
        RETURNING id`,
      [stage, userId, ticketId],
    )
    if (result.rows.length === 0) return
    closed = true
    await q.query(
      `UPDATE dsh_superagent_assignments
          SET status = 'cancelled', finished_at = now(), updated_at = now()
        WHERE ticket_id = $1 AND status IN ('queued', 'running')`,
      [ticketId],
    )
  })
  return closed ? ticketById(db, userId, ticketId) : undefined
}

/** 这个话题里还没结束的工单——用于判断是不是重复接单。 */
export async function openTicketsInThread(
  db: Querier,
  bindingId: string,
  threadKey: string,
): Promise<TicketView[]> {
  const rows = await db.query(
    `SELECT * FROM dsh_superagent_tickets
      WHERE binding_id = $1 AND thread_key = $2 AND stage IN ('accepted', 'working', 'review')
      ORDER BY created_at`,
    [bindingId, threadKey],
  )
  return rows.rows.map(ticketView)
}

/** 推进工单阶段；终态顺手写 `closed_at`。 */
export async function setTicketStage(
  db: Querier,
  ticketId: string,
  stage: TicketStage,
  patch: { sessionId?: string; outcome?: Record<string, unknown> } = {},
): Promise<void> {
  const closed = stage === 'done' || stage === 'failed' || stage === 'stopped'
  await db.query(
    `UPDATE dsh_superagent_tickets
        SET stage = $1,
            session_id = COALESCE($2, session_id),
            outcome = COALESCE($3, outcome),
            updated_at = now(),
            closed_at = CASE WHEN $4 THEN now() ELSE closed_at END
      WHERE id = $5`,
    [stage, patch.sessionId ?? null, patch.outcome === undefined ? null : jsonColumn(patch.outcome), closed, ticketId],
  )
}

/** 合并工单的 `outcome`：执行游标、结论分次写入，不覆盖彼此。 */
export async function patchTicketOutcome(
  db: Querier,
  ticketId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db.query(`SELECT outcome FROM dsh_superagent_tickets WHERE id = $1`, [ticketId])
  const row = rows.rows[0]
  if (row === undefined) return
  const current = asJson<Record<string, unknown>>(row.outcome ?? '{}')
  await db.query(`UPDATE dsh_superagent_tickets SET outcome = $1, updated_at = now() WHERE id = $2`, [
    jsonColumn({ ...current, ...patch }),
    ticketId,
  ])
}

/** 记一次执行结果（谁在跑、跑成什么样）。 */
export async function finishAssignment(
  db: Querier,
  assignmentId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  patch: { sessionId?: string; error?: string } = {},
): Promise<void> {
  await db.query(
    `UPDATE dsh_superagent_assignments
        SET status = $1, session_id = COALESCE($2, session_id), last_error = $3,
            finished_at = now(), updated_at = now()
      WHERE id = $4`,
    [status, patch.sessionId ?? null, patch.error ?? null, assignmentId],
  )
}

// ---------------------------------------------------------------- 执行队列

export interface ClaimedAssignment {
  id: string
  ticketId: string
  userId: string
  generation: number
  attemptCount: number
  bindingId: string
  channelId: string
  workspaceId: string
  threadKey: string
  externalRootId?: string
  title: string
  scope: string
  autoMerge: boolean
}

const CLAIM_PG = `UPDATE dsh_superagent_assignments AS a
    SET status = 'running', lease_owner = $1, lease_until = $2,
        attempt_count = a.attempt_count + 1, started_at = now(), updated_at = now()
   FROM (
     SELECT id FROM dsh_superagent_assignments
      WHERE status IN ('queued', 'running')
        AND (lease_until IS NULL OR lease_until <= now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT $3
   ) AS due
  WHERE a.id = due.id
  RETURNING a.*`

const CLAIM_SQLITE = `UPDATE dsh_superagent_assignments
    SET status = 'running', lease_owner = $1, lease_until = $2,
        attempt_count = attempt_count + 1, started_at = now(), updated_at = now()
  WHERE id IN (
    SELECT id FROM dsh_superagent_assignments
     WHERE status IN ('queued', 'running')
       AND (lease_until IS NULL OR lease_until <= now())
     ORDER BY created_at
     LIMIT $3
  )
  RETURNING *`

/** 认领一批待执行工单；租约到期后可被别的副本接手。 */
export async function claimAssignments(
  db: Db,
  owner: string,
  limit = 4,
  leaseMs = 60_000,
): Promise<ClaimedAssignment[]> {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
  const claimed = await db.query(db.dialect === 'sqlite' ? CLAIM_SQLITE : CLAIM_PG, [owner, leaseUntil, limit])
  return hydrateAssignments(db, claimed.rows)
}

/** 本副本正在跑的工单：看进度时只认自己的租约。 */
export async function runningAssignments(db: Querier, owner: string): Promise<ClaimedAssignment[]> {
  const rows = await db.query(
    `SELECT id, ticket_id, user_id, generation, attempt_count
       FROM dsh_superagent_assignments
      WHERE status = 'running' AND lease_owner = $1
      ORDER BY created_at`,
    [owner],
  )
  return hydrateAssignments(db, rows.rows)
}

/** 给执行续租；跑得久的工单不会被别的副本抢走。 */
export async function renewAssignment(db: Querier, assignmentId: string, owner: string, leaseMs = 60_000): Promise<void> {
  const until = new Date(Date.now() + leaseMs).toISOString()
  await db.query(
    `UPDATE dsh_superagent_assignments SET lease_until = $1, updated_at = now() WHERE id = $2 AND lease_owner = $3`,
    [until, assignmentId, owner],
  )
}

async function hydrateAssignments(db: Querier, assigned: Record<string, unknown>[]): Promise<ClaimedAssignment[]> {
  const rows: ClaimedAssignment[] = []
  for (const row of assigned) {
    const detail = await db.query(
      `SELECT t.binding_id, t.channel_id, t.workspace_id, t.thread_key, t.external_root_id,
              t.title, t.scope, t.auto_merge
         FROM dsh_superagent_tickets t
        WHERE t.id = $1`,
      [row.ticket_id],
    )
    const ticket = detail.rows[0]
    if (ticket === undefined) continue
    rows.push({
      id: String(row.id),
      ticketId: String(row.ticket_id),
      userId: String(row.user_id),
      generation: Number(row.generation ?? 1),
      attemptCount: Number(row.attempt_count ?? 1),
      bindingId: String(ticket.binding_id),
      channelId: String(ticket.channel_id),
      workspaceId: String(ticket.workspace_id),
      threadKey: String(ticket.thread_key),
      ...(ticket.external_root_id ? { externalRootId: String(ticket.external_root_id) } : {}),
      title: String(ticket.title ?? ''),
      scope: String(ticket.scope ?? ''),
      autoMerge: asBool(ticket.auto_merge),
    })
  }
  return rows
}

/** 放回队列等待下一次认领（例如成员还没配模型）。 */
export async function requeueAssignment(
  db: Querier,
  assignmentId: string,
  error: string,
  delayMs = 30_000,
): Promise<void> {
  const next = new Date(Date.now() + delayMs).toISOString()
  await db.query(
    `UPDATE dsh_superagent_assignments
        SET status = 'queued', lease_owner = NULL, lease_until = $1,
            last_error = $2, updated_at = now()
      WHERE id = $3`,
    [next, error, assignmentId],
  )
}

// ---------------------------------------------------------------- 回信

export interface OutboxItem {
  id: string
  userId: string
  channelId: string
  externalChatId: string
  threadRootId?: string
  kind: 'reply' | 'ack' | 'report' | 'decline'
  body: { text: string; replyInThread?: boolean }
  /** 认领时已经自增过的次数，失败时直接用它判断是否放弃。 */
  attemptCount: number
}

/** 排一条要发到群里的消息。 */
export async function enqueueOutbox(
  db: Querier,
  input: {
    userId: string
    channelId: string
    externalChatId: string
    threadRootId?: string
    kind: OutboxItem['kind']
    text: string
    /** 单聊为 false：私聊不支持话题回复。 */
    replyInThread?: boolean
  },
): Promise<string> {
  const id = newId('sa_out')
  await db.query(
    `INSERT INTO dsh_superagent_outbox
       (id, user_id, channel_id, external_chat_id, thread_root_id, kind, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.userId,
      input.channelId,
      input.externalChatId,
      input.threadRootId ?? null,
      input.kind,
      jsonColumn({ text: input.text, ...(input.replyInThread === false ? { replyInThread: false } : {}) }),
    ],
  )
  return id
}

const OUTBOX_PG = `UPDATE dsh_superagent_outbox AS o
    SET lease_owner = $1, lease_until = $2,
        attempt_count = o.attempt_count + 1
   FROM (
     SELECT id FROM dsh_superagent_outbox
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT $3
   ) AS due
  WHERE o.id = due.id
  RETURNING o.*`

const OUTBOX_SQLITE = `UPDATE dsh_superagent_outbox
    SET lease_owner = $1, lease_until = $2,
        attempt_count = attempt_count + 1
  WHERE id IN (
    SELECT id FROM dsh_superagent_outbox
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY next_attempt_at
     LIMIT $3
  )
  RETURNING *`

/** 认领一批到点的回信。 */
export async function claimOutbox(
  db: Db,
  owner: string,
  limit = 8,
  leaseMs = 60_000,
): Promise<OutboxItem[]> {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
  const claimed = await db.query(db.dialect === 'sqlite' ? OUTBOX_SQLITE : OUTBOX_PG, [owner, leaseUntil, limit])
  return claimed.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    channelId: String(row.channel_id),
    externalChatId: String(row.external_chat_id),
    ...(row.thread_root_id ? { threadRootId: String(row.thread_root_id) } : {}),
    kind: String(row.kind) as OutboxItem['kind'],
    body: asJson<{ text: string; replyInThread?: boolean }>(row.body ?? '{}'),
    attemptCount: Number(row.attempt_count ?? 1),
  }))
}

/** 渠道暂时连不上：放回队列，并把认领时加的次数退回去，别把它算成失败。 */
export async function deferOutbox(db: Querier, item: Pick<OutboxItem, 'id'>, delayMs: number): Promise<void> {
  const next = new Date(Date.now() + delayMs).toISOString()
  await db.query(
    `UPDATE dsh_superagent_outbox
        SET status = 'pending', next_attempt_at = $1,
            attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
            lease_owner = NULL, lease_until = NULL
      WHERE id = $2`,
    [next, item.id],
  )
}

/** 永远发不出去的回信（比如缺话题根消息）：直接死信，不进重试。 */
export async function discardOutbox(db: Querier, item: Pick<OutboxItem, 'id'>, error: string): Promise<void> {
  await db.query(
    `UPDATE dsh_superagent_outbox
        SET status = 'dead', last_error = $1, lease_owner = NULL, lease_until = NULL
      WHERE id = $2`,
    [error, item.id],
  )
}

/** 回信发送结果：成功落 `sent_at`，失败按退避重试，超过上限标记 `dead`。 */
export async function finishOutbox(
  db: Querier,
  item: Pick<OutboxItem, 'id' | 'attemptCount'>,
  error?: string,
  maxAttempts = 5,
): Promise<void> {
  if (error === undefined) {
    await db.query(
      `UPDATE dsh_superagent_outbox
          SET status = 'sent', sent_at = now(), lease_owner = NULL, lease_until = NULL
        WHERE id = $1`,
      [item.id],
    )
    return
  }
  const dead = item.attemptCount >= maxAttempts
  // 2s、4s、8s… 最长 15 分钟；群里没人看的时候不要每分钟重试。
  const next = new Date(Date.now() + Math.min(15 * 60_000, 2000 * 2 ** item.attemptCount)).toISOString()
  await db.query(
    `UPDATE dsh_superagent_outbox
        SET status = $1, next_attempt_at = $2, last_error = $3,
            lease_owner = NULL, lease_until = NULL
      WHERE id = $4`,
    [dead ? 'dead' : 'failed', next, error, item.id],
  )
}
