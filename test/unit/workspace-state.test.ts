import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceState } from '../../src/client/workspaces.js'
import type { Db } from '../../src/kernel/db.js'
import { WORKSPACE_GUEST_ROOT } from '../../src/kernel/layout.js'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.js'

/**
 * `workspace/follow` 的基线与增量都从 `workspaceState` 来。这条流是浏览器
 * 工作区选择器和侧栏会话的唯一数据源：漏一行就没得选，多一行就是跨租户泄漏。
 */

let database: TestDatabase
let db: Db

beforeEach(async () => {
  database = await createTestDatabase()
  db = database.pool
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, 'u1', 'x'), ($2, 'u2', 'x')`, ['u1', 'u2'])
  // u1：手动排序 w2 在前；w3 已归档（不出现在列表里）。u2 有一块 w9。
  for (const [id, userId, at, order, state] of [
    ['w1', 'u1', '2026-01-01T00:00:00.000Z', 2, 'active'],
    ['w2', 'u1', '2026-01-02T00:00:00.000Z', 1, 'active'],
    ['w3', 'u1', '2026-01-03T00:00:00.000Z', 3, 'archived'],
    ['w9', 'u2', '2026-01-04T00:00:00.000Z', 0, 'active'],
  ]) {
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, created_at, last_active_at, sort_order, state)
       VALUES ($1, $2, $3, '/tmp', '/desk', $4, $4, $5, $6)`,
      [id, userId, id, at, order, state],
    )
  }
  for (const [id, userId, workspaceId, at, status, pinnedAt] of [
    ['s1', 'u1', 'w1', '2026-01-01T00:00:00.000Z', 'active', null],
    ['s2', 'u1', 'w1', '2026-01-02T00:00:00.000Z', 'active', '2026-01-05T00:00:00.000Z'],
    ['s3', 'u1', 'w2', '2026-01-03T00:00:00.000Z', 'active', null],
    ['s4', 'u1', 'w2', '2026-01-04T00:00:00.000Z', 'archived', null],
    ['s9', 'u2', 'w9', '2026-01-05T00:00:00.000Z', 'active', '2026-01-06T00:00:00.000Z'],
  ]) {
    await db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, created_at, last_active_at, status, pinned_at)
       VALUES ($1, $2, $3, '', $4, $4, $5, $6)`,
      [id, userId, workspaceId, at, status, pinnedAt],
    )
  }
})

afterEach(async () => {
  await database.drop()
})

describe('workspaceState', () => {
  it('只含当前成员、未归档的工作区，顺序按手动排序', async () => {
    const state = await workspaceState(db, 'u1')
    expect(state.items.map((item) => item.workspaceId)).toEqual(['w2', 'w1'])
    expect(state.items.every((item) => item.path === WORKSPACE_GUEST_ROOT)).toBe(true)
    expect(state.items.map((item) => item.title)).toEqual(['w2', 'w1'])
  })

  it('sessionIds 只有未归档会话，别人的会话不会混进来', async () => {
    const state = await workspaceState(db, 'u1')
    const byId = Object.fromEntries(state.items.map((item) => [item.workspaceId, item.sessionIds]))
    expect(byId).toEqual({ w1: ['s2', 's1'], w2: ['s3'] })
    const all = Object.values(byId).flat()
    expect(all).not.toContain('s4')
    expect(all).not.toContain('s9')
  })

  it('归档与置顶集合只来自当前成员', async () => {
    const state = await workspaceState(db, 'u1')
    expect(state.archivedSessionIds).toEqual(['s4'])
    expect(state.pinnedSessionIds).toEqual(['s2'])
    const other = await workspaceState(db, 'u2')
    expect(other.archivedSessionIds).toEqual([])
    expect(other.pinnedSessionIds).toEqual(['s9'])
    expect(other.items.map((item) => item.workspaceId)).toEqual(['w9'])
  })

  it('成员没有任何工作区时返回空基线（客户端仍然能翻到 ready）', async () => {
    await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u3', 'u3', 'x')`)
    expect(await workspaceState(db, 'u3')).toEqual({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })
  })
})
