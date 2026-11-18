import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { setMemberRole } from '../../src/modules/identity/service.js'

/**
 * 管理员改角色：只接受 admin/member，不能把自己降级；
 * 目标不存在时按 404 处理，不泄露其他信息。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-identity-roles-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role)
     VALUES ('root', '管理员', 'x', 'admin'), ('ivy', '常春藤', 'x', 'member'), ('bob', '鲍勃', 'x', 'member')`,
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('setMemberRole', () => {
  it('把成员升成管理员并回最新视图', async () => {
    expect(await setMemberRole(db, 'root', 'ivy', 'admin')).toEqual({
      id: 'ivy',
      displayName: '常春藤',
      role: 'admin',
      status: 'active',
    })
    const rows = await db.query<{ role: string }>(`SELECT role FROM dsh_users WHERE id = 'ivy'`)
    expect(rows.rows[0]?.role).toBe('admin')
  })

  it('角色前后空白会被去掉，member 也能改回 admin', async () => {
    expect((await setMemberRole(db, 'root', 'ivy', ' admin ')).role).toBe('admin')
    expect((await setMemberRole(db, 'root', 'ivy', 'member')).role).toBe('member')
  })

  it('非法角色一律 422', async () => {
    for (const role of ['superuser', '', '   ', 123, null, undefined]) {
      await expect(setMemberRole(db, 'root', 'ivy', role)).rejects.toThrowError(
        expect.objectContaining({ status: 422, code: 'invalid-role' }),
      )
    }
  })

  it('不能取消自己的管理员角色', async () => {
    await expect(setMemberRole(db, 'root', 'root', 'member')).rejects.toThrowError(
      expect.objectContaining({ status: 422, code: 'cannot-demote-self' }),
    )
    // 把自己再设成 admin 是幂等的。
    expect((await setMemberRole(db, 'root', 'root', 'admin')).role).toBe('admin')
  })

  it('目标用户不存在 404，且不会误改别人', async () => {
    await expect(setMemberRole(db, 'root', 'ghost', 'admin')).rejects.toThrowError(
      expect.objectContaining({ status: 404, code: 'not-found' }),
    )
    const rows = await db.query<{ role: string }>(`SELECT role FROM dsh_users WHERE id = 'bob'`)
    expect(rows.rows[0]?.role).toBe('member')
  })
})
