import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareClientHome } from '../../src/client/workspaces.js'
import { migrate } from '../../src/kernel/db.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'

/**
 * 首页加载前的准备：成员必须有工作区，否则客户端首页的输入框一直是禁用的
 * （选择器没有可选项，点「选择一个工作区开始」什么也选不到）。
 */

const objects: ObjectStore = {
  enabled: () => false,
  put: () => Promise.resolve(),
  get: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ files: [], directories: [], truncated: false }),
}

let dir: string
let db: SqliteDb
let synced: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-home-workspace-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', 'u2', 'x')`)
  synced = []
})

afterEach(async () => {
  await db.end().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

const brain = {
  syncWorkspaces: (userId: string) => {
    synced.push(userId)
    return Promise.resolve({ ok: true })
  },
}

describe('prepareClientHome', () => {
  it('新成员没有工作区时补一块默认工作区，并让脑重新投影', async () => {
    await prepareClientHome({ db, objects, brain, userId: 'u1' })

    const rows = await db.query<{ id: string; name: string; guest_root: string; is_default: unknown }>(
      `SELECT id, name, guest_root, is_default FROM dsh_workspaces WHERE user_id = $1`,
      ['u1'],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.name).toBe('默认工作区')
    expect(rows.rows[0]?.guest_root).toBe('/desk')
    expect(Boolean(rows.rows[0]?.is_default)).toBe(true)
    expect(synced).toEqual(['u1'])
  })

  it('已经有默认工作区时不再建第二块，但仍然同步投影', async () => {
    await prepareClientHome({ db, objects, brain, userId: 'u1' })
    const first = await db.query<{ id: string }>(`SELECT id FROM dsh_workspaces WHERE user_id = $1`, ['u1'])

    await prepareClientHome({ db, objects, brain, userId: 'u1' })
    const again = await db.query<{ id: string }>(`SELECT id FROM dsh_workspaces WHERE user_id = $1`, ['u1'])

    expect(again.rows).toEqual(first.rows)
    // 每次加载首页都同步一次：脑重启后丢失的投影在这里补回。
    expect(synced).toEqual(['u1', 'u1'])
  })

  it('只有手建的工作区（没有默认块）时补一块默认，不动手建的那块', async () => {
    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
       VALUES ('ws_manual0000000000000000', 'u2', '手建的工作区', '/var/agent-desk/u2/ws_manual0000000000000000', '/desk', 'desk-ws_manual0000000000000000')`,
    )

    await prepareClientHome({ db, objects, brain, userId: 'u2' })

    const rows = await db.query<{ id: string; name: string; is_default: unknown }>(
      `SELECT id, name, is_default FROM dsh_workspaces WHERE user_id = $1 ORDER BY name`,
      ['u2'],
    )
    expect(rows.rows.map((row) => row.name)).toEqual(['手建的工作区', '默认工作区'])
    expect(rows.rows.filter((row) => Boolean(row.is_default))).toHaveLength(1)
    expect(synced).toEqual(['u2'])
  })
})
