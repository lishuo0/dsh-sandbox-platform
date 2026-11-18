import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { listSchedules } from '../../src/modules/schedule/service.js'

/**
 * 定时任务清单只读自己的会话；active 排前面，rule 从文本解析成对象。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-schedule-list-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`)
  await db.query(`INSERT INTO dsh_sessions (id, user_id, title) VALUES ('s1', 'u1', '我的会话'), ('s2', 'u2', '别人的会话')`)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function addTask(
  id: string,
  sessionId: string,
  status: string,
  nextRunAt: string,
  extra: { lastDelivery?: string; rule?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO dsh_schedule_tasks (
       id, session_id, title, prompt, kind, rule, status, desired_at, next_run_at, last_delivery
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
    [
      id,
      sessionId,
      `任务 ${id}`,
      `提示 ${id}`,
      'every',
      extra.rule ?? '{"everySeconds":300}',
      status,
      nextRunAt,
      extra.lastDelivery ?? null,
    ],
  )
}

describe('listSchedules', () => {
  it('没有任务时是空数组', async () => {
    expect(await listSchedules(db, 'u1')).toEqual([])
  })

  it('只列自己的，active 优先，按下次运行时间排序', async () => {
    await addTask('t_done', 's1', 'inactive', '2026-02-01T00:00:00Z', { lastDelivery: 'accepted' })
    await addTask('t_late', 's1', 'active', '2026-03-02T00:00:00Z')
    await addTask('t_soon', 's1', 'active', '2026-03-01T00:00:00Z', { rule: '{"daily":{"time":"09:00:00.000"}}' })
    await addTask('t_foreign', 's2', 'active', '2026-01-01T00:00:00Z')

    const items = await listSchedules(db, 'u1')
    expect(items.map((item) => item.id)).toEqual(['t_soon', 't_late', 't_done'])

    expect(items[0]).toMatchObject({
      session_id: 's1',
      session_title: '我的会话',
      title: '任务 t_soon',
      prompt: '提示 t_soon',
      kind: 'every',
      rule: { daily: { time: '09:00:00.000' } },
      status: 'active',
      next_run_at: '2026-03-01T00:00:00Z',
      generation: 1,
    })
    expect(items[0]).not.toHaveProperty('last_delivery')
    expect(items[2]?.last_delivery).toBe('accepted')

    expect((await listSchedules(db, 'u2')).map((item) => item.id)).toEqual(['t_foreign'])
  })

  it('最多 200 条', async () => {
    for (let i = 0; i < 201; i += 1) {
      await addTask(`t${String(i).padStart(3, '0')}`, 's1', 'active', `2026-03-01T00:00:${String(i % 60).padStart(2, '0')}Z`)
    }
    expect(await listSchedules(db, 'u1')).toHaveLength(200)
  })
})
