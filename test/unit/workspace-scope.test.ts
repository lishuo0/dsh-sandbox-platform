import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { interceptWorkspace, viewOf } from '../../src/client/workspaces.js'
import type { BrainClient } from '../../src/brain/client.js'
import type { Db } from '../../src/kernel/db.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.js'

/**
 * 排序、置顶、归档都按成员落库。脑上的状态是所有租户共用的，所以这里逐条确认：
 * 只动调用者自己的行，跨租户的 id 一律拒绝，返回的 id 也只来自调用者。
 */

let database: TestDatabase
let db: Db
let syncs: number

beforeEach(async () => {
  database = await createTestDatabase()
  db = database.pool
  syncs = 0
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, 'u1', 'x'), ($2, 'u2', 'x')`, ['u1', 'u2'])
  // u1 有三块工作区，最近活跃倒序是 w3、w2、w1；u2 有一块 w9。
  for (const [id, userId, at] of [
    ['w1', 'u1', '2026-01-01T00:00:00.000Z'],
    ['w2', 'u1', '2026-01-02T00:00:00.000Z'],
    ['w3', 'u1', '2026-01-03T00:00:00.000Z'],
    ['w9', 'u2', '2026-01-04T00:00:00.000Z'],
  ]) {
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, created_at, last_active_at)
       VALUES ($1, $2, $3, '/tmp', '/desk', $4, $4)`,
      [id, userId, id, at],
    )
  }
  for (const [id, userId, workspaceId, at] of [
    ['s1', 'u1', 'w1', '2026-01-01T00:00:00.000Z'],
    ['s2', 'u1', 'w1', '2026-01-02T00:00:00.000Z'],
    ['s3', 'u1', 'w1', '2026-01-03T00:00:00.000Z'],
    ['s9', 'u2', 'w9', '2026-01-04T00:00:00.000Z'],
  ]) {
    await db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, created_at, last_active_at)
       VALUES ($1, $2, $3, '', $4, $4)`,
      [id, userId, workspaceId, at],
    )
  }
})

afterEach(async () => {
  await database.drop()
})

function call(userId: string, path: string, request: Record<string, unknown>): Promise<unknown> {
  const context = {
    db,
    objects: {} as ObjectStore,
    brain: { syncWorkspaces: async () => { syncs += 1 } } as unknown as BrainClient,
    userId,
  }
  return interceptWorkspace(
    path,
    { type: 'client-request', rpcId: 'rpc-1', payload: { args: { request } } },
    context,
  ).then((text) => JSON.parse(text as string) as unknown)
}

function value(frame: unknown): Record<string, unknown> {
  return (frame as { result: { ok: boolean; value: Record<string, unknown> } }).result.value
}

function errorCode(frame: unknown): string {
  return (frame as { result: { ok: boolean; error: { code: string } } }).result.error.code
}

async function sortOrders(): Promise<Record<string, number>> {
  const rows = await db.query<{ id: string; sort_order: number }>(`SELECT id, sort_order FROM dsh_workspaces`)
  return Object.fromEntries(rows.rows.map((row) => [row.id, row.sort_order]))
}

describe('工作区排序 / 置顶只作用于调用者', () => {
  it('insertBefore 只重排自己的工作区，返回的 id 也只有自己的', async () => {
    const frame = await call('u1', 'workspace/insertBefore', { workspaceId: 'w1', beforeWorkspaceId: 'w3' })
    expect(value(frame)).toEqual({ workspaceIds: ['w1', 'w3', 'w2'] })
    expect(await sortOrders()).toEqual({ w1: 1, w3: 2, w2: 3, w9: 0 })
    expect(syncs).toBe(1)
  })

  it('insertBefore 拒绝别人的 beforeWorkspaceId', async () => {
    const frame = await call('u1', 'workspace/insertBefore', { workspaceId: 'w1', beforeWorkspaceId: 'w9' })
    expect(errorCode(frame)).toBe('workspace/not-found')
    expect(await sortOrders()).toEqual({ w1: 0, w2: 0, w3: 0, w9: 0 })
  })

  it('insertBefore 拒绝别人的 workspaceId', async () => {
    const frame = await call('u1', 'workspace/insertBefore', { workspaceId: 'w9', beforeWorkspaceId: 'w1' })
    expect(errorCode(frame)).toBe('workspace/not-found')
  })

  it('insertSessionBefore 只重排同一工作区里的会话', async () => {
    const frame = await call('u1', 'workspace/insertSessionBefore', {
      workspaceId: 'w1',
      sessionId: 's1',
      beforeSessionId: 's3',
    })
    expect(value(frame)).toMatchObject({
      workspace: { workspaceId: 'w1', sessionIds: ['s1', 's3', 's2'] },
    })
    const rows = await db.query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM dsh_sessions WHERE id IN ('s1', 's2', 's3')`,
    )
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.sort_order]))).toEqual({ s1: 1, s3: 2, s2: 3 })
    expect(syncs).toBe(1)
  })

  it('insertSessionBefore 拒绝把别人的会话拖进来', async () => {
    const frame = await call('u1', 'workspace/insertSessionBefore', {
      workspaceId: 'w1',
      sessionId: 's9',
      beforeSessionId: 's1',
    })
    // 跨租户按不存在处理，不暴露会话确实存在。
    expect(errorCode(frame)).toBe('session/not-found')
  })

  it('insertSessionBefore 拒绝把会话拖到别的工作区', async () => {
    const frame = await call('u1', 'workspace/insertSessionBefore', {
      workspaceId: 'w2',
      sessionId: 's2',
      beforeSessionId: 's1',
    })
    expect(errorCode(frame)).toBe('workspace/move-invalid')
  })

  it('insertSessionBefore 拒绝别人的工作区', async () => {
    const frame = await call('u1', 'workspace/insertSessionBefore', {
      workspaceId: 'w9',
      sessionId: 's1',
    })
    expect(errorCode(frame)).toBe('workspace/not-found')
  })

  it('pinSession 返回的置顶集合只有调用者自己的会话', async () => {
    expect(value(await call('u1', 'workspace/pinSession', { sessionId: 's1' }))).toEqual({
      pinnedSessionIds: ['s1'],
    })
    expect(value(await call('u1', 'workspace/pinSession', { sessionId: 's2' }))).toEqual({
      pinnedSessionIds: ['s2', 's1'],
    })
    const foreign = await db.query<{ pinned_at: string | null }>(`SELECT pinned_at FROM dsh_sessions WHERE id = 's9'`)
    expect(foreign.rows[0]?.pinned_at).toBeNull()
  })

  it('pinSession 拒绝别人的会话', async () => {
    const frame = await call('u1', 'workspace/pinSession', { sessionId: 's9' })
    expect(errorCode(frame)).toBe('session/not-found')
  })

  it('pinSession 拒绝归档会话，archiveSession 会清掉置顶', async () => {
    await call('u1', 'workspace/pinSession', { sessionId: 's1' })
    await call('u1', 'workspace/archiveSession', { sessionId: 's1' })
    const pinned = await db.query<{ pinned_at: string | null }>(`SELECT pinned_at FROM dsh_sessions WHERE id = 's1'`)
    expect(pinned.rows[0]?.pinned_at).toBeNull()
    const frame = await call('u1', 'workspace/pinSession', { sessionId: 's1' })
    expect(errorCode(frame)).toBe('gateway/bad-request')
  })

  it('unpinSession 只清自己的置顶', async () => {
    await call('u1', 'workspace/pinSession', { sessionId: 's1' })
    expect(value(await call('u1', 'workspace/unpinSession', { sessionId: 's1' }))).toEqual({
      pinnedSessionIds: [],
    })
  })

  it('viewOf 按平台记录的 sort_order 返回会话', async () => {
    await call('u1', 'workspace/insertSessionBefore', {
      workspaceId: 'w1',
      sessionId: 's1',
      beforeSessionId: 's3',
    })
    const view = await viewOf(db, 'u1', 'w1')
    expect(view?.sessionIds).toEqual(['s1', 's3', 's2'])
    // 别人的工作区读不到。
    expect(await viewOf(db, 'u1', 'w9')).toBeUndefined()
  })
})
