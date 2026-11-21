/**
 * 「集成」与「工单任务」两个页面的成员接口。
 *
 * 所有资源都按登录成员过滤；飞书密钥只进不出，列表里只有 App ID 和连接状态。
 * 改渠道 / 绑定时顺手让连接器对齐一次，新加的机器人不用等下一轮轮询。
 *
 * @module platform/modules/superagent/routes
 */

import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { syncChannels } from './connector.js'
import { FeishuError, listFeishuChats } from './feishu.js'
import {
  bindingById,
  channelById,
  closeTicket,
  createBinding,
  createChannel,
  deleteBinding,
  deleteChannel,
  enqueueOutbox,
  listBindings,
  listChannels,
  listTicketCards,
  openChannel,
  ticketById,
  updateBinding,
  updateChannel,
  type TicketStage,
} from './store.js'

const TICKET_STAGES: readonly TicketStage[] = ['accepted', 'working', 'review', 'done', 'failed', 'stopped']

export function superagentRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/superagent/channels',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: { items: await listChannels(deps.db, ctx.actor!.id) } })
      },
    },
    {
      method: 'POST',
      path: '/superagent/channels',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{
          provider?: string
          name?: string
          appId?: string
          appSecret?: string
          defaultRules?: unknown
        }>()
        const provider = body.provider ?? 'feishu'
        // GitHub 的凭证形状（App 私钥 + webhook secret）还没落地，先明确拒绝，别悄悄当成飞书。
        if (provider !== 'feishu') throw new HttpError(422, 'provider-not-supported')
        const channel = await createChannel(deps.db, deps.credentialsKey, ctx.actor!.id, {
          provider,
          name: typeof body.name === 'string' ? body.name.trim() : '',
          appId: required(body.appId, 'app-id-required'),
          appSecret: required(body.appSecret, 'app-secret-required'),
          ...(body.defaultRules === undefined ? {} : { defaultRules: instructionsOf(body.defaultRules) }),
        })
        syncChannels()
        ctx.send(201, { code: 0, msg: 'ok', data: channel })
      },
    },
    {
      method: 'PATCH',
      path: '/superagent/channels/:id',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{
          name?: string
          appSecret?: string
          status?: string
          defaultRules?: unknown
        }>()
        const channel = await updateChannel(deps.db, deps.credentialsKey, ctx.actor!.id, ctx.params.id, {
          ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
          ...(typeof body.appSecret === 'string' && body.appSecret !== '' ? { appSecret: body.appSecret } : {}),
          ...(body.status === 'active' || body.status === 'disabled' ? { status: body.status } : {}),
          ...(body.defaultRules === undefined ? {} : { defaultRules: instructionsOf(body.defaultRules) }),
        })
        syncChannels()
        ctx.send(200, { code: 0, msg: 'ok', data: channel })
      },
    },
    {
      method: 'DELETE',
      path: '/superagent/channels/:id',
      auth: 'member',
      handle: async (ctx) => {
        await deleteChannel(deps.db, ctx.actor!.id, ctx.params.id)
        syncChannels()
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'GET',
      path: '/superagent/channels/:id/chats',
      auth: 'member',
      handle: async (ctx) => {
        // 先用成员身份确认渠道归属，再解密凭证去问飞书；别人拉不动我的群。
        const channel = await channelById(deps.db, ctx.actor!.id, ctx.params.id)
        if (channel === undefined) throw new HttpError(404, 'channel-not-found')
        // 这条接口列的是「可绑定的会话」；目前只有飞书提供群列表。
        if (channel.provider !== 'feishu') throw new HttpError(422, 'provider-not-supported')
        const credential = await openChannel(deps.db, deps.credentialsKey, channel.id)
        if (credential === undefined) throw new HttpError(404, 'channel-not-found')
        try {
          const items = await (deps.feishuChats ?? listFeishuChats)({
            appId: credential.appId,
            appSecret: credential.appSecret,
          })
          ctx.send(200, { code: 0, msg: 'ok', data: { items } })
        } catch (error) {
          // 渠道在飞书那边不可用时，页面需要一句能照着做的说明，而不是 500。
          throw new HttpError(502, 'feishu-chats-failed', { reason: reasonOf(error) })
        }
      },
    },
    {
      method: 'GET',
      path: '/superagent/bindings',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: { items: await listBindings(deps.db, ctx.actor!.id) } })
      },
    },
    {
      method: 'POST',
      path: '/superagent/bindings',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<BindingBody>()
        const binding = await createBinding(deps.db, ctx.actor!.id, {
          channelId: required(body.channelId, 'channel-id-required'),
          workspaceId: required(body.workspaceId, 'workspace-id-required'),
          externalChatId: required(body.externalChatId, 'chat-id-required').trim(),
          chatName: typeof body.chatName === 'string' ? body.chatName.trim() : '',
          policy: policyPatch({}, body),
        })
        syncChannels()
        ctx.send(201, { code: 0, msg: 'ok', data: binding })
      },
    },
    {
      method: 'PATCH',
      path: '/superagent/bindings/:id',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<BindingBody & { status?: string }>()
        const current = await bindingById(deps.db, ctx.actor!.id, ctx.params.id)
        if (current === undefined) throw new HttpError(404, 'binding-not-found')
        const binding = await updateBinding(deps.db, ctx.actor!.id, ctx.params.id, {
          ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspace-id-required') }),
          ...(typeof body.chatName === 'string' ? { chatName: body.chatName.trim() } : {}),
          ...(body.status === 'active' || body.status === 'paused' ? { status: body.status } : {}),
          ...(policyTouched(body) ? { policy: policyPatch(current.policy, body) } : {}),
        })
        syncChannels()
        ctx.send(200, { code: 0, msg: 'ok', data: binding })
      },
    },
    {
      method: 'DELETE',
      path: '/superagent/bindings/:id',
      auth: 'member',
      handle: async (ctx) => {
        await deleteBinding(deps.db, ctx.actor!.id, ctx.params.id)
        syncChannels()
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'GET',
      path: '/superagent/tickets',
      auth: 'member',
      handle: async (ctx) => {
        const raw = ctx.url.searchParams.get('stage')
        if (raw !== null && !TICKET_STAGES.includes(raw as TicketStage)) throw new HttpError(422, 'invalid-stage')
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: {
            items: await listTicketCards(deps.db, ctx.actor!.id, {
              ...(raw === null ? {} : { stage: raw as TicketStage }),
            }),
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/superagent/tickets/:id/close',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ stage?: string }>()
        const target = body.stage === 'done' ? 'done' : 'stopped'
        const userId = ctx.actor!.id
        const before = await ticketById(deps.db, userId, ctx.params.id)
        if (before === undefined) throw new HttpError(404, 'ticket-not-found')
        // 停「进行中」的工单：先让脑把回合停下来，再关平台这边的记录。
        // 脑不可达也要关单——成员不能被一张停不掉的单卡住，失败只留在日志里。
        if (target === 'stopped' && before.stage === 'working' && before.sessionId !== undefined) {
          await deps.brain
            .cancel({
              userId,
              workspaceId: before.workspaceId,
              sessionId: before.sessionId,
              requestId: `ticket-stop.${before.id}`,
            })
            .catch(() => undefined)
        }
        const closed = await closeTicket(deps.db, userId, ctx.params.id, target)
        if (closed === undefined) throw new HttpError(409, 'ticket-not-open')
        // 正在干活时被叫停：群里要有一句交代，不能悄悄消失。
        if (target === 'stopped' && (before.stage === 'accepted' || before.stage === 'working')) {
          await enqueueOutbox(deps.db, {
            userId,
            channelId: closed.channelId,
            externalChatId: chatOf(closed.threadKey),
            ...(threadRoot(closed.threadKey) === undefined ? {} : { threadRootId: threadRoot(closed.threadKey) }),
            kind: 'reply',
            text: `工单「${closed.title}」我先停下了，有需要再喊我。`,
          })
        }
        ctx.send(200, { code: 0, msg: 'ok', data: closed })
      },
    },
  ]
}

interface BindingBody {
  channelId?: string
  workspaceId?: string
  externalChatId?: string
  chatName?: string
  repo?: string
  autoMerge?: boolean
  rules?: unknown
}

/** 只认非空字符串；缺了就是请求不完整。 */
function required(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(422, code)
  return value.trim()
}

function policyTouched(body: BindingBody): boolean {
  return body.repo !== undefined || body.autoMerge !== undefined || body.rules !== undefined
}

/** 合并绑定策略：只改页面上出现的字段，规则统一成 `{id, enabled, instruction}`。 */
function policyPatch(current: Record<string, unknown>, body: BindingBody): Record<string, unknown> {
  const policy = { ...current }
  if (body.repo !== undefined) {
    if (typeof body.repo !== 'string') throw new HttpError(422, 'invalid-repo')
    const repo = body.repo.trim()
    if (repo === '') delete policy.repo
    else policy.repo = repo
  }
  if (body.autoMerge !== undefined) {
    if (typeof body.autoMerge !== 'boolean') throw new HttpError(422, 'invalid-auto-merge')
    policy.autoMerge = body.autoMerge
  }
  if (body.rules !== undefined) policy.rules = rulesOf(body.rules)
  return policy
}

/** 机器人默认规则只要「一句一条」的说明，不接受空行。 */
function instructionsOf(value: unknown): string[] {
  return rulesOf(value, 'invalid-default-rules')
    .filter((rule) => rule.enabled)
    .map((rule) => rule.instruction)
}

/** 规则是自然语言的范围说明，顺序就是页面上看到的顺序。 */
function rulesOf(value: unknown, code = 'invalid-rules'): Array<{ id: string; enabled: boolean; instruction: string }> {
  if (!Array.isArray(value)) throw new HttpError(422, code)
  const rules: Array<{ id: string; enabled: boolean; instruction: string }> = []
  value.forEach((item, index) => {
    if (typeof item === 'string') {
      const instruction = item.trim()
      if (instruction !== '') rules.push({ id: `r${index + 1}`, enabled: true, instruction })
      return
    }
    if (item === null || typeof item !== 'object') throw new HttpError(422, code)
    const { id, enabled, instruction } = item as { id?: unknown; enabled?: unknown; instruction?: unknown }
    if (typeof instruction !== 'string' || instruction.trim() === '') throw new HttpError(422, code)
    rules.push({
      id: typeof id === 'string' && id.trim() !== '' ? id.trim() : `r${index + 1}`,
      enabled: enabled !== false,
      instruction: instruction.trim(),
    })
  })
  return rules
}

/** 飞书拉群失败的原因：带上业务码，成员一看就知道是权限还是凭证。 */
function reasonOf(error: unknown): string {
  if (error instanceof FeishuError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function chatOf(threadKey: string): string {
  const at = threadKey.indexOf(':')
  return at < 0 ? threadKey : threadKey.slice(0, at)
}

function threadRoot(threadKey: string): string | undefined {
  const at = threadKey.indexOf(':')
  const root = at < 0 ? '' : threadKey.slice(at + 1)
  return root === '' ? undefined : root
}
