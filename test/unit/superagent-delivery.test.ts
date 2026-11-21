import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Deps } from '../../src/app/deps.js'
import type { BrainClient } from '../../src/brain/client.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { Channels } from '../../src/modules/superagent/connector.js'
import { deliverOutbox } from '../../src/modules/superagent/delivery.js'
import { FeishuAdapter, type FeishuHooks, type FeishuPort } from '../../src/modules/superagent/feishu.js'
import { createBinding, createChannel, enqueueOutbox, updateChannel } from '../../src/modules/superagent/store.js'

/**
 * 渠道连接与回信投递：连几条由数据库决定；回信发不出去不丢、不空转。
 */

let dir: string
let db: SqliteDb
const key = randomBytes(32)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-delivery-'))
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

/** 只带测试用到的那几样；渠道层不碰对象存储和配置。 */
function deps(brain?: BrainClient): Deps {
  return {
    db,
    credentialsKey: key,
    brain: brain ?? ({ evaluate: async () => ({ ok: true, value: { outcome: { kind: 'ignore' } } }) } as unknown as BrainClient),
  } as unknown as Deps
}

async function channel(appId = 'cli_a1b2c3d4e5f60718'): Promise<string> {
  const created = await createChannel(db, key, 'u1', {
    provider: 'feishu',
    name: '我的机器人',
    appId,
    appSecret: 'shh',
  })
  return created.id
}

interface FakePort extends FeishuPort {
  hooks: FeishuHooks
  replies: Array<{ messageId: string; text: string; uuid: string; options?: { thread?: boolean } }>
  reactions: Array<{ messageId: string; emoji: string }>
  started: boolean
  stopped: boolean
  failStart?: string
  failReply?: string
}

function fakePort(hooks: FeishuHooks): FakePort {
  const port: FakePort = {
    hooks,
    replies: [],
    reactions: [],
    started: false,
    stopped: false,
    start: async () => {
      if (port.failStart !== undefined) throw new Error(port.failStart)
      port.started = true
    },
    stop: () => {
      port.stopped = true
    },
    react: async (messageId, emoji) => {
      port.reactions.push({ messageId, emoji })
    },
    reply: async (messageId, text, uuid, options) => {
      if (port.failReply !== undefined) throw new Error(port.failReply)
      port.replies.push({ messageId, text, uuid, options })
    },
  }
  return port
}

/** 用假飞书连接搭一套渠道表；`ports` 按 appId 留引用，测试直接断言。 */
function hub(ports: Map<string, FakePort> = new Map()): Channels {
  return new Channels(deps(), [
    new FeishuAdapter((credential, hooks) => {
      const port = fakePort(hooks)
      ports.set(credential.appId, port)
      return port
    }),
  ])
}

describe('渠道连接', () => {
  it('只给主动状态的渠道起连接，停用后断掉', async () => {
    const id = await channel()
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)

    await channels.sync()
    expect(await channels.live(id)).toBe(true)
    expect(ports.get('cli_a1b2c3d4e5f60718')?.started).toBe(true)

    await updateChannel(db, key, 'u1', id, { status: 'disabled' })
    await channels.sync()
    expect(await channels.live(id)).toBe(false)
    expect(ports.get('cli_a1b2c3d4e5f60718')?.stopped).toBe(true)
  })

  it('重复 sync 不会给同一条渠道起第二条连接', async () => {
    await channel()
    let created = 0
    const channels = new Channels(deps(), [
      new FeishuAdapter((_credential, hooks) => {
        created += 1
        return fakePort(hooks)
      }),
    ])
    await Promise.all([channels.sync(), channels.sync(), channels.sync()])
    expect(created).toBe(1)
  })

  it('连接失败把原因记在渠道上，供「集成」页显示', async () => {
    const id = await channel()
    const channels = new Channels(deps(), [
      new FeishuAdapter((_credential, hooks) => {
        const port = fakePort(hooks)
        port.failStart = 'secret 不对'
        return port
      }),
    ])
    await channels.sync()
    expect(await channels.live(id)).toBe(false)
    const row = await db.query(`SELECT last_error FROM dsh_superagent_channels WHERE id = $1`, [id])
    expect(row.rows[0]?.last_error).toBe('secret 不对')
  })

  it('渠道事件交给 intake；处理出错也不影响连接状态', async () => {
    const channelId = await channel()
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    const port = ports.get('cli_a1b2c3d4e5f60718') as FakePort
    // 直接用钩子模拟 SDK 送到一条消息；没有绑定，intake 静默结束。
    await port.hooks.onEvent({
      chatId: 'oc_1',
      direct: false,
      messageId: 'om_1',
      senderId: 'ou_a',
      senderName: '小明',
      text: '修一下',
      mentioned: true,
      at: new Date().toISOString(),
    })
    const messages = await db.query(`SELECT count(*) AS n FROM dsh_superagent_messages`)
    expect(Number(messages.rows[0]?.n)).toBe(0)
    expect(await db.query(`SELECT last_error FROM dsh_superagent_channels WHERE id = $1`, [channelId])).toMatchObject({
      rows: [{ last_error: null }],
    })
  })

  it('被点名的消息先贴表情；没点名和重复投递的不贴', async () => {
    const channelId = await channel()
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    await createBinding(db, 'u1', { channelId, workspaceId: 'w1', externalChatId: 'oc_1' })
    const port = ports.get('cli_a1b2c3d4e5f60718') as FakePort
    const event = {
      chatId: 'oc_1',
      direct: false,
      messageId: 'om_1',
      senderId: 'ou_a',
      senderName: '小明',
      text: '修一下',
      mentioned: true,
      at: new Date().toISOString(),
    }
    await port.hooks.onEvent(event)
    // 没配模型也会先贴：表情发生在判断之前。
    expect(port.reactions).toEqual([{ messageId: 'om_1', emoji: 'THUMBSUP' }])

    await port.hooks.onEvent(event)
    expect(port.reactions).toHaveLength(1)

    await port.hooks.onEvent({ ...event, messageId: 'om_2', mentioned: false })
    expect(port.reactions).toHaveLength(1)
  })

  it('还没接适配器的渠道（GitHub）不影响飞书同步，也发不出信', async () => {
    await channel()
    const github = await createChannel(db, key, 'u1', {
      provider: 'github',
      name: '我的仓库',
      appId: 'gh_1',
      appSecret: 'shh',
    })
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)

    await channels.sync()
    // 飞书照常起连接；GitHub 没有适配器，被跳过。
    expect(ports.size).toBe(1)
    await expect(
      channels.reply(github.id, { conversation: 'acme/web', thread: '12', inThread: true }, '稍等', 'k1'),
    ).resolves.toBe('offline')
  })
})

describe('回信投递', () => {
  it('渠道在线时按话题回复，同一 uuid 让飞书去重', async () => {
    const channelId = await channel()
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_root',
      kind: 'ack',
      text: '收到，开工。',
    })

    const sent = await deliverOutbox(deps(), channels, 'owner-1')
    expect(sent).toBe(1)
    const port = ports.get('cli_a1b2c3d4e5f60718') as FakePort
    expect(port.replies).toHaveLength(1)
    expect(port.replies[0]).toMatchObject({ messageId: 'om_root', text: '收到，开工。' })

    const row = await db.query(`SELECT status FROM dsh_superagent_outbox`)
    expect(row.rows[0]?.status).toBe('sent')
  })

  it('单聊回信不进话题，群里的回信照旧进话题', async () => {
    const channelId = await channel()
    const ports = new Map<string, FakePort>()
    const channels = hub(ports)
    await channels.sync()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_dm',
      threadRootId: 'om_dm',
      kind: 'reply',
      text: '在呢。',
      replyInThread: false,
    })
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_root',
      kind: 'ack',
      text: '收到。',
    })

    expect(await deliverOutbox(deps(), channels, 'owner-1')).toBe(2)
    const port = ports.get('cli_a1b2c3d4e5f60718') as FakePort
    expect(port.replies[0]?.options).toEqual({ thread: false })
    expect(port.replies[1]?.options).toEqual({ thread: true })
  })

  it('渠道不在线时放回队列，不算失败', async () => {
    const channelId = await channel()
    const channels = hub() // 没 sync，等于连接没连上
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_root',
      kind: 'reply',
      text: '稍等。',
    })

    expect(await deliverOutbox(deps(), channels, 'owner-1')).toBe(0)
    const row = await db.query(`SELECT status, attempt_count, next_attempt_at FROM dsh_superagent_outbox`)
    expect(row.rows[0]?.status).toBe('pending')
    // 认领时加的一次被退回，渠道连上后不会因为「重试太多次」直接放弃。
    expect(Number(row.rows[0]?.attempt_count)).toBe(0)
    expect(await db.query(`SELECT count(*) AS n FROM dsh_superagent_outbox WHERE next_attempt_at > now()`)).toMatchObject({
      rows: [{ n: 1 }],
    })
  })

  it('发送失败按退避重试，超过上限标记 dead', async () => {
    const channelId = await channel()
    const channels = new Channels(deps(), [
      new FeishuAdapter((_credential, hooks) => {
        const port = fakePort(hooks)
        port.failReply = '群不存在'
        return port
      }),
    ])
    await channels.sync()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_root',
      kind: 'reply',
      text: '稍等。',
    })

    await deliverOutbox(deps(), channels, 'owner-1')
    let row = await db.query(`SELECT status, attempt_count, last_error FROM dsh_superagent_outbox`)
    expect(row.rows[0]?.status).toBe('failed')
    expect(Number(row.rows[0]?.attempt_count)).toBe(1)
    expect(row.rows[0]?.last_error).toBe('群不存在')

    // 把下次重试时间拨到现在，再失败几次。
    for (let i = 0; i < 4; i += 1) {
      await db.query(`UPDATE dsh_superagent_outbox SET next_attempt_at = now()`)
      await deliverOutbox(deps(), channels, 'owner-1')
    }
    row = await db.query(`SELECT status, attempt_count FROM dsh_superagent_outbox`)
    expect(row.rows[0]?.status).toBe('dead')
    expect(Number(row.rows[0]?.attempt_count)).toBe(5)
  })

  it('没有话题根消息的回信不会无限重试', async () => {
    const channelId = await channel()
    const channels = hub()
    await channels.sync()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      kind: 'reply',
      text: '不知道回哪儿。',
    })
    await deliverOutbox(deps(), channels, 'owner-1')
    const row = await db.query(`SELECT status, last_error FROM dsh_superagent_outbox`)
    expect(row.rows[0]).toMatchObject({ status: 'dead', last_error: 'missing-thread-root' })
  })

  it('目标已永久消失（消息被删 / issue 被锁）直接放弃，不再重试', async () => {
    const channelId = await channel()
    const channels = new Channels(deps(), [
      {
        provider: 'feishu',
        sync: async () => undefined,
        live: () => true,
        reply: async () => 'gone',
        stop: () => undefined,
      },
    ])
    await channels.sync()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_root',
      kind: 'reply',
      text: '稍等。',
    })

    expect(await deliverOutbox(deps(), channels, 'owner-1')).toBe(0)
    // 只发了一次就放弃，没有进入重试队列。
    const row = await db.query(`SELECT status, attempt_count, last_error FROM dsh_superagent_outbox`)
    expect(row.rows[0]).toMatchObject({ status: 'dead', last_error: 'gone' })
    expect(Number(row.rows[0]?.attempt_count)).toBe(1)
  })
})