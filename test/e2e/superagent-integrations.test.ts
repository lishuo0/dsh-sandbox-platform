import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrainClient } from '../../src/brain/client.js'
import { PLATFORM_COOKIE } from '../../src/client/surface.js'
import { signToken } from '../../src/kernel/tokens.js'
import { createProvider } from '../../src/modules/models/service.js'
import { catchUpChannel } from '../../src/modules/superagent/catchup.js'
import type { FeishuMessageRecord } from '../../src/modules/superagent/feishu.js'
import { intake } from '../../src/modules/superagent/intake.js'
import { createTicket } from '../../src/modules/superagent/store.js'
import { API, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 「集成」和「工单任务」两个页面的成员接口。
 *
 * 盯住三件事：飞书密钥只进不出；渠道 / 绑定 / 工单都按成员隔离；
 * 手动结束一张工单后，同一话题可以继续接活。
 */

interface Envelope {
  code: number
  msg: string
  data: unknown
}

let platform: TestPlatform
let adminId = ''
let adminCookie = ''
let otherCookie = ''
let otherId = ''

const CHANNEL = { name: '我的机器人', appId: 'cli_0123456789abcdef', appSecret: 'super-secret-value' }

beforeAll(async () => {
  platform = await startTestPlatform()
  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  adminId = admin.rows[0]?.id ?? ''
  if (!adminId) throw new Error('没有找到管理员')
  adminCookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, adminId, platform.config.auth.tokenTtlHours)}`

  otherId = 'e2e-other-member'
  otherCookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, otherId, platform.config.auth.tokenTtlHours)}`
  await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, $2, $3)`, [
    otherId,
    '别人',
    'not-a-real-hash',
  ])
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w_admin', $1, '前端', '/host/w_admin', '/guest/w_admin')`,
    [adminId],
  )
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w_other', $1, '别人的', '/host/w_other', '/guest/w_other')`,
    [otherId],
  )
})

afterAll(async () => {
  await platform.close()
})

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie = adminCookie,
): Promise<{ status: number; body: Envelope }> {
  const response = await fetch(`${platform.baseUrl}${API}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Envelope }
}

interface ChannelBody {
  id: string
  appId: string
  defaultRules: string[]
  status: string
  lastError?: string
}

interface ChannelInput extends Partial<typeof CHANNEL> {
  defaultRules?: string[]
}

interface BindingBody {
  id: string
  channelName: string
  workspaceName: string
  policyVersion: number
  policy: { repo?: string; autoMerge?: boolean; rules?: Array<{ id: string; enabled: boolean; instruction: string }> }
}

async function createChannel(overrides: ChannelInput = {}, cookie = adminCookie): Promise<ChannelBody> {
  const result = await call('POST', '/superagent/channels', { ...CHANNEL, ...overrides }, cookie)
  expect(result.status).toBe(201)
  return result.body.data as ChannelBody
}

async function createBinding(channelId: string, cookie = adminCookie, workspaceId = 'w_admin'): Promise<BindingBody> {
  const result = await call(
    'POST',
    '/superagent/bindings',
    {
      channelId,
      workspaceId,
      externalChatId: 'oc_1',
      chatName: '前端群',
      repo: 'acme/web',
      autoMerge: true,
      rules: ['前端改动可以接', { id: 'keep', enabled: false, instruction: '数据库不要动' }],
    },
    cookie,
  )
  expect(result.status).toBe(201)
  return result.body.data as BindingBody
}

describe('渠道', () => {
  it('新增后只回 App ID 和连接状态，密钥不出这个接口', async () => {
    const created = await createChannel()
    expect(created.appId).toBe(CHANNEL.appId)
    expect(JSON.stringify(created)).not.toContain(CHANNEL.appSecret)

    const listed = await call('GET', '/superagent/channels')
    expect(listed.status).toBe(200)
    const items = (listed.body.data as { items: ChannelBody[] }).items
    expect(items.map((item) => item.id)).toContain(created.id)
    expect(JSON.stringify(items)).not.toContain(CHANNEL.appSecret)
  })

  it('可以改名、停用，再启用', async () => {
    const created = await createChannel({ appId: 'cli_ffffffffffffffff' })
    const renamed = await call('PATCH', `/superagent/channels/${created.id}`, { name: '改名了', status: 'disabled' })
    expect(renamed.status).toBe(200)
    expect((renamed.body.data as { name: string; status: string }).name).toBe('改名了')
    expect((renamed.body.data as { status: string }).status).toBe('disabled')

    const enabled = await call('PATCH', `/superagent/channels/${created.id}`, { status: 'active', appSecret: '' })
    expect((enabled.body.data as { status: string }).status).toBe('active')
  })

  it('GitHub 凭证还没落地：建渠道直接拒绝，不会悄悄当成飞书', async () => {
    const result = await call('POST', '/superagent/channels', { ...CHANNEL, provider: 'github' })
    expect(result.status).toBe(422)
    expect(result.body.msg).toBe('provider-not-supported')
  })

  it('非飞书渠道列不出群，明确说这个渠道类型还不支持', async () => {
    await platform.db.query(
      `INSERT INTO dsh_superagent_channels (id, user_id, provider, name, app_id, secret_ciphertext)
       VALUES ('ch_gh_e2e', $1, 'github', '仓库', 'gh_e2e', $2)`,
      [adminId, Buffer.from([0])],
    )
    const result = await call('GET', '/superagent/channels/ch_gh_e2e/chats')
    expect(result.status).toBe(422)
    expect(result.body.msg).toBe('provider-not-supported')
  })
})

describe('绑定', () => {
  it('把群绑到自己的工作区，带上仓库、自动合并和规则', async () => {
    const channel = await createChannel({ appId: 'cli_1111111111111111' })
    const binding = await createBinding(channel.id)
    expect(binding.channelName).toBe(CHANNEL.name)
    expect(binding.workspaceName).toBe('前端')
    expect(binding.policy.repo).toBe('acme/web')
    expect(binding.policy.autoMerge).toBe(true)
    expect(binding.policy.rules).toEqual([
      { id: 'r1', enabled: true, instruction: '前端改动可以接' },
      { id: 'keep', enabled: false, instruction: '数据库不要动' },
    ])
  })

  it('改绑定会合并策略并升版本，清空仓库就真的没有仓库', async () => {
    const channel = await createChannel({ appId: 'cli_2222222222222222' })
    const binding = await createBinding(channel.id)
    const updated = await call('PATCH', `/superagent/bindings/${binding.id}`, {
      repo: '',
      rules: ['只接前端'],
    })
    expect(updated.status).toBe(200)
    const data = updated.body.data as BindingBody
    expect(data.policy.repo).toBeUndefined()
    expect(data.policy.autoMerge).toBe(true)
    expect(data.policy.rules).toEqual([{ id: 'r1', enabled: true, instruction: '只接前端' }])
    expect(data.policyVersion).toBe(binding.policyVersion + 1)
  })

  it('同一个群重复绑定直接拒绝', async () => {
    const channel = await createChannel({ appId: 'cli_3333333333333333' })
    await createBinding(channel.id)
    const again = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
      externalChatId: 'oc_1',
    })
    expect(again.status).toBe(409)
    expect(again.body.msg).toBe('binding-exists')
  })

  it('群 ID 不合法时不落库', async () => {
    const channel = await createChannel({ appId: 'cli_4444444444444444' })
    const noChat = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
    })
    expect(noChat.status).toBe(422)
  })
})

describe('机器人默认规则', () => {
  it('渠道能存默认规则；新建绑定没配就继承，换成自己的规则也不影响别的群', async () => {
    const channel = await createChannel({
      appId: 'cli_inherit_rules_e2e',
      defaultRules: ['前端改动可以接', '数据库迁移不要动'],
    })
    expect(channel).toMatchObject({
      defaultRules: ['前端改动可以接', '数据库迁移不要动'],
    })

    const listed = await call('GET', '/superagent/channels')
    expect((listed.body.data as { items: ChannelBody[] }).items.find((item) => item.id === channel.id)).toMatchObject({
      defaultRules: ['前端改动可以接', '数据库迁移不要动'],
    })

    // 不传规则：跟随机器人默认。
    const inherited = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
      externalChatId: 'oc_inherit_1',
    })
    expect(inherited.status).toBe(201)
    expect(inherited.body.data).toMatchObject({
      policy: {
        rules: [
          { id: 'r1', enabled: true, instruction: '前端改动可以接' },
          { id: 'r2', enabled: true, instruction: '数据库迁移不要动' },
        ],
      },
    })

    // 自己的规则优先。
    const explicit = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
      externalChatId: 'oc_inherit_2',
      rules: ['这个群只接后端'],
    })
    expect(explicit.status).toBe(201)
    expect(explicit.body.data).toMatchObject({
      policy: { rules: [{ id: 'r1', enabled: true, instruction: '这个群只接后端' }] },
    })

    // 清空规则 = 回到跟随机器人默认。
    const binding = inherited.body.data as BindingBody
    const cleared = await call('PATCH', `/superagent/bindings/${binding.id}`, { rules: [] })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data).toMatchObject({
      policy: {
        rules: [
          { id: 'r1', enabled: true, instruction: '前端改动可以接' },
          { id: 'r2', enabled: true, instruction: '数据库迁移不要动' },
        ],
      },
    })

    // 改机器人默认只影响以后新建的绑定。
    const changed = await call('PATCH', `/superagent/channels/${channel.id}`, { defaultRules: ['只接前端'] })
    expect(changed.status).toBe(200)
    expect((changed.body.data as ChannelBody).defaultRules).toEqual(['只接前端'])
    const reread = await call('GET', '/superagent/bindings')
    const kept = (reread.body.data as { items: BindingBody[] }).items.find((item) => item.id === binding.id)
    expect(kept?.policy.rules?.map((rule) => rule.instruction)).toEqual(['前端改动可以接', '数据库迁移不要动'])
  })

  it('默认规则写成非字符串数组时回 422，不落库', async () => {
    const bad = await call('POST', '/superagent/channels', {
      ...CHANNEL,
      appId: 'cli_bad_default_rules',
      defaultRules: '前端可以接',
    })
    expect(bad.status).toBe(422)
    expect(bad.body.msg).toBe('invalid-default-rules')
  })

  it('绑定和机器人都没配规则时，部署配置的默认规则交给模型', async () => {
    const channel = await createChannel({ appId: 'cli_deploy_defaults_e2e' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })

    let seenRules: unknown[] = []
    const brain = {
      evaluate: async (input: { body: { policy: { rules: unknown[] } } }) => {
        seenRules = input.body.policy.rules
        return {
          ok: true as const,
          value: {
            outcome: {
              kind: 'accept',
              title: '修登录页',
              scope: '只改登录页',
              reason: '明确要求',
              intentEvidence: '「修一下登录页」',
              rules: ['cfg1'],
            },
          },
        }
      },
    } as unknown as BrainClient

    const result = await intake(
      {
        db: platform.db,
        credentialsKey: key,
        brain,
        superagentDefaults: { rules: ['只接前端相关的改动'] },
      },
      { id: channel.id, userId: adminId, provider: 'feishu' },
      {
        provider: 'feishu',
        conversation: 'oc_deploy_defaults_e2e',
        thread: 'om_deploy_defaults_e2e',
        direct: true,
        messageId: 'om_deploy_defaults_e2e',
        senderId: 'ou_a',
        senderName: '小明',
        text: '修一下登录页',
        addressed: true,
        at: new Date().toISOString(),
      },
    )
    expect(result.action).toBe('accepted')
    expect(seenRules).toEqual([{ id: 'cfg1', enabled: true, instruction: '只接前端相关的改动' }])
  })
})

describe('工单', () => {
  it('列出自己的工单，并能手动结束', async () => {
    const channel = await createChannel({ appId: 'cli_5555555555555555' })
    const binding = await createBinding(channel.id)
    const ticket = await createTicket(platform.db, {
      userId: adminId,
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w_admin',
      threadKey: 'oc_1:om_9',
      title: '修登录页',
      scope: '只改登录页',
      reason: '明确要求',
      intentEvidence: '「把登录页修一下」',
      rules: ['r1'],
    })

    const listed = await call('GET', '/superagent/tickets')
    expect(listed.status).toBe(200)
    const items = (listed.body.data as { items: Array<{ id: string; chatName: string; workspaceName: string }> }).items
    const found = items.find((item) => item.id === ticket.id)
    expect(found).toMatchObject({ chatName: '前端群', workspaceName: '前端' })

    const closed = await call('POST', `/superagent/tickets/${ticket.id}/close`, { stage: 'done' })
    expect(closed.status).toBe(200)
    expect((closed.body.data as { stage: string }).stage).toBe('done')

    const again = await call('POST', `/superagent/tickets/${ticket.id}/close`, { stage: 'stopped' })
    expect(again.status).toBe(409)
    expect(again.body.msg).toBe('ticket-not-open')

    const done = await call('GET', '/superagent/tickets?stage=done')
    expect((done.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(ticket.id)
    const bad = await call('GET', '/superagent/tickets?stage=yolo')
    expect(bad.status).toBe(422)
  })

  it('停止正在跑的工单会先让脑停回合，再关单并在群里留一句说明', async () => {
    const channel = await createChannel({ appId: 'cli_6666666666666666' })
    const binding = await createBinding(channel.id)
    const ticket = await createTicket(platform.db, {
      userId: adminId,
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w_admin',
      threadKey: 'oc_1:om_10',
      title: '改首页',
      scope: '只改首页',
      reason: '明确要求',
      intentEvidence: '「把首页改一下」',
      rules: ['r1'],
    })
    await platform.db.query(
      `UPDATE dsh_superagent_tickets SET stage = 'working', session_id = 'sess-stop-1' WHERE id = $1`,
      [ticket.id],
    )

    const cancels: Array<{ userId: string; workspaceId: string; sessionId: string; requestId: string }> = []
    platform.deps.brain.cancel = (async (input: Parameters<BrainClient['cancel']>[0]) => {
      cancels.push({
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        requestId: input.requestId,
      })
      return { ok: true as const, value: { accepted: true } }
    }) as BrainClient['cancel']

    const stopped = await call('POST', `/superagent/tickets/${ticket.id}/close`, { stage: 'stopped' })
    expect(stopped.status).toBe(200)
    expect(cancels).toEqual([
      {
        userId: adminId,
        workspaceId: 'w_admin',
        sessionId: 'sess-stop-1',
        requestId: `ticket-stop.${ticket.id}`,
      },
    ])

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE thread_root_id = $1`,
      ['om_10'],
    )
    const body = outbox.rows[0]?.body
    const text = typeof body === 'string' ? (JSON.parse(body) as { text: string }).text : (body as { text: string }).text
    expect(text).toContain('改首页')
    expect(text).toContain('停下了')
  })

  it('已做完等确认的工单：停止不再打扰脑', async () => {
    const channel = await createChannel({ appId: 'cli_2020202020202020' })
    const binding = await createBinding(channel.id)
    const ticket = await createTicket(platform.db, {
      userId: adminId,
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w_admin',
      threadKey: 'oc_1:om_11',
      title: '改页脚',
      scope: '只改页脚',
      reason: '明确要求',
      intentEvidence: '「把页脚改一下」',
      rules: ['r1'],
    })
    await platform.db.query(
      `UPDATE dsh_superagent_tickets SET stage = 'review', session_id = 'sess-review-1' WHERE id = $1`,
      [ticket.id],
    )

    const cancels: string[] = []
    platform.deps.brain.cancel = (async (input: Parameters<BrainClient['cancel']>[0]) => {
      cancels.push(input.sessionId)
      return { ok: true as const, value: { accepted: true } }
    }) as BrainClient['cancel']

    const stopped = await call('POST', `/superagent/tickets/${ticket.id}/close`, { stage: 'stopped' })
    expect(stopped.status).toBe(200)
    expect((stopped.body.data as { stage: string }).stage).toBe('stopped')
    // 回合早就结束了，没有任何东西需要中止。
    expect(cancels).toEqual([])
  })

  it('脑取消失败也要把单关掉，不让成员被卡住', async () => {
    const channel = await createChannel({ appId: 'cli_3030303030303030' })
    const binding = await createBinding(channel.id)
    const ticket = await createTicket(platform.db, {
      userId: adminId,
      bindingId: binding.id,
      channelId: channel.id,
      workspaceId: 'w_admin',
      threadKey: 'oc_1:om_12',
      title: '改导航',
      scope: '只改导航',
      reason: '明确要求',
      intentEvidence: '「把导航改一下」',
      rules: ['r1'],
    })
    await platform.db.query(
      `UPDATE dsh_superagent_tickets SET stage = 'working', session_id = 'sess-stop-2' WHERE id = $1`,
      [ticket.id],
    )
    platform.deps.brain.cancel = (async () => {
      throw new Error('brain unreachable')
    }) as BrainClient['cancel']

    const stopped = await call('POST', `/superagent/tickets/${ticket.id}/close`, { stage: 'stopped' })
    expect(stopped.status).toBe(200)
    expect((stopped.body.data as { stage: string }).stage).toBe('stopped')
  })
})

describe('拉群列表', () => {
  it('用成员自己的机器人凭证拉群；别人的渠道拉不动', async () => {
    const mine = await createChannel({ appId: 'cli_aaaaaaaaaaaaaaaa' })
    const seen: string[] = []
    platform.deps.feishuChats = async (credential) => {
      seen.push(credential.appId)
      return [
        { id: 'oc_9', name: '前端群', mode: 'group' },
        { id: 'oc_10', name: '话题群', mode: 'topic' },
      ]
    }
    const ok = await call('GET', `/superagent/channels/${mine.id}/chats`)
    expect(ok.status).toBe(200)
    const items = (ok.body.data as { items: Array<{ id: string; name: string }> }).items
    expect(items.map((item) => item.id)).toEqual(['oc_9', 'oc_10'])
    expect(seen).toEqual(['cli_aaaaaaaaaaaaaaaa'])

    const foreign = await call('GET', `/superagent/channels/${mine.id}/chats`, undefined, otherCookie)
    expect(foreign.status).toBe(404)
    expect(foreign.body.msg).toBe('channel-not-found')
  })

  it('飞书没给权限时回可读错误，不是 500', async () => {
    const channel = await createChannel({ appId: 'cli_bbbbbbbbbbbbbbbb' })
    platform.deps.feishuChats = async () => {
      throw new Error('99991672: missing scope')
    }
    const failed = await call('GET', `/superagent/channels/${channel.id}/chats`)
    expect(failed.status).toBe(502)
    expect(failed.body.msg).toBe('feishu-chats-failed')
  })
})

describe('私聊', () => {
  it('不用手动绑定：直接落到成员的默认工作区，私聊回复不进话题', async () => {
    const channel = await createChannel({ appId: 'cli_cccccccccccccccc' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    const brain = {
      evaluate: async () => ({
        ok: true as const,
        value: {
          outcome: {
            kind: 'accept',
            title: '修登录页',
            scope: '只改登录页',
            reason: '明确要求',
            intentEvidence: '「修一下登录页」',
            rules: ['r1'],
          },
        },
      }),
    } as unknown as BrainClient

    const result = await intake({ db: platform.db, credentialsKey: key, brain }, { id: channel.id, userId: adminId, provider: 'feishu' }, {
      provider: 'feishu',
      conversation: 'oc_direct_e2e',
      thread: 'om_direct_e2e',
      direct: true,
      messageId: 'om_direct_e2e',
      senderId: 'ou_a',
      senderName: '小明',
      text: '修一下登录页',
      addressed: true,
      at: new Date().toISOString(),
    })
    expect(result.action).toBe('accepted')

    const binding = await platform.db.query<{ workspace_id: string; chat_name: string }>(
      `SELECT workspace_id, chat_name FROM dsh_superagent_bindings
        WHERE channel_id = $1 AND external_chat_id = $2`,
      [channel.id, 'oc_direct_e2e'],
    )
    expect(binding.rows[0]).toMatchObject({ workspace_id: 'w_admin', chat_name: '私聊' })

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    )
    const body = outbox.rows[0]?.body
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { replyInThread?: boolean }) : (body as { replyInThread?: boolean })
    expect(parsed.replyInThread).toBe(false)
  })

  it('私聊里判定「不是活」也要回一句：优先用模型给的回复', async () => {
    const channel = await createChannel({ appId: 'cli_dddddddddddddddd' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    const brain = {
      evaluate: async () => ({
        ok: true as const,
        value: {
          outcome: { kind: 'ignore', reason: 'greeting', reply: '在的，有什么要我做的直接说。' },
        },
      }),
    } as unknown as BrainClient

    const result = await intake({ db: platform.db, credentialsKey: key, brain }, { id: channel.id, userId: adminId, provider: 'feishu' }, {
      provider: 'feishu',
      conversation: 'oc_direct_ignore_e2e',
      thread: 'om_direct_ignore_e2e',
      direct: true,
      messageId: 'om_direct_ignore_e2e',
      senderId: 'ou_a',
      senderName: '小明',
      text: '你好',
      addressed: true,
      at: new Date().toISOString(),
    })
    expect(result.action).toBe('ignored')

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    )
    const body = outbox.rows[0]?.body
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { text: string; replyInThread?: boolean }) : (body as { text: string; replyInThread?: boolean })
    expect(parsed).toMatchObject({ text: '在的，有什么要我做的直接说。', replyInThread: false })
  })
})

describe('漏消息补偿', () => {
  it('长连接漏掉的消息从会话历史补回来，重复拉到不再回复', async () => {
    const channel = await createChannel({ appId: 'cli_eeeeeeeeeeeeeeee' })
    const binding = await createBinding(channel.id)
    // 绑定时间倒回一小时，「漏掉的消息」才落得进补漏窗口。
    await platform.db.query(`UPDATE dsh_superagent_bindings SET created_at = $1 WHERE id = $2`, [
      new Date(Date.now() - 60 * 60_000).toISOString(),
      binding.id,
    ])
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    const brain = {
      evaluate: async () => ({
        ok: true as const,
        value: {
          outcome: {
            kind: 'accept',
            title: '修登录页',
            scope: '只改登录页',
            reason: '明确要求',
            intentEvidence: '「把登录页修一下」',
            rules: ['r1'],
          },
        },
      }),
    } as unknown as BrainClient

    const record: FeishuMessageRecord = {
      message_id: 'om_catchup',
      chat_id: 'oc_1',
      msg_type: 'text',
      create_time: String(Date.now() - 30_000),
      body: { content: JSON.stringify({ text: '@_user_1 把登录页修一下' }) },
      sender: { id: 'ou_a', sender_type: 'user' },
      mentions: [{ key: '@_user_1', name: '机器人', id: { open_id: 'ou_bot' } }],
    }
    const windows: Array<{ startAt: string; endAt?: string }> = []
    const api = {
      botOpenId: async () => 'ou_bot',
      isDirectChat: async () => false,
      listMessages: async (_chatId: string, window: { startAt: string; endAt?: string }) => {
        windows.push(window)
        return [record]
      },
    }
    const deps = { db: platform.db, credentialsKey: key, brain }

    expect(await catchUpChannel(deps, { id: channel.id, userId: adminId, provider: 'feishu' }, api)).toBe(1)
    // 补漏只看这个绑定对应的群。
    expect(windows[0]?.startAt).toBeDefined()

    const stored = await platform.db.query<{ status: string }>(
      `SELECT status FROM dsh_superagent_messages WHERE channel_id = $1 AND external_message_id = 'om_catchup'`,
      [channel.id],
    )
    expect(stored.rows[0]?.status).toBe('accepted')

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    )
    const body = outbox.rows[0]?.body
    const text = typeof body === 'string' ? (JSON.parse(body) as { text: string }).text : (body as { text: string }).text
    expect(text).toContain('收到，我开工了：修登录页')

    // 下一轮再拉到同一条：去重后不再建单、不再回信。
    expect(await catchUpChannel(deps, { id: channel.id, userId: adminId, provider: 'feishu' }, api)).toBe(0)
    const tickets = await platform.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM dsh_superagent_tickets WHERE channel_id = $1`,
      [channel.id],
    )
    expect(Number(tickets.rows[0]?.n)).toBe(1)
    const replies = await platform.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM dsh_superagent_outbox WHERE channel_id = $1`,
      [channel.id],
    )
    expect(Number(replies.rows[0]?.n)).toBe(1)
  })
})

describe('先回表情', () => {
  it('收到消息先贴表情再判断，避免成员干等', async () => {
    const channel = await createChannel({ appId: 'cli_f0f0f0f0f0f0f0f0' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    const order: string[] = []
    const brain = {
      evaluate: async () => {
        order.push('brain')
        return {
          ok: true as const,
          value: { outcome: { kind: 'ignore', reason: 'greeting', reply: '在的，有活直接说。' } },
        }
      },
    } as unknown as BrainClient

    const result = await intake(
      {
        db: platform.db,
        credentialsKey: key,
        brain,
        acknowledge: async (_channel, event) => {
          order.push('ack:' + event.messageId)
        },
      },
      { id: channel.id, userId: adminId, provider: 'feishu' },
      {
        provider: 'feishu',
        conversation: 'oc_ack_e2e',
        thread: 'om_ack_e2e',
        direct: true,
        messageId: 'om_ack_e2e',
        senderId: 'ou_a',
        senderName: '小明',
        text: '在吗',
        addressed: true,
        at: new Date().toISOString(),
      },
    )
    expect(result.action).toBe('ignored')
    expect(order).toEqual(['ack:om_ack_e2e', 'brain'])

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    )
    const body = outbox.rows[0]?.body
    const text = typeof body === 'string' ? (JSON.parse(body) as { text: string }).text : (body as { text: string }).text
    expect(text).toBe('在的，有活直接说。')
  })
})

describe('默认接单范围', () => {
  it('新绑定的群没配规则，常规开发请求也能接单', async () => {
    const channel = await createChannel({ appId: 'cli_abababababababab' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    // 走页面接口建绑定，不勾任何规则。
    const created = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
      externalChatId: 'oc_default_rule_e2e',
      chatName: '开发群',
    })
    expect(created.status).toBe(201)

    const sent: Array<{ body: { policy: { rules: Array<{ id: string; instruction?: string }> } } }> = []
    const brain = {
      evaluate: async (input: { body: { policy: { rules: Array<{ id: string; instruction?: string }> } } }) => {
        sent.push(input)
        return {
          ok: true as const,
          value: {
            outcome: {
              kind: 'accept',
              title: '初始化 Go 项目',
              scope: '建一个 HTTP 服务并暴露 health 接口',
              reason: '明确要求',
              intentEvidence: '「帮我初始化一个go项目，创建一个http服务，并且写一个health接口」',
              rules: ['default'],
            },
          },
        }
      },
    } as unknown as BrainClient

    const result = await intake({ db: platform.db, credentialsKey: key, brain }, { id: channel.id, userId: adminId, provider: 'feishu' }, {
      provider: 'feishu',
      conversation: 'oc_default_rule_e2e',
      thread: 'om_default_rule_e2e',
      direct: false,
      messageId: 'om_default_rule_e2e',
      senderId: 'ou_a',
      senderName: '小明',
      text: '帮我初始化一个go项目，创建一个http服务，并且写一个health接口',
      addressed: true,
      at: new Date().toISOString(),
    })
    expect(result.action).toBe('accepted')
    // 没配规则时补一条默认范围，模型才有依据接活、工单也有可追溯的规则。
    expect(sent[0]?.body.policy.rules).toEqual([
      { id: 'default', enabled: true, instruction: expect.stringContaining('常规软件开发请求') },
    ])

    const ticket = await platform.db.query<{ title: string; rules: unknown }>(
      `SELECT title, rules FROM dsh_superagent_tickets WHERE channel_id = $1`,
      [channel.id],
    )
    expect(ticket.rows[0]?.title).toBe('初始化 Go 项目')
    const raw = ticket.rows[0]?.rules
    expect(typeof raw === 'string' ? (JSON.parse(raw) as string[]) : raw).toEqual(['default'])
  })
})

describe('点名是明确授权', () => {
  it('点名请求照常接单，模型不给规则也能接，回复固定写明接了工单', async () => {
    const channel = await createChannel({ appId: 'cli_aaaaaaaaaaaaaaa3' })
    const key = platform.deps.credentialsKey
    await createProvider(platform.db, key, adminId, {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-user-key',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    })
    const created = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_admin',
      externalChatId: 'oc_off_e2e',
    })
    expect(created.status).toBe(201)

    const brain = {
      evaluate: async () => ({
        ok: true as const,
        value: {
          outcome: {
            kind: 'accept',
            title: '修登录页',
            scope: '只改登录页',
            reason: '明确要求',
            intentEvidence: '「把登录页修一下」',
            // 点名是明确授权，模型可以不给规则。
            rules: [],
          },
        },
      }),
    } as unknown as BrainClient

    const result = await intake({ db: platform.db, credentialsKey: key, brain }, { id: channel.id, userId: adminId, provider: 'feishu' }, {
      provider: 'feishu',
      conversation: 'oc_off_e2e',
      thread: 'om_off_e2e',
      direct: false,
      messageId: 'om_off_e2e',
      senderId: 'ou_a',
      senderName: '小明',
      text: '把登录页修一下',
      addressed: true,
      at: new Date().toISOString(),
    })
    expect(result.action).toBe('accepted')

    const outbox = await platform.db.query<{ body: unknown }>(
      `SELECT body FROM dsh_superagent_outbox WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [channel.id],
    )
    const body = outbox.rows[0]?.body
    const text = typeof body === 'string' ? (JSON.parse(body) as { text: string }).text : (body as { text: string }).text
    expect(text).toContain('已接单：修登录页（工单 #')
  })
})

describe('按成员隔离', () => {
  it('别人的渠道、绑定、工单都看不到，也改不动', async () => {
    const foreign = await createChannel({ appId: 'cli_7777777777777777' }, otherCookie)
    const mine = await createChannel({ appId: 'cli_8888888888888888' })
    const listed = await call('GET', '/superagent/channels')
    const ids = (listed.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(foreign.id)

    const theirs = await call('GET', '/superagent/channels', undefined, otherCookie)
    const theirIds = (theirs.body.data as { items: Array<{ id: string }> }).items.map((item) => item.id)
    expect(theirIds).toContain(foreign.id)
    expect(theirIds).not.toContain(mine.id)

    const rename = await call('PATCH', `/superagent/channels/${foreign.id}`, { name: '越权' })
    expect(rename.status).toBe(404)
    const remove = await call('DELETE', `/superagent/channels/${foreign.id}`)
    expect(remove.status).toBe(404)

    const theirBindings = await call('GET', '/superagent/bindings', undefined, otherCookie)
    expect((theirBindings.body.data as { items: unknown[] }).items).toHaveLength(0)
    const theirTickets = await call('GET', '/superagent/tickets', undefined, otherCookie)
    expect((theirTickets.body.data as { items: unknown[] }).items).toHaveLength(0)
  })

  it('不能把群绑到别人的工作区', async () => {
    const channel = await createChannel({ appId: 'cli_9999999999999999' })
    const result = await call('POST', '/superagent/bindings', {
      channelId: channel.id,
      workspaceId: 'w_other',
      externalChatId: 'oc_3',
    })
    expect(result.status).toBe(404)
    expect(result.body.msg).toBe('workspace-not-found')
  })
})
