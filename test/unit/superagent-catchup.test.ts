import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainClient } from '../../src/brain/client.js'
import type { ChannelHandle } from '../../src/modules/superagent/channel.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  catchUpAll,
  catchUpChannel,
  catchupStart,
  CATCHUP_MAX_BACKFILL_MS,
  CATCHUP_OVERLAP_MS,
  type FeishuApiFactory,
} from '../../src/modules/superagent/catchup.js'
import {
  parseMessageRecord,
  type FeishuApi,
  type FeishuMessageRecord,
} from '../../src/modules/superagent/feishu.js'
import type { IntakeDeps } from '../../src/modules/superagent/intake.js'
import { createProvider } from '../../src/modules/models/service.js'
import {
  createBinding,
  createChannel,
  listChannels,
  type BindingView,
} from '../../src/modules/superagent/store.js'

/**
 * 漏消息补偿：长连接漏掉的从会话历史里补回来，重复拉到不再处理。
 * 这里用真实 SQLite 跑完整链路，飞书接口换成假的。
 */

let dir: string
let db: SqliteDb
const key = randomBytes(32)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-catchup-'))
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

const accepted = {
  kind: 'accept',
  title: '修登录页',
  scope: '只改登录页',
  reason: '明确要求',
  intentEvidence: '「把登录页修一下」',
  rules: ['r1'],
}

function brainWith(outcome: unknown): BrainClient {
  return {
    evaluate: async () => ({ ok: true as const, value: { outcome } }),
  } as unknown as BrainClient
}

function deps(brain: BrainClient = brainWith(accepted)): IntakeDeps {
  return { db, credentialsKey: key, brain }
}

async function model(): Promise<void> {
  await createProvider(db, key, 'u1', {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-user-key',
    modelIds: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
  })
}

interface Env {
  channel: ChannelHandle
  binding: BindingView
}

/** 一条渠道 + 一个绑定；绑定时间倒回一小时，测试里的「漏消息」才落得进去。 */
async function env(options: { chatId?: string; chatName?: string; appId?: string } = {}): Promise<Env> {
  const channel = await createChannel(db, key, 'u1', {
    provider: 'feishu',
    name: '我的机器人',
    appId: options.appId ?? 'cli_a1b2c3d4e5f60718',
    appSecret: 'shh',
  })
  const binding = await createBinding(db, 'u1', {
    channelId: channel.id,
    workspaceId: 'w1',
    externalChatId: options.chatId ?? 'oc_1',
    ...(options.chatName === undefined ? {} : { chatName: options.chatName }),
  })
  await db.query(`UPDATE dsh_superagent_bindings SET created_at = $1 WHERE id = $2`, [
    new Date(Date.now() - 60 * 60_000).toISOString(),
    binding.id,
  ])
  return { channel: { id: channel.id, userId: 'u1', provider: 'feishu' }, binding }
}

interface FakeApiOptions {
  direct?: Record<string, boolean>
  botOpenId?: string
  onList?: (chatId: string) => void
}

function fakeApi(messages: Record<string, FeishuMessageRecord[]>, options: FakeApiOptions = {}): FeishuApi {
  return {
    botOpenId: async () => options.botOpenId ?? 'ou_bot',
    isDirectChat: async (chatId) => options.direct?.[chatId],
    listMessages: async (chatId) => {
      options.onList?.(chatId)
      return messages[chatId] ?? []
    },
  }
}

function message(overrides: Partial<FeishuMessageRecord> = {}): FeishuMessageRecord {
  return {
    message_id: 'om_missed',
    chat_id: 'oc_1',
    msg_type: 'text',
    create_time: String(Date.now() - 60_000),
    body: { content: JSON.stringify({ text: '@_user_1 把登录页修一下' }) },
    sender: { id: 'ou_a', sender_type: 'user' },
    mentions: [{ key: '@_user_1', name: '机器人', id: { open_id: 'ou_bot' } }],
    ...overrides,
  }
}

async function counts(): Promise<{ messages: number; tickets: number; outbox: number }> {
  const [messages, tickets, outbox] = await Promise.all([
    db.query(`SELECT count(*) AS n FROM dsh_superagent_messages`),
    db.query(`SELECT count(*) AS n FROM dsh_superagent_tickets`),
    db.query(`SELECT count(*) AS n FROM dsh_superagent_outbox`),
  ])
  return {
    messages: Number(messages.rows[0]?.n),
    tickets: Number(tickets.rows[0]?.n),
    outbox: Number(outbox.rows[0]?.n),
  }
}

async function outboxBodies(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.query(`SELECT body FROM dsh_superagent_outbox ORDER BY created_at, id`)
  return rows.rows.map((row) => (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Record<string, unknown>)
}

describe('历史消息解析', () => {
  it('用户消息转成事件，@ 占位换成名字', () => {
    const event = parseMessageRecord(message(), { chatId: 'oc_1', direct: false, botOpenId: 'ou_bot' })
    expect(event).toMatchObject({
      chatId: 'oc_1',
      direct: false,
      messageId: 'om_missed',
      senderId: 'ou_a',
      text: '@机器人 把登录页修一下',
      mentioned: true,
    })
  })

  it('机器人自己发的、已删除的、没有文本的都不处理', () => {
    expect(
      parseMessageRecord(message({ sender: { id: 'cli_x', sender_type: 'app' } }), { chatId: 'oc_1', direct: false }),
    ).toBeUndefined()
    expect(parseMessageRecord(message({ deleted: true }), { chatId: 'oc_1', direct: false })).toBeUndefined()
    expect(
      parseMessageRecord(
        message({ msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_v2_x' }) } }),
        { chatId: 'oc_1', direct: false },
      ),
    ).toBeUndefined()
  })

  it('单聊里没 @ 也算点名', () => {
    const event = parseMessageRecord(message({ mentions: [] }), { chatId: 'oc_dm', direct: true })
    expect(event).toMatchObject({ direct: true, mentioned: true })
  })
})

describe('补漏起点', () => {
  const now = Date.parse('2026-11-20T12:00:00.000Z')
  const created = new Date(now - 2 * 60 * 60_000).toISOString()

  it('有水位线时往前留重叠，重复拉到由去重兜住', () => {
    const last = new Date(now - 10 * 60_000).toISOString()
    expect(catchupStart(created, last, now)).toBe(now - 10 * 60_000 - CATCHUP_OVERLAP_MS)
  })

  it('水位线太旧时最多补最后半小时', () => {
    const last = new Date(now - 3 * 60 * 60_000).toISOString()
    expect(catchupStart(created, last, now)).toBe(now - CATCHUP_MAX_BACKFILL_MS)
  })

  it('没有水位线只补冷启动窗口，不会翻出绑定前的历史', () => {
    expect(catchupStart(created, undefined, now)).toBe(now - 5 * 60_000)
    const fresh = new Date(now - 60_000).toISOString()
    expect(catchupStart(fresh, undefined, now)).toBe(now - 60_000)
  })
})

describe('补一条渠道', () => {
  it('长连接漏掉的消息补回来，照常接单并回信', async () => {
    await model()
    const { channel, binding } = await env()
    const api = fakeApi({ oc_1: [message()] })

    const handled = await catchUpChannel(deps(), channel, api)
    expect(handled).toBe(1)
    expect(await counts()).toEqual({ messages: 1, tickets: 1, outbox: 1 })
    const ack = (await outboxBodies())[0]
    expect(ack?.text).toContain('收到，我开工了：修登录页。')
    // 接单是确定性事实：平台固定附上工单号。
    expect(ack?.text).toContain('已接单：修登录页（工单 #')

    const again = await catchUpChannel(deps(), channel, api)
    expect(again).toBe(0)
    expect(await counts()).toEqual({ messages: 1, tickets: 1, outbox: 1 })
    // 绑定还在，重复拉到同一条不会产生第二张单。
    expect(binding.externalChatId).toBe('oc_1')
  })

  it('机器人自己的消息和已删除的消息不落库', async () => {
    await model()
    const { channel } = await env()
    const api = fakeApi({
      oc_1: [
        message({ message_id: 'om_app', sender: { id: 'cli_x', sender_type: 'app' } }),
        message({ message_id: 'om_deleted', deleted: true }),
      ],
    })
    expect(await catchUpChannel(deps(), channel, api)).toBe(0)
    expect(await counts()).toEqual({ messages: 0, tickets: 0, outbox: 0 })
  })

  it('私聊拿不到会话信息时按绑定名兜底，回复不进话题', async () => {
    await model()
    const { channel } = await env({ chatId: 'oc_dm', chatName: '私聊' })
    const api = fakeApi({
      oc_dm: [
        message({
          chat_id: 'oc_dm',
          body: { content: JSON.stringify({ text: '把登录页修一下' }) },
          mentions: [],
        }),
      ],
    })
    expect(await catchUpChannel(deps(), channel, api)).toBe(1)
    expect((await outboxBodies())[0]).toMatchObject({ replyInThread: false })
  })

  it('拉历史失败只记渠道健康状态，不抛给调用方', async () => {
    const { channel } = await env()
    const failing: FeishuApi = {
      botOpenId: async () => 'ou_bot',
      isDirectChat: async () => false,
      listMessages: async () => {
        throw new Error('403 missing scope')
      },
    }
    await catchUpAll(deps(), { apiFor: () => failing, isLive: () => true })
    const channels = await listChannels(db, 'u1')
    expect(channels[0]?.lastError).toContain('403 missing scope')
    expect(channel.id).toBe(channels[0]?.id)
  })

  it('渠道没连着长连接就不拉历史', async () => {
    const { channel } = await env()
    let built = 0
    const factory: FeishuApiFactory = () => {
      built += 1
      return fakeApi({ oc_1: [message()] })
    }
    await catchUpAll(deps(), { apiFor: factory, isLive: () => false })
    expect(built).toBe(0)
    expect(await counts()).toEqual({ messages: 0, tickets: 0, outbox: 0 })
    // 渠道确实存在，只是不在线。
    expect((await listChannels(db, 'u1'))[0]?.id).toBe(channel.id)
  })

  it('GitHub 渠道不参与补漏，重投交给 webhook', async () => {
    const created = await createChannel(db, key, 'u1', {
      provider: 'github',
      name: '我的仓库',
      appId: 'gh_1',
      appSecret: 'shh',
    })
    await createBinding(db, 'u1', { channelId: created.id, workspaceId: 'w1', externalChatId: 'acme/web' })
    let built = 0
    const factory: FeishuApiFactory = () => {
      built += 1
      return fakeApi({ 'acme/web': [message({ chat_id: 'acme/web' })] })
    }
    await catchUpAll(deps(), { apiFor: factory, isLive: () => true })
    // 飞书才需要拉历史；GitHub 的补投由 webhook 自己重试。
    expect(built).toBe(0)
    expect(await counts()).toEqual({ messages: 0, tickets: 0, outbox: 0 })
  })
})