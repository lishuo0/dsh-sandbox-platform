import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  closeTicket,
  createBinding,
  createChannel,
  createTicket,
  listTicketCards,
  openTicketsInThread,
  ticketById,
} from '../../src/modules/superagent/store.js'

/**
 * 「工单任务」页的数据面：
 * 列表要能认出群和工作区；手动结束 / 停止后，话题立刻可以继续接活；
 * 别人的单一张也动不了。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-superagent-tickets-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x')`)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', '二', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w1', 'u1', '前端', '/h/w1', '/g/w1')`,
  )
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

interface Fixture {
  ticketId: string
  bindingId: string
  channelId: string
}

async function ticket(): Promise<Fixture> {
  const channel = await createChannel(db, Buffer.alloc(32), 'u1', {
    provider: 'feishu',
    name: '我的机器人',
    appId: 'cli_a1b2c3d4e5f60718',
    appSecret: 'shh',
  })
  const binding = await createBinding(db, 'u1', {
    channelId: channel.id,
    workspaceId: 'w1',
    externalChatId: 'oc_1',
    chatName: '前端群',
  })
  const created = await createTicket(db, {
    userId: 'u1',
    bindingId: binding.id,
    channelId: channel.id,
    workspaceId: 'w1',
    threadKey: 'oc_1:om_1',
    title: '修登录页',
    scope: '只改登录页',
    reason: '明确要求',
    intentEvidence: '「把登录页修一下」',
    rules: ['r1'],
  })
  return { ticketId: created.id, bindingId: binding.id, channelId: channel.id }
}

describe('工单列表', () => {
  it('带出群、机器人和工作区的名字，并可按阶段过滤', async () => {
    const { ticketId } = await ticket()
    const cards = await listTicketCards(db, 'u1')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: ticketId,
      chatName: '前端群',
      channelName: '我的机器人',
      workspaceName: '前端',
      stage: 'accepted',
    })
    expect(await listTicketCards(db, 'u1', { stage: 'review' })).toEqual([])
  })

  it('只看得到自己的工单', async () => {
    await ticket()
    expect(await listTicketCards(db, 'u2')).toEqual([])
  })
})

describe('手动结束', () => {
  it('标记完成后话题不再挡着新活', async () => {
    const { ticketId, bindingId } = await ticket()
    const closed = await closeTicket(db, 'u1', ticketId, 'done')
    expect(closed?.stage).toBe('done')
    expect(closed?.closedAt).toBeTruthy()
    expect(await openTicketsInThread(db, bindingId, 'oc_1:om_1')).toEqual([])
  })

  it('停止正在跑的单时，排队中的执行一起取消', async () => {
    const { ticketId } = await ticket()
    await db.query(`UPDATE dsh_superagent_assignments SET status = 'running' WHERE ticket_id = $1`, [ticketId])
    await closeTicket(db, 'u1', ticketId, 'stopped')

    const assignment = await db.query(`SELECT status FROM dsh_superagent_assignments WHERE ticket_id = $1`, [ticketId])
    expect(assignment.rows[0]?.status).toBe('cancelled')
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('stopped')
  })

  it('已经结束的单不能再结束', async () => {
    const { ticketId } = await ticket()
    expect(await closeTicket(db, 'u1', ticketId, 'done')).not.toBeUndefined()
    expect(await closeTicket(db, 'u1', ticketId, 'stopped')).toBeUndefined()
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('done')
  })

  it('别人的单动不了', async () => {
    const { ticketId } = await ticket()
    expect(await closeTicket(db, 'u2', ticketId, 'done')).toBeUndefined()
    expect((await ticketById(db, 'u1', ticketId))?.stage).toBe('accepted')
  })
})
