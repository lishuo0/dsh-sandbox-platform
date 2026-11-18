import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { listSandboxes } from '../../src/modules/ops/service.js'

/**
 * 管理页沙箱清单：分页有界、归属和名称来自共享库；
 * 脑还没建表时按空列表处理，不把部署顺序当故障。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-sandbox-list-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ('w1', 'u1', '工作区一', '/var/w1', '/desk'), ('w2', 'u1', '工作区二', '/var/w2', '/desk')`,
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function createSandboxTable(): Promise<void> {
  await db.query(`CREATE TABLE dsh_sandboxes (
    user_id text NOT NULL,
    workspace_id text NOT NULL DEFAULT '',
    session_id text NOT NULL DEFAULT '',
    scope text NOT NULL,
    sandbox_id text NOT NULL UNIQUE,
    platform text NOT NULL DEFAULT 'e2b',
    external_id text NOT NULL,
    endpoint text NOT NULL,
    workspace_root text NOT NULL,
    generation integer NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'creating',
    expires_at text NOT NULL,
    last_used_at text NOT NULL DEFAULT '2026-01-01T00:00:00Z'
  )`)
}

async function addSandbox(id: string, workspaceId: string, sessionId: string, usedAt: string, state = 'ready'): Promise<void> {
  await db.query(
    `INSERT INTO dsh_sandboxes (user_id, workspace_id, session_id, scope, sandbox_id, external_id, endpoint, workspace_root, state, expires_at, last_used_at)
     VALUES ('u1', $1, $2, 'workspace', $3, $3, $4, '/desk', $5, '2026-04-01T00:00:00Z', $6)`,
    [workspaceId, sessionId, id, `https://${id}.e2b.test`, state, usedAt],
  )
}

describe('listSandboxes', () => {
  it('脑还没建表时返回空分页', async () => {
    expect(await listSandboxes(db)).toEqual({ items: [], total: 0, page: 1, page_size: 20 })
  })

  it('分页、倒序并带上成员和工作区名称', async () => {
    await createSandboxTable()
    await addSandbox('sbx-old', 'w1', 's_old', '2026-01-01T00:00:00Z', 'paused')
    await addSandbox('sbx-new', 'w2', 's_new', '2026-02-01T00:00:00Z')

    const page = await listSandboxes(db)
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.sandbox_id)).toEqual(['sbx-new', 'sbx-old'])
    expect(page.items[0]).toMatchObject({
      user_id: 'u1',
      user_display_name: '一',
      workspace_id: 'w2',
      workspace_name: '工作区二',
      session_id: 's_new',
      scope: 'workspace',
      platform: 'e2b',
      state: 'ready',
      endpoint: 'https://sbx-new.e2b.test',
      unknown: true,
      expires_at: '2026-04-01T00:00:00Z',
    })

    const second = await listSandboxes(db, { page: 2, pageSize: 1 })
    expect(second).toMatchObject({ total: 2, page: 2, page_size: 1 })
    expect(second.items.map((item) => item.sandbox_id)).toEqual(['sbx-old'])
  })

  it('页码和每页数量都有边界', async () => {
    await createSandboxTable()
    for (let i = 0; i < 3; i += 1) {
      await addSandbox(`sbx-${i}`, 'w1', `s_${i}`, `2026-02-0${i + 1}T00:00:00Z`)
    }
    expect(await listSandboxes(db, { page: 0, pageSize: 0 })).toMatchObject({ page: 1, page_size: 20 })
    expect(await listSandboxes(db, { page: -3, pageSize: -1 })).toMatchObject({ page: 1, page_size: 20 })
    expect((await listSandboxes(db, { pageSize: 500 })).page_size).toBe(100)
    expect((await listSandboxes(db, { page: 9 })).items).toEqual([])
  })

  it('按登录名和状态过滤，总数跟着过滤条件走', async () => {
    await createSandboxTable()
    await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', '二', 'x')`)
    await addSandbox('sbx-a', 'w1', 's_a', '2026-01-01T00:00:00Z', 'ready')
    await addSandbox('sbx-b', 'w1', 's_b', '2026-01-02T00:00:00Z', 'paused')
    await db.query(
      `INSERT INTO dsh_sandboxes (user_id, workspace_id, session_id, scope, sandbox_id, external_id, endpoint, workspace_root, state, expires_at, last_used_at)
       VALUES ('u2', 'w2', 's_c', 'workspace', 'sbx-c', 'sbx-c', 'https://sbx-c.e2b.test', '/desk', 'ready', '2026-04-01T00:00:00Z', '2026-01-03T00:00:00Z')`,
    )

    const byUser = await listSandboxes(db, { userId: 'u2' })
    expect(byUser.total).toBe(1)
    expect(byUser.items.map((item) => item.sandbox_id)).toEqual(['sbx-c'])
    expect(byUser.items[0]).toMatchObject({ user_display_name: '二' })

    const byState = await listSandboxes(db, { state: 'ready' })
    expect(byState.total).toBe(2)
    expect(byState.items.map((item) => item.sandbox_id)).toEqual(['sbx-c', 'sbx-a'])

    const combined = await listSandboxes(db, { userId: 'u1', state: 'paused' })
    expect(combined.total).toBe(1)
    expect(combined.items.map((item) => item.sandbox_id)).toEqual(['sbx-b'])

    // 空字符串当没传，和路由里的 `?? undefined` 对齐。
    expect((await listSandboxes(db, { userId: '', state: '' })).total).toBe(3)
  })
})
