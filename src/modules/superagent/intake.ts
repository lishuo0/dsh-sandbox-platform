/**
 * 群消息入口：去重 → 找绑定 → 判断是不是对它说的 → 交给模型判断接不接。
 *
 * 产品规则（都在这个文件里收口）：
 * - 没绑定工作区的群完全不响应，连消息都不落库；
 * - 只处理「点名机器人 / 单聊」的消息；其它群聊消息只记一笔，保持安静；
 * - 绑定一条规则都没配时，下发一条默认的开发范围，常规开发请求照常能接；
 *   规则配了但全被禁用，说明成员明确不想接，一条都不给；
 * - 接单的确认由平台固定带上工单号，模型的话术只负责开头；
 * - 收到点名 / 单聊的新消息，先贴个表情表示「看到了」，不让成员干等模型；
 * - 只要它被点名了，就一定会有回应——接活回确认，不接活也得说明；
 *   模型判成 `ignore` 时也要回一句（优先用模型给的 `reply`），
 *   唯一静默的情况是「这条不是对我说的」。
 *
 * @module platform/modules/superagent/intake
 */

import type { SuperagentConfig } from '../../config.js'
import type { Db } from '../../kernel/db.js'
import { HttpError } from '../../kernel/errors.js'
import type { BrainClient } from '../../brain/client.js'
import { resolveModel } from '../models/service.js'
import type { ChannelHandle, InboundEvent } from './channel.js'
import { evaluateInbox, type EvaluateBody } from './evaluate.js'
import {
  bindingForChat,
  createBinding,
  createTicket,
  defaultWorkspaceId,
  enqueueOutbox,
  openTicketsInThread,
  pendingMessages,
  recordDecision,
  recordInbound,
  type BindingView,
  type MessageStatus,
} from './store.js'

/** 模型判成 `ignore` 却没给 `reply` 时的兜底：至少让对方知道消息被看到了。 */
const IGNORE_REPLY = '在的，这条我看到了；要我做什么直接说。'

/**
 * 绑定里一条规则都没配时的默认接单范围：常规软件开发请求。
 *
 * 模型只有在「有启用的规则覆盖」时才敢接活，新绑定的群没有规则，
 * 不给默认值的话连「初始化个项目」都会被拒。配过规则的群（哪怕规则全禁用）
 * 说明成员对范围有明确意见，这里不再插手。
 */
const DEFAULT_RULE = {
  id: 'default',
  enabled: true,
  instruction:
    '处理这个工作区里的常规软件开发请求：初始化项目、写代码、改功能、修缺陷、补测试、写文档、配置构建与依赖；不接与软件无关的事务，也不接删除数据、改生产环境等破坏性操作。',
}

/** 部署级兜底：成员没配规则时，这一层说了算。 */
export interface IntakeDefaults {
  /** 一句一条的默认接活规则。 */
  rules: string[]
}

/** 把 `config.yaml` 的 `superagent` 段变成入口能直接用的默认值。 */
export function intakeDefaults(superagent?: SuperagentConfig): IntakeDefaults {
  return {
    rules: superagent?.defaultRules ?? [],
  }
}

export interface IntakeDeps {
  db: Db
  credentialsKey: Buffer
  brain: BrainClient
  /**
   * 确认收到：在判断接不接之前先给成员一个回应（例如贴个表情）。
   * 只有「确实是新的、并且是在对它说」的消息才调用；失败不影响后面的流程。
   */
  acknowledge?: (channel: ChannelHandle, event: InboundEvent) => Promise<void>
  /**
   * `config.yaml` 里的 `superagent` 段归一后的结果。没有它时用内置默认范围；
   * 测试和嵌入场景可以不传。
   */
  superagentDefaults?: IntakeDefaults
}

/** 入口处理的结果；测试直接断言它，界面上只用于日志。 */
export type IntakeAction =
  | 'unbound'
  | 'no-workspace'
  | 'duplicate'
  | 'not-addressed'
  | 'ignored'
  | 'stopped'
  | 'busy'
  | 'accepted'
  | 'unavailable'

export interface IntakeResult {
  action: IntakeAction
  ticketId?: string
}

/** 一条群消息的全流程。任何模型侧失败都只影响这一条，不外抛。 */
export async function intake(
  deps: IntakeDeps,
  channel: ChannelHandle,
  event: InboundEvent,
): Promise<IntakeResult> {
  const { db } = deps
  let binding = await bindingForChat(db, channel.id, event.conversation)
  if (binding === undefined) {
    // 群必须先绑工作区才响应；私聊不用绑，直接落到成员的默认工作区。
    if (!event.direct) return { action: 'unbound' }
    const workspaceId = await defaultWorkspaceId(db, channel.userId)
    if (workspaceId === undefined) {
      await enqueueOutbox(db, {
        userId: channel.userId,
        channelId: channel.id,
        externalChatId: event.conversation,
        threadRootId: event.thread,
        kind: 'reply',
        text: '你还没有可用的工作区。先在平台里建一个工作区，我才能在私聊里接活。',
        replyInThread: false,
      })
      return { action: 'no-workspace' }
    }
    binding = await directBinding(db, channel, event, workspaceId)
  }

  const threadKey = threadKeyOf(event)
  const open = await openTicketsInThread(db, binding.id, threadKey)
  // 只有明确对它说（点名 / 单聊 / assignee…）才处理；其它消息只记一笔。
  const addressed = event.addressed

  const stored = await recordInbound(db, {
    bindingId: binding.id,
    userId: channel.userId,
    channelId: channel.id,
    externalChatId: event.conversation,
    externalMessageId: event.messageId,
    threadKey,
    senderId: event.senderId,
    senderName: event.senderName,
    body: event.text,
    addressed,
  })
  if (!stored.fresh) return { action: 'duplicate' }

  if (!addressed) {
    await recordDecision(db, stored.id, { status: 'skipped', decision: { kind: 'ignore', reason: 'not-addressed' } })
    return { action: 'not-addressed' }
  }

  // 先给个回应，别让人干等模型：贴个表情是最快的「收到了」。
  if (deps.acknowledge !== undefined) {
    await deps.acknowledge(channel, event).catch(() => undefined)
  }

  const model = await resolveModel(db, deps.credentialsKey, channel.userId)
  if (model === undefined) {
    await recordDecision(db, stored.id, { status: 'failed', error: 'model-not-configured' })
    await reply(deps, binding, event, 'decline', '我还没配置模型，暂时判断不了这条要不要做。')
    return { action: 'unavailable' }
  }

  // 同一个话题的待评估消息一起看，模型才知道上下文。
  const pending = await pendingMessages(db, binding.id, threadKey, 20)
  const triggers = pending.length > 0 ? pending : [{ id: stored.id, body: event.text, senderId: event.senderId, senderName: '' }]
  const body: EvaluateBody = {
    thread: { key: threadKey, kind: event.direct ? 'direct' : 'chat' },
    triggers: triggers.slice(-20).map((item) => ({
      id: item.id,
      text: item.senderName === '' ? item.body : `[${item.senderName}] ${item.body}`,
    })),
    // 能走到这里的都是点名 / 单聊，是人明确提出的要求。
    strength: 'explicit',
    policyVersion: binding.policyVersion,
    policy: {
      rules: rulesOf(binding, deps.superagentDefaults),
      ...(binding.policy.actions === undefined ? {} : { actions: binding.policy.actions as Record<string, unknown> }),
    },
    tickets: open.map((ticket) => ({ id: ticket.id, stage: ticket.stage, title: ticket.title })),
  }

  const result = await evaluateInbox(deps.brain, { userId: channel.userId, model, body })
  const usage = {
    ...(result.promptVersion === undefined ? {} : { promptVersion: result.promptVersion }),
    ...(result.model === undefined ? {} : { provider: result.model.provider, model: result.model.model }),
    ...(result.usage?.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
    ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
    decision: result.outcome,
  }

  const settle = async (status: MessageStatus, error?: string): Promise<void> => {
    for (const item of triggers) {
      await recordDecision(deps.db, item.id, { status, ...usage, ...(error === undefined ? {} : { error }) })
    }
  }

  switch (result.outcome.kind) {
    case 'ignore':
      // 不是活，但消息已经点名了它——不能装没看见。
      await settle('ignored')
      await reply(deps, binding, event, 'reply', result.outcome.reply ?? IGNORE_REPLY)
      return { action: 'ignored' }

    case 'stop':
      await settle('ignored')
      await reply(deps, binding, event, 'reply', result.outcome.reason || '好，先停下。')
      return { action: 'stopped' }

    case 'unavailable':
      await settle('failed', result.outcome.reason.code)
      await reply(deps, binding, event, 'decline', '我这会儿没法判断这条要不要做，稍后再试。')
      return { action: 'unavailable' }

    case 'accept': {
      if (open.length > 0) {
        const running = open[0]?.title === undefined ? '' : `「${open[0].title}」`
        await settle('skipped', 'thread-busy')
        await reply(deps, binding, event, 'reply', `这条我先记着：当前工单${running}还没做完，等它结束再接着处理。`)
        return { action: 'busy' }
      }
      const ticket = await createTicket(deps.db, {
        userId: channel.userId,
        bindingId: binding.id,
        channelId: channel.id,
        workspaceId: binding.workspaceId,
        threadKey,
        externalRootId: event.thread,
        title: result.outcome.title,
        scope: result.outcome.scope,
        reason: result.outcome.reason,
        intentEvidence: result.outcome.intentEvidence,
        rules: result.outcome.rules,
        messageId: stored.id,
        autoMerge: binding.policy.autoMerge === true,
      })
      await settle('accepted')
      const ack = result.outcome.acknowledgement ?? `收到，我开工了：${result.outcome.title}。`
      // 接单是确定性事实，平台自己说清楚：工单号固定带上，不指望模型提到。
      await reply(
        deps,
        binding,
        event,
        'ack',
        `${ack}\n已接单：${result.outcome.title}（工单 ${ticketLabel(ticket.id)}），进展我会在这个话题里同步。`,
      )
      return { action: 'accepted', ticketId: ticket.id }
    }
  }
}

/** 话题键：会话 + 话题。同一条消息重投、同一话题里的回复都落到同一个键。 */
export function threadKeyOf(event: Pick<InboundEvent, 'conversation' | 'thread'>): string {
  return `${event.conversation}:${event.thread}`
}

/** 私聊兜底：把这条单聊接到成员的默认工作区，之后的消息直接命中绑定。 */
async function directBinding(
  db: Db,
  channel: ChannelHandle,
  event: InboundEvent,
  workspaceId: string,
): Promise<BindingView> {
  try {
    return await createBinding(db, channel.userId, {
      channelId: channel.id,
      workspaceId,
      externalChatId: event.conversation,
      chatName: '私聊',
    })
  } catch (error) {
    // 同一个私聊两条消息同时到达时，后到的会撞唯一索引；读回先到的那条。
    if (!(error instanceof HttpError) || error.status !== 409) throw error
    const found = await bindingForChat(db, channel.id, event.conversation)
    if (found === undefined) throw error
    return found
  }
}

/**
 * 绑定里启用的规则交给模型；一条规则都没配时的兜底顺序：
 * 部署级默认规则（`config.yaml`）→ 内置的常规开发范围。规则全禁用就真的一条不给。
 */
function rulesOf(
  binding: BindingView,
  defaults?: IntakeDefaults,
): Array<{ id: string; enabled: boolean; instruction?: string }> {
  const raw = binding.policy.rules
  if (!Array.isArray(raw) || raw.length === 0) {
    const configured = defaults?.rules ?? []
    if (configured.length > 0) {
      return configured.map((instruction, index) => ({ id: `cfg${index + 1}`, enabled: true, instruction }))
    }
    // 部署也没配：用内置的开发范围兜底，否则模型没有任何依据接活。
    return [{ ...DEFAULT_RULE }]
  }
  return raw.flatMap((rule) => {
    if (rule === null || typeof rule !== 'object') return []
    const { id, enabled, instruction } = rule as { id?: unknown; enabled?: unknown; instruction?: unknown }
    if (typeof id !== 'string' || enabled !== true) return []
    return [{ id, enabled: true, ...(typeof instruction === 'string' ? { instruction } : {}) }]
  })
}

/** 工单号给成员看：取 uuid 末 8 位，够区分又不刷屏。 */
function ticketLabel(id: string): string {
  return `#${id.slice(-8)}`
}

/** 回信先落库，由发送循环投递；这里只保证「一定会说」。 */
async function reply(
  deps: IntakeDeps,
  binding: BindingView,
  event: InboundEvent,
  kind: 'ack' | 'reply' | 'decline' | 'report',
  text: string,
): Promise<void> {
  await enqueueOutbox(deps.db, {
    userId: binding.userId,
    channelId: binding.channelId,
    externalChatId: event.conversation,
    threadRootId: event.thread,
    kind,
    text,
    // 单聊没有话题；群里回复到话题里，不刷屏。
    replyInThread: !event.direct,
  })
}
