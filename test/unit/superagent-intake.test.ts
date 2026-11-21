import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainClient } from '../../src/brain/client.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import type { ChannelHandle, InboundEvent } from '../../src/modules/superagent/channel.js'
import { intake, threadKeyOf, type IntakeDeps } from '../../src/modules/superagent/intake.js'
import { createProvider } from '../../src/modules/models/service.js'
import {
  createBinding,
  createChannel,
  createTicket,
  updateBinding,
  type BindingView,
} from '../../src/modules/superagent/store.js'

/**
 * 群消息入口的产品规则：
 * 没绑定的群不吭声；点名了一定有回应；不接活也要说明；不重复建单。
 */

let dir: string
let db: SqliteDb
const key = randomBytes(32)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-intake-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w1', 'u1', '前端', '/h/w1', '/g/w1')`,
  )
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

interface Env {
  channel: ChannelHandle
  binding: BindingView
}

/** 一条可用渠道 + 一个绑定了工作区的群。 */
async function env(policy?: Record<string, unknown>): Promise<Env> {
  const created = await createChannel(db, key, 'u1', {
    provider: 'feishu',
    name: '我的机器人',
    appId: 'cli_a1b2c3d4e5f60718',
    appSecret: 'shh',
  })
  const binding = await createBinding(db, 'u1', { channelId: created.id, workspaceId: 'w1', externalChatId: 'oc_1' })
  const channel: ChannelHandle = { id: created.id, userId: 'u1', provider: 'feishu' }
  if (policy !== undefined) {
    const updated = await updateBinding(db, 'u1', binding.id, { policy })
    return { channel, binding: updated }
  }
  return { channel, binding }
}

async function model(): Promise<void> {
  await createProvider(db, key, 'u1', {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-user-key',
    modelIds: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
  })
}

function message(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    provider: 'feishu',
    conversation: 'oc_1',
    // 没有根消息时话题就是自己；重投同一条、回复到根消息都落到同一个键。
    thread: overrides.thread ?? overrides.messageId ?? 'om_1',
    messageId: 'om_1',
    senderId: 'ou_a',
    senderName: '小明',
    text: '把登录页修一下',
    addressed: true,
    direct: false,
    at: new Date().toISOString(),
    ...overrides,
  }
}

interface BrainSpy {
  brain: BrainClient
  calls: Array<{ userId: string; body: { strength: string; policy: { rules: unknown[] }; triggers: unknown[] } }>
}

function brainWith(outcome: unknown): BrainSpy {
  const calls: BrainSpy['calls'] = []
  return {
    calls,
    brain: {
      evaluate: async (input: BrainSpy['calls'][number]) => {
        calls.push(input)
        return { ok: true as const, value: { outcome } }
      },
    } as unknown as BrainClient,
  }
}

function deps(brain: BrainClient, superagentDefaults?: IntakeDeps['superagentDefaults']): IntakeDeps {
  return {
    db,
    credentialsKey: key,
    brain,
    ...(superagentDefaults === undefined ? {} : { superagentDefaults }),
  }
}

async function outbox(): Promise<Array<{ kind: string; text: string }>> {
  const rows = await db.query(`SELECT kind, body FROM dsh_superagent_outbox ORDER BY created_at, id`)
  return rows.rows.map((row) => ({
    kind: String(row.kind),
    text: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body).text,
  }))
}

async function outboxBodies(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.query(`SELECT body FROM dsh_superagent_outbox ORDER BY created_at, id`)
  return rows.rows.map((row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Record<string, unknown>)
}

async function counts(): Promise<{ tickets: number; messages: number }> {
  const tickets = await db.query(`SELECT count(*) AS n FROM dsh_superagent_tickets`)
  const messages = await db.query(`SELECT count(*) AS n FROM dsh_superagent_messages`)
  return { tickets: Number(tickets.rows[0]?.n), messages: Number(messages.rows[0]?.n) }
}

const accepted = {
  kind: 'accept',
  title: '修登录页',
  scope: '只改登录页',
  reason: '明确要求',
  intentEvidence: '「把登录页修一下」',
  rules: ['r1'],
}

describe('没绑定的群', () => {
  it('完全不响应，连消息都不落库', async () => {
    const { channel } = await env()
    const spy = brainWith(accepted)
    const result = await intake(deps(spy.brain), channel, message({ conversation: 'oc_unknown' }))
    expect(result.action).toBe('unbound')
    expect(spy.calls).toHaveLength(0)
    expect(await counts()).toEqual({ tickets: 0, messages: 0 })
    expect(await outbox()).toEqual([])
  })
})

describe('私聊', () => {
  it('不用手动绑定：自动落到默认工作区，下次直接复用', async () => {
    await model()
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, is_default)
       VALUES ('w2', 'u1', '默认工作区', '/h/w2', '/g/w2', 1)`,
    )
    const { channel } = await env()
    const spy = brainWith(accepted)
    const dm = message({ conversation: 'oc_dm', thread: 'om_dm', direct: true, messageId: 'om_dm' })
    const result = await intake(deps(spy.brain), channel, dm)
    expect(result.action).toBe('accepted')
    // 私聊被当成明确点名的消息。
    expect(spy.calls[0]?.body.strength).toBe('explicit')

    const rows = await db.query(
      `SELECT workspace_id, chat_name, external_chat_id FROM dsh_superagent_bindings WHERE external_chat_id = 'oc_dm'`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ workspace_id: 'w2', chat_name: '私聊', external_chat_id: 'oc_dm' })

    const again = await intake(deps(spy.brain), channel, { ...dm, messageId: 'om_dm_2', thread: 'om_dm_2' })
    expect(again.action).toBe('accepted')
    expect(
      (await db.query(`SELECT id FROM dsh_superagent_bindings WHERE external_chat_id = 'oc_dm'`)).rows,
    ).toHaveLength(1)
  })

  it('私聊回复不带话题标记；群里回复照旧进话题', async () => {
    await model()
    const { channel } = await env()
    await intake(
      deps(brainWith(accepted).brain),
      channel,
      message({ conversation: 'oc_dm', thread: 'om_dm', direct: true, messageId: 'om_dm' }),
    )
    expect((await outboxBodies())[0]).toMatchObject({ replyInThread: false })
    await intake(deps(brainWith(accepted).brain), channel, message({ messageId: 'om_2' }))
    expect('replyInThread' in (await outboxBodies())[1]!).toBe(false)
  })

  it('没有可用工作区：说明原因，不落消息', async () => {
    await db.query(`DELETE FROM dsh_workspaces`)
    // 没有工作区就绑不了群，这里只建渠道。
    const created = await createChannel(db, key, 'u1', {
      provider: 'feishu',
      name: '我的机器人',
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'shh',
    })
    const channel: ChannelHandle = { id: created.id, userId: 'u1', provider: 'feishu' }
    const spy = brainWith(accepted)
    const result = await intake(deps(spy.brain), channel, message({ conversation: 'oc_dm', direct: true }))
    expect(result.action).toBe('no-workspace')
    expect(spy.calls).toHaveLength(0)
    expect(await counts()).toEqual({ tickets: 0, messages: 0 })
    expect((await outbox())[0]).toMatchObject({
      kind: 'reply',
      text: '你还没有可用的工作区。先在平台里建一个工作区，我才能在私聊里接活。',
    })
    // 没有绑定时也不该凭空建一条。
    expect((await db.query(`SELECT id FROM dsh_superagent_bindings`)).rows).toHaveLength(0)
  })
})

describe('群里没对机器人说', () => {
  it('记一笔但不吭声，也不打扰模型', async () => {
    const { channel } = await env()
    const spy = brainWith(accepted)
    const result = await intake(deps(spy.brain), channel, message({ addressed: false }))
    expect(result.action).toBe('not-addressed')
    expect(spy.calls).toHaveLength(0)
    expect(await outbox()).toEqual([])
    expect(await counts()).toEqual({ tickets: 0, messages: 1 })
  })

  it('同一话题里已有工单，后续没 @ 的消息也不处理', async () => {
    await model()
    const { channel, binding } = await env()
    await createTicket(db, {
      userId: 'u1',
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w1',
      threadKey: 'oc_1:om_1',
      title: '上一单',
      scope: 's',
      reason: 'r',
      intentEvidence: 'e',
      rules: ['r1'],
      autoMerge: false,
    })
    const spy = brainWith({ kind: 'ignore' })
    const result = await intake(deps(spy.brain), channel, message({ messageId: 'om_2', thread: 'om_1', addressed: false }))
    // 不再按「同话题」推断；只有点名或私聊才算对它说的。
    expect(result.action).toBe('not-addressed')
    expect(spy.calls).toHaveLength(0)
    expect(await counts()).toEqual({ tickets: 1, messages: 1 })
  })
})

describe('不接活时也要说话', () => {
  it('没配模型：说明判断不了，不瞎猜', async () => {
    const { channel } = await env()
    const spy = brainWith(accepted)
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('unavailable')
    expect(spy.calls).toHaveLength(0)
    expect((await outbox())[0]).toMatchObject({ kind: 'decline', text: '我还没配置模型，暂时判断不了这条要不要做。' })
  })

  it('模型说判断不了：一样回一句', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ kind: 'unavailable', reason: { code: 'timeout' } })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('unavailable')
    expect(await outbox()).toHaveLength(1)
    expect(await counts()).toEqual({ tickets: 0, messages: 1 })
  })

  it('模型说停下：把理由带回群里', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ kind: 'stop', reason: '这条不归我做' })
    expect((await intake(deps(spy.brain), channel, message())).action).toBe('stopped')
    expect((await outbox())[0]?.text).toBe('这条不归我做')
  })
})

describe('接单', () => {
  it('建工单、回确认，并把启用中的规则交给模型', async () => {
    await model()
    const { channel, binding } = await env()
    await updateBinding(db, 'u1', binding.id, {
      policy: {
        rules: [
          { id: 'r1', enabled: true, instruction: '前端改动可以接' },
          { id: 'r2', enabled: false, instruction: '数据库不要动' },
        ],
      },
    })
    const spy = brainWith({ ...accepted, acknowledgement: '收到，马上看。' })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('accepted')
    expect(await counts()).toEqual({ tickets: 1, messages: 1 })
    const ack = (await outbox())[0]
    expect(ack?.kind).toBe('ack')
    expect(ack?.text).toContain('收到，马上看。')
    // 接单是确定性事实：平台固定补上工单号，不指望模型提到。
    expect(ack?.text).toContain('已接单：修登录页（工单 #')

    const sent = spy.calls[0]?.body
    expect(sent?.strength).toBe('explicit')
    // 禁用的规则不下发，模型引用不到。
    expect(sent?.policy.rules).toEqual([{ id: 'r1', enabled: true, instruction: '前端改动可以接' }])
    // 触发消息带发言人，模型才知道是谁说的。
    expect(sent?.triggers).toEqual([{ id: expect.any(String), text: '[小明] 把登录页修一下' }])
  })

  it('模型没给确认语时用默认说法', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith(accepted)
    await intake(deps(spy.brain), channel, message())
    const text = (await outbox())[0]?.text ?? ''
    expect(text).toContain('收到，我开工了：修登录页。')
    expect(text).toContain('已接单：修登录页（工单 #')
  })

  it('同一话题的工单没做完时不开新单，但会说明', async () => {
    await model()
    const { channel, binding } = await env()
    await createTicket(db, {
      userId: 'u1',
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w1',
      threadKey: 'oc_1:om_1',
      title: '正在做的单',
      scope: 's',
      reason: 'r',
      intentEvidence: 'e',
      rules: ['r1'],
      autoMerge: false,
    })
    const spy = brainWith(accepted)
    const result = await intake(deps(spy.brain), channel, message({ messageId: 'om_2', thread: 'om_1' }))
    expect(result.action).toBe('busy')
    expect(await counts()).toEqual({ tickets: 1, messages: 1 })
    expect((await outbox())[0]?.text).toContain('当前工单「正在做的单」还没做完')
  })
})

describe('默认接单范围', () => {
  it('没配规则时下发默认开发范围，常规开发请求照常接单', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ ...accepted, rules: ['default'] })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('accepted')
    // 一条规则都没配，也得给模型一条能引用、能落到工单上的范围。
    expect(spy.calls[0]?.body.policy.rules).toEqual([
      { id: 'default', enabled: true, instruction: expect.stringContaining('常规软件开发请求') },
    ])
    const rows = await db.query(`SELECT rules FROM dsh_superagent_tickets`)
    const raw = rows.rows[0]?.rules
    expect(typeof raw === 'string' ? JSON.parse(raw) : raw).toEqual(['default'])
  })

  it('规则配了但全被禁用：不再兜底，模型只能拒绝', async () => {
    await model()
    const { channel } = await env({ rules: [{ id: 'r1', enabled: false, instruction: '数据库不要动' }] })
    const spy = brainWith({ kind: 'ignore', reason: '没有启用中的规则', reply: '这个群现在没有能接的范围。' })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('ignored')
    expect(spy.calls[0]?.body.policy.rules).toEqual([])
  })

  it('部署配了默认规则：绑定没配就用部署的，模型引用得到', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ ...accepted, rules: ['cfg1'] })
    const result = await intake(
      deps(spy.brain, { rules: ['只接前端相关的改动'] }),
      channel,
      message(),
    )
    expect(result.action).toBe('accepted')
    expect(spy.calls[0]?.body.policy.rules).toEqual([
      { id: 'cfg1', enabled: true, instruction: '只接前端相关的改动' },
    ])
    const rows = await db.query(`SELECT rules FROM dsh_superagent_tickets`)
    const raw = rows.rows[0]?.rules
    expect(typeof raw === 'string' ? JSON.parse(raw) : raw).toEqual(['cfg1'])
  })

  it('绑定自己配了规则时，部署默认规则不插手', async () => {
    await model()
    const { channel } = await env({ rules: [{ id: 'r1', enabled: true, instruction: '这个群只接前端' }] })
    const spy = brainWith(accepted)
    await intake(deps(spy.brain, { rules: ['部署默认规则'] }), channel, message())
    expect(spy.calls[0]?.body.policy.rules).toEqual([
      { id: 'r1', enabled: true, instruction: '这个群只接前端' },
    ])
  })
})

describe('去重与静默', () => {
  it('同一条消息重投只处理一次', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith(accepted)
    expect((await intake(deps(spy.brain), channel, message())).action).toBe('accepted')
    expect((await intake(deps(spy.brain), channel, message())).action).toBe('duplicate')
    expect(spy.calls).toHaveLength(1)
    expect(await outbox()).toHaveLength(1)
  })

  it('模型判定不是活：也回一句，用模型给的话', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ kind: 'ignore', reason: '群里在闲聊', reply: '在的，有活直接说。' })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('ignored')
    expect(await outbox()).toEqual([expect.objectContaining({ kind: 'reply', text: '在的，有活直接说。' })])
    // 判成闲聊也要落库，方便回查。
    expect(await counts()).toEqual({ tickets: 0, messages: 1 })
  })

  it('模型没给回复文本时用兜底话术，仍然不静默', async () => {
    await model()
    const { channel } = await env()
    const spy = brainWith({ kind: 'ignore', reason: '群里在闲聊' })
    const result = await intake(deps(spy.brain), channel, message())
    expect(result.action).toBe('ignored')
    expect((await outbox())[0]?.text).toContain('这条我看到了')
  })
})

describe('先回表情', () => {
  it('新的点名消息先确认，再交给模型', async () => {
    await model()
    const { channel } = await env()
    const order: string[] = []
    const brain = {
      evaluate: async () => {
        order.push('brain')
        return { ok: true as const, value: { outcome: accepted } }
      },
    } as unknown as BrainClient
    const result = await intake(
      {
        db,
        credentialsKey: key,
        brain,
        acknowledge: async (_channel, event) => {
          order.push('ack:' + event.messageId)
        },
      },
      channel,
      message(),
    )
    expect(result.action).toBe('accepted')
    expect(order).toEqual(['ack:om_1', 'brain'])
  })

  it('不是对它说的、重复投递、贴表情失败都不影响正事', async () => {
    const { channel } = await env()
    const acks: string[] = []
    const ack = async (_channel: ChannelHandle, event: InboundEvent): Promise<void> => {
      acks.push(event.messageId)
    }
    const base = { db, credentialsKey: key, brain: brainWith(accepted).brain, acknowledge: ack }
    await intake(base, channel, message({ messageId: 'om_other', addressed: false }))
    expect(acks).toEqual([])

    await intake(base, channel, message())
    await intake(base, channel, message())
    expect(acks).toEqual(['om_1'])

    const failing = {
      db,
      credentialsKey: key,
      brain: brainWith(accepted).brain,
      acknowledge: async () => {
        throw new Error('reaction forbidden')
      },
    }
    expect((await intake(failing, channel, message({ messageId: 'om_2' }))).action).toBe('unavailable')
  })
})

describe('话题键', () => {
  it('同一条根消息下的回复落到同一个键', () => {
    expect(threadKeyOf(message({ thread: 'om_1' }))).toBe('oc_1:om_1')
    expect(threadKeyOf(message({ messageId: 'om_2', thread: 'om_1' }))).toBe('oc_1:om_1')
  })
})
