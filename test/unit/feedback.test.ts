import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { listFeedback } from '../../src/modules/feedback/service.js'

/**
 * 反馈读取出口：事件是脑写的 `feedback/record`，平台只读。
 * 归属按会话的成员判定；管理员看全部，成员只看自己。
 */

let dir: string
let db: SqliteDb

function event(seq: number, type: string, data: unknown, time = 1_794_900_000_000 + seq * 10): string {
  return JSON.stringify({ type, seq, time, data })
}

async function seed(): Promise<void> {
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES
       ('w1', 'u1', '一的工作区', '/tmp/w1', '/desk'),
       ('w2', 'u2', '二的工作区', '/tmp/w2', '/desk')`,
  )
  await db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES
       ('s1', 'u1', 'w1', '第一个会话'),
       ('s2', 'u2', 'w2', '第二个会话')`,
  )
  await db.query(
    `INSERT INTO dsh_session_events (session_id, seq, event) VALUES
       ('s1', 1, $1),
       ('s1', 2, $2),
       ('s1', 3, $3),
       ('s2', 1, $4),
       ('s2', 2, $5)`,
    [
      event(1, 'user/message', { text: '不算反馈' }),
      event(2, 'feedback/record', { text: '按钮点不动', category: 'product-interaction' }),
      event(3, 'feedback/record', { text: '答非所问', category: 'instruction-following' }),
      event(1, 'feedback/record', { text: '第二条会话的反馈', category: 'other' }, 1_794_900_000_100),
      event(2, 'assistant/message', { text: '也不算' }),
    ],
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-feedback-unit-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.exec(`CREATE TABLE IF NOT EXISTS dsh_session_events (
    session_id text NOT NULL,
    seq integer NOT NULL,
    event text NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`)
  await seed()
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

describe('反馈读取', () => {
  it('只挑 feedback/record，按 seq 倒序，映射出文本、分类、时间和归属', async () => {
    const entries = await listFeedback(db, { id: 'u1', role: 'member' }, { limit: 10 })
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.seq)).toEqual([3, 2])
    expect(entries[0]).toMatchObject({
      sessionId: 's1',
      text: '答非所问',
      category: 'instruction-following',
      sessionTitle: '第一个会话',
      userId: 'u1',
      displayName: '一',
      workspaceId: 'w1',
    })
    expect(entries[0]?.at).toBe(new Date(1_794_900_000_030).toISOString())
  })

  it('成员只看自己名下会话的反馈', async () => {
    const entries = await listFeedback(db, { id: 'u2', role: 'member' }, { limit: 10 })
    expect(entries.map((entry) => entry.text)).toEqual(['第二条会话的反馈'])
  })

  it('管理员看全部成员', async () => {
    const entries = await listFeedback(db, { id: 'admin', role: 'admin' }, { limit: 10 })
    expect(entries.map((entry) => entry.userId).sort()).toEqual(['u1', 'u1', 'u2'])
  })

  it('按会话过滤，并且过滤后仍受成员归属约束', async () => {
    const own = await listFeedback(db, { id: 'u1', role: 'member' }, { limit: 10, sessionId: 's1' })
    expect(own).toHaveLength(2)
    const cross = await listFeedback(db, { id: 'u1', role: 'member' }, { limit: 10, sessionId: 's2' })
    expect(cross).toEqual([])
    const admin = await listFeedback(db, { id: 'admin', role: 'admin' }, { limit: 10, sessionId: 's2' })
    expect(admin).toHaveLength(1)
  })

  it('limit 截断最新的若干条', async () => {
    const entries = await listFeedback(db, { id: 'admin', role: 'admin' }, { limit: 1 })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('第二条会话的反馈')
  })

  it('坏事件或非对象 data 不抛错，缺失字段给空串', async () => {
    await db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ('s1', 9, $1)`, [
      JSON.stringify({ type: 'feedback/record', seq: 9, time: 5, data: 'not-an-object' }),
    ])
    await db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ('s1', 10, $1)`, [
      JSON.stringify({ type: 'feedback/record', seq: 10, data: { category: 7 } }),
    ])
    const entries = await listFeedback(db, { id: 'u1', role: 'member' }, { limit: 10 })
    const latest = entries.find((entry) => entry.seq === 10)
    expect(latest).toMatchObject({ text: '', category: '', at: '' })
  })
})
