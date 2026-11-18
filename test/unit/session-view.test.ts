import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainClient, BrainCall } from '../../src/brain/client.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  getSession,
  historyPage,
  listSessions,
  updateSession,
} from '../../src/modules/sessions/service.js'

let dir: string
let db: SqliteDb
let cancels: BrainCall[]
let cancelResult: { ok: true } | { ok: false; status: number; code: string }
let brain: BrainClient

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-session-view-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', 'u2', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ('w1', 'u1', '工作区', '/tmp/w1', '/desk')`,
  )
  cancelResult = { ok: true }
  cancels = []
  brain = {
    cancel: (input: BrainCall & { requestId: string }) => {
      cancels.push(input)
      return Promise.resolve(cancelResult)
    },
  } as unknown as BrainClient
})

afterEach(async () => {
  await db.end().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

async function insertSession(id: string, title: string, at: string, state = 'ready', userId = 'u1') {
  await db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id, last_active_at)
     VALUES ($1, $2, 'w1', $3, 'platform', $4)`,
    [id, userId, title, at],
  )
  if (state !== '') {
    await db.query(`INSERT INTO dsh_platform_session_ops (session_id, user_id, state) VALUES ($1, $2, $3)`, [id, userId, state])
  }
}

async function insertEvent(sessionId: string, seq: number, event: Record<string, unknown>) {
  await db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`, [
    sessionId,
    seq,
    JSON.stringify(event),
  ])
}

describe('会话视图', () => {
  it('标题、blank、running、最后一句用户消息都从脑事件推导', async () => {
    await insertSession('s1', '', '2026-01-01T00:00:00.000Z')
    await insertEvent('s1', 1, { type: 'session/title', time: 1000, data: { title: '脑里的标题' } })
    await insertEvent('s1', 2, { type: 'turn/start', time: 2000, data: {} })
    await insertEvent('s1', 3, {
      type: 'user/message',
      time: 3000,
      data: { text: '你好', source: { kind: 'user' } },
    })

    const item = await getSession(db, 'u1', 's1')
    expect(item).toMatchObject({
      id: 's1',
      workspace_id: 'w1',
      title: '脑里的标题',
      status: 'active',
      create_state: 'ready',
      blank: false,
      running: true,
      last_prompt_at: new Date(3000).toISOString(),
    })
  })

  it('平台标题优先；turn/end 收尾后 running=false', async () => {
    await insertSession('s2', '平台标题', '2026-01-01T00:00:00.000Z')
    await insertEvent('s2', 1, { type: 'session/title', time: 1000, data: { title: '脑里的标题' } })
    await insertEvent('s2', 2, { type: 'turn/start', time: 2000, data: {} })
    await insertEvent('s2', 3, { type: 'turn/end', time: 4000, data: {} })
    // 非成员发的消息不算 last_prompt_at。
    await insertEvent('s2', 4, { type: 'user/message', time: 5000, data: { source: { kind: 'system' } } })

    const item = await getSession(db, 'u1', 's2')
    expect(item.title).toBe('平台标题')
    expect(item.running).toBe(false)
    expect(item.last_prompt_at).toBeUndefined()
  })

  it('没有会话行就是 404，别人的会话也当不存在', async () => {
    await insertSession('s3', '别人的', '2026-01-01T00:00:00.000Z', 'ready', 'u2')
    await expect(getSession(db, 'u1', 's3')).rejects.toMatchObject({ status: 404, code: 'not-found' })
    await expect(getSession(db, 'u1', 'missing')).rejects.toMatchObject({ status: 404 })
  })

  it('列表按 (last_active_at, id) 分页', async () => {
    await insertSession('s_old', '旧会话', '2026-01-01T00:00:00.000Z')
    await insertSession('s_new', '新会话', '2026-01-02T00:00:00.000Z')

    const first = await listSessions(db, 'u1', 'w1', { limit: 1 })
    expect(first.items.map((item) => item.id)).toEqual(['s_new'])
    expect(first.nextCursor).not.toBe('')

    const second = await listSessions(db, 'u1', 'w1', { limit: 1, cursor: first.nextCursor })
    expect(second.items.map((item) => item.id)).toEqual(['s_old'])
    expect(second.nextCursor).toBe('')
  })

  it('游标不合法时报 400，而不是把整页重放一遍', async () => {
    await expect(listSessions(db, 'u1', null, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-cursor',
    })
  })
})

describe('修改会话', () => {
  it('改标题并归档', async () => {
    await insertSession('s4', '原标题', '2026-01-01T00:00:00.000Z')
    const renamed = await updateSession(db, brain, 'u1', 's4', { title: '  新标题  ' })
    expect(renamed.title).toBe('新标题')

    const archived = await updateSession(db, brain, 'u1', 's4', { archived: true })
    expect(archived.status).toBe('archived')
    expect(cancels).toHaveLength(0)
  })

  it('归档并要求停止时先让脑取消', async () => {
    await insertSession('s5', '跑着的会话', '2026-01-01T00:00:00.000Z')
    await updateSession(db, brain, 'u1', 's5', { archived: true, stopActivity: true })
    expect(cancels).toHaveLength(1)
    expect(cancels[0]).toMatchObject({ sessionId: 's5', workspaceId: 'w1' })
  })

  it('脑上没有活跃 Agent 时照样归档', async () => {
    cancelResult = { ok: false, status: 404, code: 'session-not-found' }
    await insertSession('s6', '冷会话', '2026-01-01T00:00:00.000Z')
    const archived = await updateSession(db, brain, 'u1', 's6', { archived: true, stopActivity: true })
    expect(archived.status).toBe('archived')
  })

  it('取消结果未知就不归档，避免前端以为停了', async () => {
    cancelResult = { ok: false, status: 502, code: 'brain-unreachable' }
    await insertSession('s7', '未知状态', '2026-01-01T00:00:00.000Z')
    await expect(updateSession(db, brain, 'u1', 's7', { archived: true, stopActivity: true })).rejects.toMatchObject({
      status: 502,
    })
    const item = await getSession(db, 'u1', 's7')
    expect(item.status).toBe('active')
  })

  it('什么都不改就 422', async () => {
    await insertSession('s8', '空改动', '2026-01-01T00:00:00.000Z')
    await expect(updateSession(db, brain, 'u1', 's8', {})).rejects.toMatchObject({ status: 422 })
  })
})

describe('有界历史', () => {
  async function seedHistory(id: string) {
    await insertSession(id, '历史会话', '2026-01-01T00:00:00.000Z')
    await insertEvent(id, 1, { type: 'turn/start', time: 1000, data: {} })
    await insertEvent(id, 2, { type: 'user/message', time: 2000, data: { text: '一' } })
    await insertEvent(id, 3, { type: 'assistant/message', time: 3000, data: { text: '二' } })
    await insertEvent(id, 4, { type: 'turn/end', time: 4000, data: {} })
    await insertEvent(id, 5, { type: 'turn/start', time: 5000, data: {} })
    await insertEvent(id, 6, { type: 'user/message', time: 6000, data: { text: '三' } })
  }

  it('不传游标时给最新一页，事件按 seq 升序', async () => {
    await seedHistory('h1')
    const page = await historyPage(db, 'u1', 'h1')
    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(page.cursor).toBe(6)
    expect(page.before).toBe(7)
    expect(page.after).toBe(-1)
    expect(page.has_more).toBe(false)
    expect(page.events[0]).toMatchObject({ type: 'turn/start', time: 1000 })
  })

  it('limit 往回翻，带 next_before', async () => {
    await seedHistory('h2')
    const newest = await historyPage(db, 'u1', 'h2', { limit: 3 })
    expect(newest.events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(newest.has_more).toBe(true)
    expect(newest.next_before).toBe(4)

    const older = await historyPage(db, 'u1', 'h2', { limit: 3, before: newest.next_before })
    expect(older.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(older.has_more).toBe(false)
    expect(older.before).toBe(4)
  })

  it('after 做增量，不含 after 本身', async () => {
    await seedHistory('h3')
    const page = await historyPage(db, 'u1', 'h3', { after: 3 })
    expect(page.events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(page.after).toBe(3)
    expect(page.before).toBe(-1)
    expect(page.has_more).toBe(false)
  })

  it('after 和 before 互斥', async () => {
    await seedHistory('h4')
    await expect(historyPage(db, 'u1', 'h4', { after: 1, before: 3 })).rejects.toMatchObject({
      status: 400,
      code: 'after-before-exclusive',
    })
  })

  it('空会话给空页', async () => {
    await insertSession('h5', '空会话', '2026-01-01T00:00:00.000Z')
    const page = await historyPage(db, 'u1', 'h5')
    expect(page.events).toEqual([])
    expect(page.cursor).toBe(-1)
    expect(page.has_more).toBe(false)
  })

  it('别人的会话 404', async () => {
    await expect(historyPage(db, 'u1', 'missing')).rejects.toMatchObject({ status: 404 })
  })
})
