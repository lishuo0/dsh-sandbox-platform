import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Channels } from '../../src/modules/superagent/connector.js'
import { deliverOutbox } from '../../src/modules/superagent/delivery.js'
import { runAssignments, watchAssignments } from '../../src/modules/superagent/execute.js'
import {
  FeishuAdapter,
  type FeishuEvent,
  type FeishuHooks,
  type FeishuPort,
} from '../../src/modules/superagent/feishu.js'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 飞书接活的整条链路：一条群消息从长连接进来，走完
 * 「判断接不接 → 建工单 → 回确认 → 开工执行 → 收工回结论 → 投递回群」。
 *
 * **跑的是真实的脑**：平台 `BrainClient` 通过真实 HTTP 打到脑的 `registerRoutes`
 * （真实鉴权、真实 `evaluate` 逻辑、真实归属校验、真实会话/消息/事件路由），
 * 平台和脑共用同一套测试库——脑读得到平台写下的 `dsh_sessions` / `dsh_workspaces`，
 * 归属判定才会放行。这和仓库里 `schedule-reminder` / `joint-contract` 的真脑 e2e
 * 是同一条路。
 *
 * 只有两个**外部边界**换成假的：飞书长连接（`FeishuPort`，外部渠道）和模型本身
 * （脑的 `llm` 服务回一条固定的判断 JSON，不真去调 LLM）。平台自己的渠道表、入口、
 * 工单、执行循环、outbox，以及脑的评估/会话/事件路由，全部是真代码。
 */

// 脑的 evaluate 需要 `ctx.get('llm')`；这里只替换模型调用本身，评估逻辑仍是脑的真代码。
let evalOutput = ''
const fakeLlm = {
  async listModels(): Promise<readonly string[]> {
    return []
  },
  async *stream(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
    yield { type: 'text-delta', text: evalOutput }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

let stack: JointStack
let adminId = ''

beforeAll(async () => {
  stack = await startJointStack({ brainServices: { llm: fakeLlm } })
  adminId = stack.userId
  // 工单执行要在成员自己的工作区里开会话，先把模型配上（评估走假 llm，模型地址只为占位）。
  await configureModel(stack.baseUrl, stack.token)
  await stack.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w_pipeline', $1, '前端', '/host/w_pipeline', '/guest/w_pipeline')`,
    [adminId],
  )
})

afterAll(async () => {
  await stack.close()
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const response = await api(stack.baseUrl, path, {
    method,
    token: stack.token,
    ...(body === undefined ? {} : { body }),
  })
  return { status: response.status, data: (response.body.data ?? null) as unknown }
}

/** 走页面接口建飞书渠道，拿到的就是成员在「集成」页会看到的那一条。 */
async function createChannel(appId: string): Promise<string> {
  const result = await call('POST', '/superagent/channels', {
    provider: 'feishu',
    name: '我的机器人',
    appId,
    appSecret: 'shh',
  })
  expect(result.status).toBe(201)
  return (result.data as { id: string }).id
}

async function bind(channelId: string, externalChatId: string): Promise<void> {
  const result = await call('POST', '/superagent/bindings', {
    channelId,
    workspaceId: 'w_pipeline',
    externalChatId,
    chatName: '开发群',
    repo: 'acme/web',
    rules: ['前端改动可以接'],
  })
  expect(result.status).toBe(201)
}

/**
 * 假飞书长连接：钩子就是 `FeishuAdapter` 塞进来的那一份，
 * 测试直接调 `hooks.onEvent(...)` 模拟 SDK 送来一条消息。
 */
interface FakePort extends FeishuPort {
  hooks: FeishuHooks
  replies: Array<{ messageId: string; text: string; uuid: string; options?: { thread?: boolean } }>
  reactions: Array<{ messageId: string; emoji: string }>
  started: boolean
}

function fakePort(hooks: FeishuHooks): FakePort {
  const port: FakePort = {
    hooks,
    replies: [],
    reactions: [],
    started: false,
    start: async () => {
      port.started = true
    },
    stop: () => {
      port.started = false
    },
    react: async (messageId, emoji) => {
      port.reactions.push({ messageId, emoji })
    },
    reply: async (messageId, text, uuid, options) => {
      port.replies.push({ messageId, text, uuid, options })
    },
  }
  return port
}

/** 用假飞书连接搭一套渠道表；`ports` 按 appId 留引用，测试直接断言发出去的东西。 */
function hub(ports: Map<string, FakePort>): Channels {
  return new Channels(stack.platform.deps, [
    new FeishuAdapter((credential, hooks) => {
      const port = fakePort(hooks)
      ports.set(credential.appId, port)
      return port
    }),
  ])
}

interface TicketRow {
  id: string
  stage: string
  title: string
  thread_key: string
  session_id: string | null
}

async function ticketOf(channelId: string): Promise<TicketRow> {
  const rows = await stack.db.query<TicketRow>(
    `SELECT id, stage, title, thread_key, session_id FROM dsh_superagent_tickets WHERE channel_id = $1`,
    [channelId],
  )
  expect(rows.rows).toHaveLength(1)
  return rows.rows[0] as TicketRow
}

interface OutboxRow {
  status: string
  kind: string
  text: string
  attempt_count: number
}

async function outboxOf(channelId: string): Promise<OutboxRow[]> {
  const rows = await stack.db.query<{ status: string; kind: string; body: unknown; attempt_count: number }>(
    `SELECT status, kind, body, attempt_count FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at, id`,
    [channelId],
  )
  return rows.rows.map((row) => ({
    status: row.status,
    kind: row.kind,
    text: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body).text as string,
    attempt_count: Number(row.attempt_count),
  }))
}

/**
 * 让脑把工单这一回合「跑完」：往真实事件日志里补一条助手结论和 `turn/end`。
 * 平台 `watchAssignments` 通过真实 HTTP 的 `/events` 回放读到它们，正常收尾。
 */
function settleTurn(sessionId: string, text: string): void {
  stack.gateway.append(sessionId, 'assistant/message', {
    message: { content: [{ type: 'text', text }] },
  })
  stack.gateway.append(sessionId, 'turn/end', { reason: { kind: 'completed' } })
}

function groupEvent(overrides: Partial<FeishuEvent> = {}): FeishuEvent {
  return {
    chatId: 'oc_pipe_group',
    direct: false,
    messageId: 'om_pipe_group_1',
    senderId: 'ou_a',
    senderName: '小明',
    text: '把登录页修一下',
    mentioned: true,
    at: new Date().toISOString(),
    ...overrides,
  }
}

const acceptDecision = JSON.stringify({
  kind: 'accept',
  title: '修登录页',
  scope: '只改登录页',
  reason: '明确要求',
  intentEvidence: '「把登录页修一下」',
  rules: [],
})

describe('群聊整条链路（真平台 → 真脑）', () => {
  it('消息进来 → 建单回确认 → 开工执行 → 收工回结论，回复全部真正发出', async () => {
    evalOutput = acceptDecision
    const appId = 'cli_0123456789ab0001'
    const channelId = await createChannel(appId)
    await bind(channelId, 'oc_pipe_group')

    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    const port = ports.get(appId) as FakePort

    // 1. 长连接送来一条点名消息：先贴表情，再交给入口；入口真实调脑的 evaluate。
    await port.hooks.onEvent(groupEvent())
    expect(port.reactions).toEqual([{ messageId: 'om_pipe_group_1', emoji: 'THUMBSUP' }])

    const ticket = await ticketOf(channelId)
    expect(ticket).toMatchObject({ stage: 'accepted', title: '修登录页', thread_key: 'oc_pipe_group:om_pipe_group_1' })

    // 2. 确认回信已经落队列，由发送循环投递到话题里。
    expect(await outboxOf(channelId)).toEqual([
      expect.objectContaining({ status: 'pending', kind: 'ack' }),
    ])
    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(1)
    expect(port.replies[0]).toMatchObject({ messageId: 'om_pipe_group_1', options: { thread: true } })
    expect(port.replies[0]?.text).toContain('已接单：修登录页（工单 #')

    // 3. 执行循环认领工单：在绑定的工作区里开会话（真实脑），把工单说明投进去。
    expect(await runAssignments(stack.platform.deps, 'owner-1')).toBe(1)
    const working = await ticketOf(channelId)
    expect(working.stage).toBe('working')
    expect(working.session_id).toBeTruthy()
    const opened = stack.gateway.sessions.get(working.session_id as string)
    expect(opened).toBeDefined()
    const sent = stack.gateway.prompts.at(-1)
    expect(sent?.sessionId).toBe(working.session_id)
    expect(sent?.text).toContain('标题：修登录页')
    expect(sent?.text).toContain('仓库：acme/web')

    // 4. 回合结束：工单进入待查看，结论回队列。
    settleTurn(working.session_id as string, '改好了，动了登录页的提示文案。')
    expect(await watchAssignments(stack.platform.deps, 'owner-1')).toBe(1)
    expect((await ticketOf(channelId)).stage).toBe('review')

    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(1)
    const report = port.replies.at(-1)
    expect(report?.messageId).toBe('om_pipe_group_1')
    expect(report?.text).toContain('工单「修登录页」做完了')
    expect(report?.text).toContain('改好了')
    expect(report?.options).toEqual({ thread: true })

    // 确认和结论都发出去了，队列清空；再跑一轮没有可发的。
    expect((await outboxOf(channelId)).map((row) => row.status)).toEqual(['sent', 'sent'])
    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(0)
  })
})

describe('私聊整条链路（真平台 → 真脑）', () => {
  it('私聊不用手动绑定：落到默认工作区，确认不进话题', async () => {
    evalOutput = acceptDecision
    const appId = 'cli_0123456789ab0002'
    const channelId = await createChannel(appId)
    // 先验私聊不要求预先绑定，再验从确认到执行结论都能投出去。
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    const port = ports.get(appId) as FakePort

    await port.hooks.onEvent(
      groupEvent({
        chatId: 'oc_pipe_dm',
        direct: true,
        messageId: 'om_pipe_dm_1',
        text: '修一下登录页',
      }),
    )

    const binding = await stack.db.query<{ workspace_id: string; chat_name: string }>(
      `SELECT workspace_id, chat_name FROM dsh_superagent_bindings WHERE channel_id = $1 AND external_chat_id = 'oc_pipe_dm'`,
      [channelId],
    )
    expect(binding.rows[0]).toMatchObject({ workspace_id: 'w_pipeline', chat_name: '私聊' })

    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(1)
    expect(port.replies[0]).toMatchObject({ messageId: 'om_pipe_dm_1', options: { thread: false } })
    expect(port.replies[0]?.text).toContain('已接单：修登录页（工单 #')

    expect(await runAssignments(stack.platform.deps, 'owner-1')).toBe(1)
    const working = await ticketOf(channelId)
    settleTurn(working.session_id as string, '登录页改好了。')
    expect(await watchAssignments(stack.platform.deps, 'owner-1')).toBe(1)

    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(1)
    const report = port.replies.at(-1)
    // 结论仍然回到那条私聊消息下；单聊的确认早已按无话题发出。
    expect(report?.messageId).toBe('om_pipe_dm_1')
    expect(report?.text).toContain('工单「修登录页」做完了')
    expect((await ticketOf(channelId)).stage).toBe('review')
  })
})

describe('渠道掉线（真平台 → 真脑）', () => {
  it('连接断了照常跑完工单，回信留在队列；连上后补发', async () => {
    evalOutput = acceptDecision
    const appId = 'cli_0123456789ab0003'
    const channelId = await createChannel(appId)
    await bind(channelId, 'oc_pipe_offline')

    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    const firstPort = ports.get(appId) as FakePort
    await firstPort.hooks.onEvent(groupEvent({ chatId: 'oc_pipe_offline', messageId: 'om_pipe_offline_1' }))

    // 验收之后、投递之前长连接断了。
    channels.stopAll()
    expect(firstPort.started).toBe(false)

    // 脑照常开会话、收工单；工单收尾。
    expect(await runAssignments(stack.platform.deps, 'owner-1')).toBe(1)
    const working = await ticketOf(channelId)
    settleTurn(working.session_id as string, '改好了。')
    expect(await watchAssignments(stack.platform.deps, 'owner-1')).toBe(1)
    expect((await ticketOf(channelId)).stage).toBe('review')

    // 渠道不在线：确认和结论都留在 pending，且没有消耗重试次数。
    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(0)
    const queued = await outboxOf(channelId)
    expect(queued.map((row) => [row.status, row.kind])).toEqual([
      ['pending', 'ack'],
      ['pending', 'report'],
    ])
    expect(queued.every((row) => row.attempt_count === 0)).toBe(true)

    // 连接回来后重新对齐渠道，把等着的两条补发出去。
    await channels.sync()
    const secondPort = ports.get(appId) as FakePort
    expect(secondPort.started).toBe(true)
    await stack.db.query(`UPDATE dsh_superagent_outbox SET next_attempt_at = now() WHERE channel_id = $1`, [channelId])
    expect(await deliverOutbox(stack.platform.deps, channels, 'owner-1')).toBe(2)
    expect(secondPort.replies.map((reply) => reply.messageId)).toEqual(['om_pipe_offline_1', 'om_pipe_offline_1'])
    expect(secondPort.replies[0]?.text).toContain('已接单')
    expect(secondPort.replies[1]?.text).toContain('做完了')
    expect((await outboxOf(channelId)).every((row) => row.status === 'sent')).toBe(true)
  })
})