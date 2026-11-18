import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { searchSessions } from '../../src/modules/sessions/service.js'

/**
 * 会话内容搜索：只搜自己的会话，命中标题和三类消息事件；
 * 摘要以命中位置为中心截取，翻页上限 20 + has_more。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-session-search-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`,
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function addSession(id: string, userId: string, title = '', activeAt = '2026-01-01T00:00:00Z'): Promise<void> {
  await db.query(`INSERT INTO dsh_sessions (id, user_id, title, last_active_at) VALUES ($1, $2, $3, $4)`, [
    id,
    userId,
    title,
    activeAt,
  ])
}

async function addEvent(
  sessionId: string,
  seq: number,
  event: Record<string, unknown>,
): Promise<void> {
  await db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`, [
    sessionId,
    seq,
    JSON.stringify(event),
  ])
}

describe('searchSessions', () => {
  it('空查询直接空结果，不扫表', async () => {
    await addSession('s1', 'u1', '数据库迁移')
    expect(await searchSessions(db, 'u1', '   ')).toEqual({ items: [], has_more: false })
  })

  it('标题命中用标题当摘要', async () => {
    await addSession('s1', 'u1', '排查数据库迁移问题')
    const result = await searchSessions(db, 'u1', '数据库')
    expect(result.items).toEqual([{ session_id: 's1', snippet: '排查数据库迁移问题' }])
    expect(result.has_more).toBe(false)
  })

  it('搜用户和助手消息，一个会话只出一条', async () => {
    await addSession('s1', 'u1', '普通标题')
    await addEvent('s1', 1, {
      type: 'user/message',
      data: { message: { content: [{ type: 'text', text: '帮我检查 PG 迁移脚本' }] } },
    })
    await addEvent('s1', 2, {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'PG 迁移脚本没问题' }] },
    })
    const result = await searchSessions(db, 'u1', 'PG 迁移')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.session_id).toBe('s1')
    expect(result.items[0]?.snippet).toContain('PG 迁移')
  })

  it('会话标题事件也能命中', async () => {
    await addSession('s1', 'u1')
    await addEvent('s1', 1, { type: 'session/title', data: { title: '沙箱注册表设计' } })
    const result = await searchSessions(db, 'u1', '沙箱注册表')
    expect(result.items[0]?.snippet).toBe('沙箱注册表设计')
  })

  it('其他事件类型即使包含关键词也不算命中', async () => {
    await addSession('s1', 'u1')
    await addEvent('s1', 1, { type: 'turn/start', data: { text: '机密关键词' } })
    expect((await searchSessions(db, 'u1', '机密关键词')).items).toEqual([])
  })

  it('按成员隔离，别人的会话搜不到', async () => {
    await addSession('s1', 'u1', '共享关键词')
    await addSession('s2', 'u2', '共享关键词')
    const mine = await searchSessions(db, 'u1', '共享关键词')
    expect(mine.items.map((hit) => hit.session_id)).toEqual(['s1'])
    expect((await searchSessions(db, 'u2', '共享关键词')).items.map((hit) => hit.session_id)).toEqual(['s2'])
  })

  it('最多 20 条，多出来的用 has_more 表示', async () => {
    for (let i = 0; i < 21; i += 1) {
      await addSession(`s${String(i).padStart(2, '0')}`, 'u1', `批量命中 ${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`)
    }
    const result = await searchSessions(db, 'u1', '批量命中')
    expect(result.items).toHaveLength(20)
    expect(result.has_more).toBe(true)
  })

  it('长文本以命中位置为中心截断并加省略号', async () => {
    await addSession('s1', 'u1')
    const text = `${'前'.repeat(300)}命中点${'后'.repeat(300)}`
    await addEvent('s1', 1, { type: 'user/message', data: { text } })
    const snippet = (await searchSessions(db, 'u1', '命中点')).items[0]?.snippet ?? ''
    expect([...snippet].length).toBeLessThanOrEqual(242)
    expect(snippet).toContain('命中点')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('超过 500 个字符的查询按非法请求拒绝', async () => {
    await expect(searchSessions(db, 'u1', 'x'.repeat(501))).rejects.toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid request' }),
    )
  })

  it('按最近活跃倒序返回', async () => {
    await addSession('old', 'u1', '同一关键词', '2026-01-01T00:00:00Z')
    await addSession('new', 'u1', '同一关键词', '2026-02-01T00:00:00Z')
    const result = await searchSessions(db, 'u1', '同一关键词')
    expect(result.items.map((hit) => hit.session_id)).toEqual(['new', 'old'])
  })
})
