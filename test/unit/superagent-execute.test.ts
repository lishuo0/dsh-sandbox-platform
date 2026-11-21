import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Deps } from '../../src/app/deps.js'
import type { BrainClient, BrainEvent } from '../../src/brain/client.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { createProvider } from '../../src/modules/models/service.js'
import {
  repoOf,
  runAssignments,
  ticketPrompt,
  watchAssignments,
  type RunDeps,
} from '../../src/modules/superagent/execute.js'
import { createBinding, createChannel, createTicket, closeTicket, ticketById } from '../../src/modules/superagent/store.js'

/**
 * 工单执行：开工要在自己的工作区里开会话，跑完要落结论并回群；
 * 过程里任何一步丢了都能靠游标接着跑，不重复投递。
 */

let dir: string
let db: SqliteDb
const key = randomBytes(32)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-execute-'))
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

interface FakeBrain {
  brain: BrainClient
  sent: Array<{ sessionId: string; text: string; requestId: string }>
  /** 每次 `eventBacklog` 按顺序取一条；用完之后返回 undefined。 */
  backlogs: Array<{ cursor: number; events: BrainEvent[] } | undefined>
}

function fakeBrain(): FakeBrain {
  const sent: FakeBrain['sent'] = []
  const backlogs: FakeBrain['backlogs'] = []
  const brain = {
    openSession: async () => ({ ok: true as const, value: undefined }),
    sendMessage: async (input: { sessionId: string; text: string; requestId: string }) => {
      sent.push(input)
      return { ok: true as const }
    },
    eventBacklog: async () => backlogs.shift(),
  } as unknown as BrainClient
  return { brain, sent, backlogs }
}

function deps(brain: BrainClient): RunDeps {
  return {
    db,
    brain,
    credentialsKey: key,
    objects: {} as ObjectStore,
  } as unknown as RunDeps & Deps
}

async function model(): Promise<void> {
  await createProvider(db, key, 'u1', {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-user-key',
    modelIds: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
  })
}

interface Fixture {
  ticketId: string
  channelId: string
}

async function ticket(options: { autoMerge?: boolean } = {}): Promise<Fixture> {
  const channel = await createChannel(db, key, 'u1', {
    provider: 'feishu',
    name: '我的机器人',
    appId: 'cli_a1b2c3d4e5f60718',
    appSecret: 'shh',
  })
  const binding = await createBinding(db, 'u1', { channelId: channel.id, workspaceId: 'w1', externalChatId: 'oc_1' })
  const created = await createTicket(db, {
    userId: 'u1',
    bindingId: binding.id,
    channelId: channel.id,
    workspaceId: 'w1',
    threadKey: 'oc_1:om_1',
    externalRootId: 'om_1',
    title: '修登录页',
    scope: '只改登录页',
    reason: '明确要求',
    intentEvidence: '「把登录页修一下」',
    rules: ['r1'],
    autoMerge: options.autoMerge === true,
  })
  return { ticketId: created.id, channelId: channel.id }
}

function assistant(text: string): BrainEvent {
  return {
    seq: 1,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  } as BrainEvent
}

function turnEnd(kind: string): BrainEvent {
  return { seq: 2, type: 'turn/end', data: { reason: { kind } } } as BrainEvent
}

describe('开工', () => {
  it('没配模型时留着这张单，等配上再跑', async () => {
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    expect(await runAssignments(deps(fake.brain), 'owner-1')).toBe(0)

    const row = await db.query(`SELECT status, last_error FROM dsh_superagent_assignments WHERE ticket_id = $1`, [ticketId])
    expect(row.rows[0]).toMatchObject({ status: 'queued', last_error: 'model-not-configured' })
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('accepted')
    void fake.sent
  })

  it('在工作区里开会话、投工单，并记下当前游标', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 7, events: [] })

    expect(await runAssignments(deps(fake.brain), 'owner-1')).toBe(1)

    const stored = await ticketById(db, 'u1', ticketId)
    expect(stored?.stage).toBe('working')
    expect(stored?.sessionId).toBeTruthy()
    expect(stored?.outcome.run).toMatchObject({ cursor: 7, sessionId: stored?.sessionId })

    const session = await db.query(`SELECT workspace_id FROM dsh_sessions WHERE id = $1`, [stored?.sessionId])
    expect(session.rows[0]?.workspace_id).toBe('w1')

    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.text).toContain('标题：修登录页')
    expect(fake.sent[0]?.text).toContain('范围：只改登录页')
    expect(fake.sent[0]?.requestId).toBe(`ticket.${ticketId}.1`)

    const assignment = await db.query(`SELECT status, lease_owner FROM dsh_superagent_assignments WHERE ticket_id = $1`, [ticketId])
    expect(assignment.rows[0]).toMatchObject({ status: 'running', lease_owner: 'owner-1' })
  })

  it('同一张单重复认领不会重复投递', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')
    // 租约还在，别的认领拿不到；即使拿到，请求号相同也不会再发一条。
    expect(await runAssignments(deps(fake.brain), 'owner-2')).toBe(0)
    expect(fake.sent).toHaveLength(1)
    void ticketId
  })

  it('进程重启后接着看进度，不重打工单', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 5, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')

    // 模拟租约到期后被重新认领。
    await db.query(`UPDATE dsh_superagent_assignments SET lease_until = NULL WHERE ticket_id = $1`, [ticketId])
    expect(await runAssignments(deps(fake.brain), 'owner-1')).toBe(1)
    expect(fake.sent).toHaveLength(1)
    expect((await ticketById(db, 'u1', ticketId))?.outcome.run).toMatchObject({ cursor: 5 })
  })
})

describe('收工', () => {
  it('回合正常结束：待查看、回群、执行记账', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')

    fake.backlogs.push({ cursor: 9, events: [assistant('改好了，动了登录页的提示文案。'), turnEnd('completed')] })
    expect(await watchAssignments(deps(fake.brain), 'owner-1')).toBe(1)

    const stored = await ticketById(db, 'u1', ticketId)
    expect(stored?.stage).toBe('review')
    expect((stored?.outcome.result as { summary: string }).summary).toContain('登录页')

    const assignment = await db.query(`SELECT status FROM dsh_superagent_assignments WHERE ticket_id = $1`, [ticketId])
    expect(assignment.rows[0]?.status).toBe('succeeded')

    const outbox = await db.query(`SELECT kind, external_chat_id, thread_root_id, body FROM dsh_superagent_outbox`)
    expect(outbox.rows[0]).toMatchObject({ kind: 'report', external_chat_id: 'oc_1', thread_root_id: 'om_1' })
    const body = typeof outbox.rows[0]?.body === 'string' ? JSON.parse(outbox.rows[0].body as string) : outbox.rows[0]?.body
    expect(body.text).toContain('工单「修登录页」做完了')
    expect(body.text).toContain('改好了')
  })

  it('开了自动合并的单，跑完直接结束', async () => {
    await model()
    const { ticketId } = await ticket({ autoMerge: true })
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')
    fake.backlogs.push({ cursor: 3, events: [assistant('已合并。'), turnEnd('completed')] })
    await watchAssignments(deps(fake.brain), 'owner-1')
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('done')
  })

  it('回合出错：工单失败，群里说明', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')
    fake.backlogs.push({ cursor: 2, events: [assistant('报错了：找不到依赖'), turnEnd('error')] })
    await watchAssignments(deps(fake.brain), 'owner-1')

    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('failed')
    const outbox = await db.query(`SELECT body FROM dsh_superagent_outbox`)
    const body = typeof outbox.rows[0]?.body === 'string' ? JSON.parse(outbox.rows[0].body as string) : outbox.rows[0]?.body
    expect(body.text).toContain('执行失败了')
  })

  it('还没结束就只推进游标，不落结论', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')

    fake.backlogs.push({ cursor: 4, events: [assistant('正在改…')] })
    expect(await watchAssignments(deps(fake.brain), 'owner-1')).toBe(0)
    const stored = await ticketById(db, 'u1', ticketId)
    expect(stored?.stage).toBe('working')
    expect(stored?.outcome.run).toMatchObject({ cursor: 4 })
    const outbox = await db.query(`SELECT count(*) AS n FROM dsh_superagent_outbox`)
    expect(Number(outbox.rows[0]?.n)).toBe(0)
  })

  it('成员已经停止的单：看进度时作废执行，不翻回结论', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')

    await closeTicket(db, 'u1', ticketId, 'stopped')
    // 模拟「关闭」和「推进」撞在一起：执行又被认领了一次。
    await db.query(
      `UPDATE dsh_superagent_assignments SET status = 'running', lease_owner = 'owner-1' WHERE ticket_id = $1`,
      [ticketId],
    )
    fake.backlogs.push({ cursor: 3, events: [assistant('做完了'), turnEnd('completed')] })

    expect(await watchAssignments(deps(fake.brain), 'owner-1')).toBe(1)
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('stopped')
    const outbox = await db.query(`SELECT count(*) AS n FROM dsh_superagent_outbox`)
    expect(Number(outbox.rows[0]?.n)).toBe(0)
  })

  it('脑暂时不可达时什么都不改，等下一轮', async () => {
    await model()
    const { ticketId } = await ticket()
    const fake = fakeBrain()
    fake.backlogs.push({ cursor: 0, events: [] })
    await runAssignments(deps(fake.brain), 'owner-1')
    fake.backlogs.push(undefined)

    expect(await watchAssignments(deps(fake.brain), 'owner-1')).toBe(0)
    const assignment = await db.query(`SELECT status FROM dsh_superagent_assignments WHERE ticket_id = $1`, [ticketId])
    expect(assignment.rows[0]?.status).toBe('running')
  })
})

describe('工单说明', () => {
  const base = {
    id: 't1',
    bindingId: 'b1',
    channelId: 'c1',
    workspaceId: 'w1',
    threadKey: 'oc_1:om_1',
    title: '修登录页',
    scope: '只改登录页',
    reason: '明确要求',
    intentEvidence: '「把登录页修一下」',
    rules: ['r1'],
    stage: 'accepted' as const,
    autoMerge: false,
    outcome: {},
    createdAt: '',
    updatedAt: '',
  }

  it('带上仓库和合并口径；没配仓库就不写', () => {
    expect(ticketPrompt(base, 'acme/web')).toContain('仓库：acme/web')
    expect(ticketPrompt(base, undefined)).not.toContain('仓库：')
    expect(ticketPrompt(base, undefined)).toContain('不要合并')
    expect(ticketPrompt({ ...base, autoMerge: true }, undefined)).toContain('可以直接合并')
  })

  it('只认非空的仓库名', () => {
    expect(repoOf({ repo: ' acme/web ' })).toBe('acme/web')
    expect(repoOf({ repo: '' })).toBeUndefined()
    expect(repoOf({})).toBeUndefined()
    expect(repoOf(undefined)).toBeUndefined()
  })
})
