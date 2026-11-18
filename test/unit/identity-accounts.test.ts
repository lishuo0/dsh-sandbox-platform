import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  authenticate,
  changeOwnPassword,
  createMemberAccount,
  findMember,
  resetMemberPassword,
  updateMember,
} from '../../src/modules/identity/service.js'

/**
 * 账号生命周期：管理员开户 → 临时口令强制改密 → 自助改密 / 重置 / 停用。
 *
 * 平台对外的数据面由 kernel/surface 的白名单把关，这里盯服务层自己的状态机：
 * 初始密码只出现一次、任何一次重置都把强制改密标回来、本人改密后清标记。
 */

let dir: string
let db: SqliteDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-identity-accounts-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('管理员开户', () => {
  it('不填密码时服务端生成 16 位口令，只回一次，并要求首次登录改密', async () => {
    const created = await createMemberAccount(db, { username: 'ivy', role: 'member' })
    expect(created.initialPassword).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(created.member).toMatchObject({
      id: 'ivy',
      displayName: 'ivy',
      role: 'member',
      status: 'active',
      mustChangePassword: true,
    })
    // 返回值是唯一一次初始口令；用它能登录。
    const signedIn = await authenticate(db, 'ivy', created.initialPassword!)
    expect(signedIn?.mustChangePassword).toBe(true)
    // 落库的是哈希，不是明文。
    const rows = await db.query<{ password_hash: string }>(`SELECT password_hash FROM dsh_users WHERE id = 'ivy'`)
    expect(rows.rows[0]?.password_hash).not.toContain(created.initialPassword)
  })

  it('管理员指定初始密码时不回密码，但同样强制首次改密', async () => {
    const created = await createMemberAccount(db, { username: 'bob', password: 'bob-password-1234', role: 'member' })
    expect(created).not.toHaveProperty('initialPassword')
    expect(created.member.mustChangePassword).toBe(true)
    expect(await authenticate(db, 'bob', 'bob-password-1234')).toBeTruthy()
  })

  it('显示名留空时用登录名，重复登录名 409', async () => {
    const created = await createMemberAccount(db, { username: 'ivy', displayName: '  ', role: 'admin' })
    expect(created.member.displayName).toBe('ivy')
    expect(created.member.role).toBe('admin')
    await expect(createMemberAccount(db, { username: 'ivy', role: 'member' })).rejects.toThrowError(
      expect.objectContaining({ status: 409, code: 'username-taken' }),
    )
  })

  it('登录名和密码都有格式下限', async () => {
    for (const username of ['', 'has space', 'a/b', '..']) {
      await expect(createMemberAccount(db, { username, role: 'member' })).rejects.toThrowError(
        expect.objectContaining({ status: 422, code: 'invalid-username' }),
      )
    }
    await expect(
      createMemberAccount(db, { username: 'ivy', password: 'short', role: 'member' }),
    ).rejects.toThrowError(expect.objectContaining({ status: 422, code: 'password-too-short' }))
  })
})

describe('重置密码', () => {
  it('重置后旧密码失效、强制改密标回来', async () => {
    await createMemberAccount(db, { username: 'ivy', password: 'ivy-password-1234', role: 'member' })
    await changeOwnPassword(db, 'ivy', 'ivy-password-1234', 'ivy-password-5678')
    expect((await findMember(db, 'ivy'))?.mustChangePassword).toBe(false)

    const reset = await resetMemberPassword(db, 'ivy')
    expect(reset.initialPassword).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(await authenticate(db, 'ivy', 'ivy-password-5678')).toBeUndefined()
    const refreshed = await authenticate(db, 'ivy', reset.initialPassword)
    expect(refreshed?.mustChangePassword).toBe(true)
  })

  it('管理员自带新口令重置时同样要求本人再改', async () => {
    await createMemberAccount(db, { username: 'ivy', password: 'ivy-password-1234', role: 'member' })
    const reset = await resetMemberPassword(db, 'ivy', 'ivy-password-9999')
    expect(reset.initialPassword).toBe('ivy-password-9999')
    expect((await findMember(db, 'ivy'))?.mustChangePassword).toBe(true)
  })

  it('目标不存在 404，口令太短 422', async () => {
    await expect(resetMemberPassword(db, 'ghost')).rejects.toThrowError(
      expect.objectContaining({ status: 404, code: 'not-found' }),
    )
    await createMemberAccount(db, { username: 'ivy', role: 'member' })
    await expect(resetMemberPassword(db, 'ivy', 'short')).rejects.toThrowError(
      expect.objectContaining({ status: 422, code: 'password-too-short' }),
    )
  })
})

describe('本人改密', () => {
  it('旧密码不对 401，新密码太短 422，改完清掉强制标记', async () => {
    await createMemberAccount(db, { username: 'ivy', password: 'ivy-password-1234', role: 'member' })
    await expect(changeOwnPassword(db, 'ivy', 'wrong-password-1234', 'ivy-password-5678')).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid-password' }),
    )
    await expect(changeOwnPassword(db, 'ivy', 'ivy-password-1234', 'short')).rejects.toThrowError(
      expect.objectContaining({ status: 422, code: 'password-too-short' }),
    )
    await changeOwnPassword(db, 'ivy', 'ivy-password-1234', 'ivy-password-5678')
    const member = await findMember(db, 'ivy')
    expect(member?.mustChangePassword).toBe(false)
    expect(await authenticate(db, 'ivy', 'ivy-password-1234')).toBeUndefined()
    expect(await authenticate(db, 'ivy', 'ivy-password-5678')).toBeTruthy()
  })

  it('停用账号即使密码正确也不能换密码', async () => {
    await createMemberAccount(db, { username: 'ivy', password: 'ivy-password-1234', role: 'member' })
    await updateMember(db, 'ivy', { status: 'disabled' })
    await expect(
      changeOwnPassword(db, 'ivy', 'ivy-password-1234', 'ivy-password-5678'),
    ).rejects.toThrowError(expect.objectContaining({ status: 401, code: 'unauthorized' }))
  })
})

describe('管理员改资料', () => {
  it('带上新密码时同样把强制改密标回来', async () => {
    await createMemberAccount(db, { username: 'ivy', password: 'ivy-password-1234', role: 'member' })
    await changeOwnPassword(db, 'ivy', 'ivy-password-1234', 'ivy-password-5678')
    await updateMember(db, 'ivy', { displayName: '常春藤', password: 'ivy-password-9999' })
    const member = await findMember(db, 'ivy')
    expect(member).toMatchObject({ displayName: '常春藤', mustChangePassword: true })
    expect(await authenticate(db, 'ivy', 'ivy-password-9999')).toBeTruthy()
  })

  it('最后一个启用管理员不能被降级或停用', async () => {
    await createMemberAccount(db, { username: 'root', password: 'root-password-1234', role: 'admin' })
    await expect(updateMember(db, 'root', { role: 'member' })).rejects.toThrowError(
      expect.objectContaining({ status: 409, code: 'last-admin' }),
    )
    await expect(updateMember(db, 'root', { status: 'disabled' })).rejects.toThrowError(
      expect.objectContaining({ status: 409, code: 'last-admin' }),
    )
  })

  it('还有别的管理员时允许降级', async () => {
    await createMemberAccount(db, { username: 'root', password: 'root-password-1234', role: 'admin' })
    await createMemberAccount(db, { username: 'backup', password: 'backup-password-1234', role: 'admin' })
    await updateMember(db, 'root', { role: 'member' })
    expect((await findMember(db, 'root'))?.role).toBe('member')
  })
})
