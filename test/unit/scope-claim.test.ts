import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { sessionAccess } from '../../src/client/scope.js'

const objects: ObjectStore = {
  enabled: () => false,
  put: () => Promise.resolve(),
  get: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ files: [], directories: [], truncated: false }),
}

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-scope-claim-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', 'u2', 'x')`)
})

afterEach(async () => {
  await db.end().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

async function workspaceOf(sessionId: string): Promise<{ workspace_id: string | null; name: string | null }> {
  const rows = await db.query<{ workspace_id: string | null; name: string | null }>(
    `SELECT s.workspace_id, w.name
       FROM dsh_sessions s LEFT JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1`,
    [sessionId],
  )
  return rows.rows[0] ?? { workspace_id: null, name: null }
}

describe('sessionAccess.foreignAgents', () => {
  it('只把别人的顶层会话判为越权，自己与查不到的子会话放行', async () => {
    await db.query(
      `INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES
         ('s_mine', 'u1', '', 'client'),
         ('s_theirs', 'u2', '', 'client')`,
    )
    const access = sessionAccess(db, objects, 'u1')
    // 子会话不在平台表里，交给脑按它自己的 agent 表判；不能在这里误伤。
    expect([...(await access.foreignAgents(['s_mine', 's_theirs', 'agent-child-unknown']))])
      .toEqual(['s_theirs'])
    expect((await access.foreignAgents([])).size).toBe(0)
  })
})

describe('sessionAccess.claim 总会绑定工作区', () => {
  it('新会话不带工作区时落到成员的默认工作区', async () => {
    const access = sessionAccess(db, objects, 'u1')
    await access.claim('s_new')

    const bound = await workspaceOf('s_new')
    expect(bound.workspace_id).toMatch(/^ws_[0-9a-f]{24}$/)
    expect(bound.name).toBe('默认工作区')
    const defaults = await db.query(`SELECT id FROM dsh_workspaces WHERE user_id = 'u1' AND is_default = true`)
    expect(defaults.rows).toHaveLength(1)
  })

  it('已存在但没挂工作区的老会话，claim 时补上默认工作区', async () => {
    await db.query(`INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ('s_old', 'u1', '', 'client')`)
    const access = sessionAccess(db, objects, 'u1')
    await access.claim('s_old')

    const bound = await workspaceOf('s_old')
    expect(bound.workspace_id).not.toBeNull()
    expect(bound.name).toBe('默认工作区')
  })

  it('点名工作区时用它，不再重复建默认块', async () => {
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
       VALUES ('w_named', 'u1', '点名', '/h', '/desk', 'desk-w_named')`,
    )
    const access = sessionAccess(db, objects, 'u1')
    await access.claim('s_named', 'w_named')
    expect((await workspaceOf('s_named')).workspace_id).toBe('w_named')
    const defaults = await db.query(`SELECT id FROM dsh_workspaces WHERE user_id = 'u1' AND is_default = true`)
    expect(defaults.rows).toHaveLength(0)
  })

  it('别人已经占有的会话不会被改写', async () => {
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
       VALUES ('w_other', 'u2', '别人的', '/h', '/desk', 'desk-w_other')`,
    )
    await db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
       VALUES ('s_other', 'u2', 'w_other', '', 'client')`,
    )
    const access = sessionAccess(db, objects, 'u1')
    await access.claim('s_other')
    expect((await workspaceOf('s_other')).workspace_id).toBe('w_other')
    expect(await access.allows('s_other')).toBe(false)
  })
})
