import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  bindingById,
  bindingForChat,
  claimAssignments,
  claimOutbox,
  createBinding,
  createChannel,
  createTicket,
  defaultWorkspaceId,
  deleteBinding,
  enqueueOutbox,
  finishAssignment,
  finishOutbox,
  listBindings,
  listChannels,
  listTickets,
  openChannel,
  openTicketsInThread,
  pendingMessages,
  recordDecision,
  recordInbound,
  requeueAssignment,
  setTicketStage,
  ticketById,
  updateBinding,
  updateChannel,
} from '../../src/modules/superagent/store.js'

/**
 * 工单自动化的仓储层。
 *
 * 重点在两条硬约束上：密钥只以密文落库；每张表、每个查询都按成员隔离，
 * 拿到别人的 id 也读不到、改不了。
 */

let dir: string
let db: SqliteDb
const key = randomBytes(32)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-store-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w1', 'u1', '前端', '/h/w1', '/g/w1'), ('w2', 'u1', '后端', '/h/w2', '/g/w2'),
            ('w9', 'u2', '别人的', '/h/w9', '/g/w9')`,
  )
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

/** 造一条 u1 的渠道，返回 id。 */
async function channel(userId = 'u1', appId = 'cli_1'): Promise<string> {
  const created = await createChannel(db, key, userId, { provider: 'feishu', name: '我的机器人', appId, appSecret: 'shh' })
  return created.id
}

/** 一个群加一条绑定；返回够用的三样东西。 */
async function fixture(): Promise<{ bindingId: string; channelId: string }> {
  const channelId = await channel()
  const binding = await createBinding(db, 'u1', { channelId, workspaceId: 'w1', externalChatId: 'oc_1' })
  return { bindingId: binding.id, channelId }
}

/** 落一条入站消息。 */
function send(
  fixtureRef: { bindingId: string; channelId: string },
  messageId: string,
  body = '把登录页修一下',
): Promise<{ id: string; fresh: boolean }> {
  return recordInbound(db, {
    ...fixtureRef,
    userId: 'u1',
    externalChatId: 'oc_1',
    externalMessageId: messageId,
    threadKey: 'oc_1:om_1',
    senderId: 'ou_1',
    senderName: '小明',
    body,
    addressed: true,
  })
}

/** 接一张工单，返回工单 id。 */
async function accept(threadKey = 'oc_1:om_1'): Promise<string> {
  const { bindingId, channelId } = await fixture()
  const ticket = await createTicket(db, {
    userId: 'u1',
    bindingId,
    channelId,
    workspaceId: 'w1',
    threadKey,
    title: '登录页错误提示',
    scope: '只改登录页',
    reason: '用户明确要求',
    intentEvidence: '「把登录页修一下」',
    rules: ['r1'],
    autoMerge: false,
  })
  return ticket.id
}

describe('渠道', () => {
  it('密钥只以密文落库，列表不回传，连接器取用才解密', async () => {
    const id = await channel()
    const stored = await db.query(`SELECT secret_ciphertext FROM dsh_superagent_channels WHERE id = $1`, [id])
    const blob = Buffer.from(stored.rows[0]?.secret_ciphertext as Uint8Array)
    expect(blob.toString('utf8')).not.toContain('shh')

    const [view] = await listChannels(db, 'u1')
    expect(view).toMatchObject({ id, name: '我的机器人', appId: 'cli_1', status: 'active' })
    expect(JSON.stringify(view)).not.toContain('shh')

    await expect(openChannel(db, key, id)).resolves.toMatchObject({ appSecret: 'shh', userId: 'u1' })
  })

  it('同一个成员重复接入同一个应用回 409，别人的渠道看不见也改不了', async () => {
    await channel()
    await expect(createChannel(db, key, 'u1', { provider: 'feishu', appId: 'cli_1', appSecret: 'x' })).rejects.toMatchObject(
      { status: 409, code: 'channel-exists' },
    )

    await expect(listChannels(db, 'u2')).resolves.toEqual([])
    const mine = (await listChannels(db, 'u1'))[0]
    await expect(updateChannel(db, key, 'u2', mine?.id as string, { name: '偷改名' })).rejects.toMatchObject({
      status: 404,
      code: 'channel-not-found',
    })
  })

  it('改名字、换密钥、停用各自生效', async () => {
    const id = await channel()
    const updated = await updateChannel(db, key, 'u1', id, { name: '新名字', appSecret: 'shh2', status: 'disabled' })
    expect(updated).toMatchObject({ name: '新名字', status: 'disabled' })
    await expect(openChannel(db, key, id)).resolves.toMatchObject({ appSecret: 'shh2' })
  })
})

describe('绑定', () => {
  it('新建绑定列出工作区名字，默认处于启用状态', async () => {
    const { bindingId } = await fixture()
    const [binding] = await listBindings(db, 'u1')
    expect(binding).toMatchObject({
      id: bindingId,
      workspaceId: 'w1',
      workspaceName: '前端',
      chatName: '',
      policyVersion: 1,
      status: 'active',
    })
    await expect(listBindings(db, 'u2')).resolves.toEqual([])
  })

  it('不能绑别人的渠道或工作区', async () => {
    const foreignChannel = await channel('u2', 'cli_2')
    await expect(
      createBinding(db, 'u1', { channelId: foreignChannel, workspaceId: 'w1', externalChatId: 'oc_x' }),
    ).rejects.toMatchObject({ status: 404, code: 'channel-not-found' })

    const channelId = await channel()
    await expect(
      createBinding(db, 'u1', { channelId, workspaceId: 'w9', externalChatId: 'oc_x' }),
    ).rejects.toMatchObject({ status: 404, code: 'workspace-not-found' })
  })

  it('同一个群不能绑两次', async () => {
    const channelId = await channel()
    await createBinding(db, 'u1', { channelId, workspaceId: 'w1', externalChatId: 'oc_1' })
    await expect(createBinding(db, 'u1', { channelId, workspaceId: 'w2', externalChatId: 'oc_1' })).rejects.toMatchObject(
      { status: 409, code: 'binding-exists' },
    )
  })

  it('改规则会升版本号，暂停后录入路径不再命中', async () => {
    const { bindingId, channelId } = await fixture()
    const updated = await updateBinding(db, 'u1', bindingId, {
      policy: { rules: [{ id: 'r1', enabled: true, instruction: '修前端缺陷' }] },
    })
    expect(updated.policyVersion).toBe(2)
    expect(updated.policy).toEqual({ rules: [{ id: 'r1', enabled: true, instruction: '修前端缺陷' }] })

    await expect(bindingForChat(db, channelId, 'oc_1')).resolves.toMatchObject({ id: bindingId })

    await updateBinding(db, 'u1', bindingId, { status: 'paused' })
    await expect(bindingForChat(db, channelId, 'oc_1')).resolves.toBeUndefined()
  })

  it('解绑后录入路径不再命中，重复解绑回 404', async () => {
    const { bindingId, channelId } = await fixture()
    await deleteBinding(db, 'u1', bindingId)
    await expect(bindingForChat(db, channelId, 'oc_1')).resolves.toBeUndefined()
    await expect(deleteBinding(db, 'u1', bindingId)).rejects.toMatchObject({ status: 404 })
  })

  it('私聊兜底工作区：先看默认标记，再看最近活跃；别人的不算', async () => {
    await db.query(`UPDATE dsh_workspaces SET last_active_at = '2026-01-01T00:00:00Z' WHERE id = 'w1'`)
    await db.query(`UPDATE dsh_workspaces SET last_active_at = '2026-01-02T00:00:00Z' WHERE id = 'w2'`)
    await db.query(`UPDATE dsh_workspaces SET last_active_at = '2026-01-03T00:00:00Z' WHERE id = 'w9'`)
    // 没设默认时用最近活跃的。
    await expect(defaultWorkspaceId(db, 'u1')).resolves.toBe('w2')
    // 设了默认就优先默认，哪怕它不是最近活跃的。
    await db.query(`UPDATE dsh_workspaces SET is_default = 1 WHERE id = 'w1'`)
    await expect(defaultWorkspaceId(db, 'u1')).resolves.toBe('w1')
    // 归档的工作区不再接活。
    await db.query(`UPDATE dsh_workspaces SET state = 'archived' WHERE id = 'w1'`)
    await expect(defaultWorkspaceId(db, 'u1')).resolves.toBe('w2')
    // 只看自己的。
    await expect(defaultWorkspaceId(db, 'u2')).resolves.toBe('w9')
  })
})

describe('消息', () => {
  it('渠道重投同一条消息只落一行', async () => {
    const ref = await fixture()
    const first = await send(ref, 'om_1')
    expect(first.fresh).toBe(true)
    await expect(send(ref, 'om_1')).resolves.toEqual({ id: first.id, fresh: false })
    const count = await db.query(`SELECT count(*) AS n FROM dsh_superagent_messages`)
    expect(Number(count.rows[0]?.n)).toBe(1)
  })

  it('待评估消息按收到顺序取出，评估结果写好版本、用量与决策', async () => {
    const ref = await fixture()
    const first = await send(ref, 'om_1')
    const second = await send(ref, 'om_2', '顺手把标题也改一下')

    const pending = await pendingMessages(db, ref.bindingId, 'oc_1:om_1')
    expect(pending.map((item) => item.id)).toEqual([first.id, second.id])
    expect(pending[0]).toMatchObject({ senderName: '小明', addressed: true, body: '把登录页修一下' })

    await recordDecision(db, first.id, {
      status: 'ignored',
      promptVersion: 'eval-1',
      provider: 'user',
      model: 'deepseek-chat',
      inputTokens: 12,
      outputTokens: 3,
      decision: { kind: 'ignore', reason: '闲聊' },
    })
    const row = await db.query(`SELECT * FROM dsh_superagent_messages WHERE id = $1`, [first.id])
    expect(row.rows[0]).toMatchObject({ status: 'ignored', prompt_version: 'eval-1', model: 'deepseek-chat' })
    expect(Number(row.rows[0]?.input_tokens)).toBe(12)
    expect(JSON.parse(String(row.rows[0]?.decision))).toEqual({ kind: 'ignore', reason: '闲聊' })
    // 评估过的不会再被取出来。
    await expect(pendingMessages(db, ref.bindingId, 'oc_1:om_1')).resolves.toMatchObject([{ id: second.id }])
  })
})

describe('工单与执行', () => {
  it('接单同时排一条执行，工单规则与阶段可读回', async () => {
    const id = await accept()
    const ticket = await ticketById(db, 'u1', id)
    expect(ticket).toMatchObject({ title: '登录页错误提示', rules: ['r1'], stage: 'accepted', autoMerge: false })
    const assignments = await db.query(`SELECT status FROM dsh_superagent_assignments WHERE ticket_id = $1`, [id])
    expect(assignments.rows).toEqual([{ status: 'queued' }])
  })

  it('别人读不到、列不到我的工单', async () => {
    const id = await accept()
    await expect(ticketById(db, 'u2', id)).resolves.toBeUndefined()
    await expect(listTickets(db, 'u2')).resolves.toEqual([])
    await expect(listTickets(db, 'u1')).resolves.toHaveLength(1)
  })

  it('同一话题里只算一条未结束的工单，结束之后不再算', async () => {
    const id = await accept()
    const ticket = await ticketById(db, 'u1', id)
    const bindingId = ticket?.bindingId as string
    await expect(openTicketsInThread(db, bindingId, 'oc_1:om_1')).resolves.toHaveLength(1)

    await setTicketStage(db, id, 'done', { outcome: { summary: '已修' } })
    await expect(openTicketsInThread(db, bindingId, 'oc_1:om_1')).resolves.toHaveLength(0)
    const done = await ticketById(db, 'u1', id)
    expect(done).toMatchObject({ stage: 'done', outcome: { summary: '已修' } })
    expect(done?.closedAt).toBeTruthy()
  })

  it('按阶段过滤只看得到对应工单', async () => {
    const id = await accept()
    await setTicketStage(db, id, 'working')
    await expect(listTickets(db, 'u1', { stage: 'working' })).resolves.toHaveLength(1)
    await expect(listTickets(db, 'u1', { stage: 'done' })).resolves.toEqual([])
  })

  it('认领一次只给一个副本，放回队列后可以再领', async () => {
    await accept()
    const claimed = await claimAssignments(db, 'replica-a', 4)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ userId: 'u1', workspaceId: 'w1', title: '登录页错误提示', attemptCount: 1 })
    expect(await claimAssignments(db, 'replica-b', 4)).toEqual([])

    await requeueAssignment(db, claimed[0]?.id as string, '模型没配', 0)
    const again = await claimAssignments(db, 'replica-b', 4)
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ id: claimed[0]?.id, attemptCount: 2 })

    await finishAssignment(db, again[0]?.id as string, 'succeeded', { sessionId: 's_1' })
    const row = await db.query(`SELECT status, session_id FROM dsh_superagent_assignments WHERE id = $1`, [
      again[0]?.id,
    ])
    expect(row.rows[0]).toEqual({ status: 'succeeded', session_id: 's_1' })
  })
})

describe('回信队列', () => {
  it('发出成功落 sent_at，并停止重试', async () => {
    const { channelId } = await fixture()
    await enqueueOutbox(db, {
      userId: 'u1',
      channelId,
      externalChatId: 'oc_1',
      threadRootId: 'om_1',
      kind: 'ack',
      text: '收到',
    })

    const [item] = await claimOutbox(db, 'replica-a')
    expect(item).toMatchObject({ kind: 'ack', body: { text: '收到' }, threadRootId: 'om_1', attemptCount: 1 })
    expect(await claimOutbox(db, 'replica-b')).toEqual([])

    await finishOutbox(db, item!, undefined)
    const row = await db.query(`SELECT status, sent_at FROM dsh_superagent_outbox WHERE id = $1`, [item?.id])
    expect(row.rows[0]?.status).toBe('sent')
    expect(row.rows[0]?.sent_at).toBeTruthy()
  })

  it('发送失败按退避重试，次数用尽标记 dead', async () => {
    const channelId = await channel()
    await enqueueOutbox(db, { userId: 'u1', channelId, externalChatId: 'oc_1', kind: 'reply', text: '好的' })
    const [item] = await claimOutbox(db, 'replica-a')
    await finishOutbox(db, item!, '飞书 500', 1)

    const row = await db.query(`SELECT status, last_error FROM dsh_superagent_outbox WHERE id = $1`, [item?.id])
    expect(row.rows[0]).toMatchObject({ status: 'dead', last_error: '飞书 500' })
    // 已经放弃的不会再被认领。
    expect(await claimOutbox(db, 'replica-b')).toEqual([])
  })
})

describe('机器人默认规则', () => {
  it('默认规则可创建、可修改，列表回显', async () => {
    const created = await createChannel(db, key, 'u1', {
      provider: 'feishu',
      appId: 'cli_rules',
      appSecret: 'shh',
      defaultRules: ['前端改动可以接', '数据库迁移不要动'],
    })
    expect(created.defaultRules).toEqual(['前端改动可以接', '数据库迁移不要动'])
    expect((await listChannels(db, 'u1')).find((item) => item.id === created.id)?.defaultRules).toEqual([
      '前端改动可以接',
      '数据库迁移不要动',
    ])

    const updated = await updateChannel(db, key, 'u1', created.id, { defaultRules: ['只接前端'] })
    expect(updated.defaultRules).toEqual(['只接前端'])
  })

  it('新绑定没配规则就继承机器人默认；配了就以绑定的为准', async () => {
    const created = await createChannel(db, key, 'u1', {
      provider: 'feishu',
      appId: 'cli_inherit_rules',
      appSecret: 'shh',
      defaultRules: ['前端改动可以接'],
    })
    const inherited = await createBinding(db, 'u1', {
      channelId: created.id,
      workspaceId: 'w1',
      externalChatId: 'oc_1',
    })
    expect(inherited.policy).toEqual({
      rules: [{ id: 'r1', enabled: true, instruction: '前端改动可以接' }],
    })

    const explicit = await createBinding(db, 'u1', {
      channelId: created.id,
      workspaceId: 'w2',
      externalChatId: 'oc_2',
      policy: { rules: [{ id: 'keep', enabled: true, instruction: '后端可以接' }] },
    })
    expect(explicit.policy.rules).toEqual([{ id: 'keep', enabled: true, instruction: '后端可以接' }])

    // 空数组也按「没配」处理：跟随机器人默认。
    const empty = await createBinding(db, 'u1', {
      channelId: created.id,
      workspaceId: 'w2',
      externalChatId: 'oc_3',
      policy: { rules: [] },
    })
    expect(empty.policy.rules).toEqual([{ id: 'r1', enabled: true, instruction: '前端改动可以接' }])
  })

  it('清空绑定规则等于跟随机器人默认；机器人默认后来再改不影响已有绑定', async () => {
    const created = await createChannel(db, key, 'u1', {
      provider: 'feishu',
      appId: 'cli_rules_reset',
      appSecret: 'shh',
      defaultRules: ['前端改动可以接'],
    })
    const binding = await createBinding(db, 'u1', {
      channelId: created.id,
      workspaceId: 'w1',
      externalChatId: 'oc_1',
    })
    await updateBinding(db, 'u1', binding.id, {
      policy: { rules: [{ id: 'old', enabled: true, instruction: '旧规则' }] },
    })

    const cleared = await updateBinding(db, 'u1', binding.id, { policy: { rules: [] } })
    expect(cleared.policy.rules).toEqual([{ id: 'r1', enabled: true, instruction: '前端改动可以接' }])

    // 改机器人默认只影响以后新建的绑定，不回头改已有绑定。
    await updateChannel(db, key, 'u1', created.id, { defaultRules: ['新规则'] })
    await expect(bindingById(db, 'u1', binding.id)).resolves.toMatchObject({
      policy: { rules: [{ id: 'r1', enabled: true, instruction: '前端改动可以接' }] },
    })
  })

  it('机器人没配默认规则时，新建绑定保持空策略，交给部署兜底', async () => {
    const binding = await createBinding(db, 'u1', {
      channelId: await channel(),
      workspaceId: 'w1',
      externalChatId: 'oc_1',
    })
    expect(binding.policy).toEqual({})
  })
})
