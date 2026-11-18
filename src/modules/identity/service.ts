import { randomBytes } from 'node:crypto'
import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import { withTx, type Db, type Querier } from '../../kernel/db.js'
import { hashPassword, verifyPassword } from '../../kernel/passwords.js'
import { asBool } from '../../kernel/row.js'

const USERNAME = /^[A-Za-z0-9._-]{1,64}$/

export interface Member {
  id: string
  displayName: string
  role: 'admin' | 'member'
  status: string
  /** 管理员开户或重置密码后为真，成员必须先改密码才能正常使用。 */
  mustChangePassword: boolean
  createdAt: string
}

export interface MemberPatch {
  displayName?: string
  role?: 'admin' | 'member'
  status?: 'active' | 'disabled'
  password?: string
}

export async function findMember(db: Querier, id: string): Promise<Member | undefined> {
  const rows = await db.query(
    `SELECT id, display_name, role, status, must_change_password, created_at FROM dsh_users WHERE id = $1`,
    [id],
  )
  return mapMember(rows.rows[0])
}

export async function authenticate(db: Querier, username: string, password: string): Promise<Member | undefined> {
  const rows = await db.query(
    `SELECT id, display_name, role, status, must_change_password, created_at, password_hash
       FROM dsh_users WHERE id = $1`,
    [username],
  )
  const row = rows.rows[0] as unknown as (MemberRow & { password_hash: string }) | undefined
  if (!row || row.status !== 'active' || !verifyPassword(password, row.password_hash)) return undefined
  return mapMember(row)
}

export async function listMembers(db: Querier): Promise<Member[]> {
  const rows = await db.query(
    `SELECT id, display_name, role, status, must_change_password, created_at FROM dsh_users ORDER BY created_at`,
  )
  return rows.rows.map((row) => mapMember(row)!).filter(Boolean)
}

export async function createMember(
  db: Querier,
  input: { username: string; displayName?: string; password: string; role: 'admin' | 'member'; mustChangePassword?: boolean },
): Promise<Member> {
  assertUsername(input.username)
  assertPassword(input.password)
  try {
    await db.query(
      `INSERT INTO dsh_users (id, display_name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.username,
        input.displayName?.trim() || input.username,
        hashPassword(input.password),
        input.role,
        input.mustChangePassword === true,
      ],
    )
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'username-taken')
    throw error
  }
  const member = await findMember(db, input.username)
  if (!member) throw new HttpError(500, 'internal')
  return member
}

/**
 * 管理员开户：密码留空时服务端生成一个，返回值只出现这一次。
 * 无论密码是谁定的，成员首次登录都必须先改掉。
 */
export async function createMemberAccount(
  db: Querier,
  input: { username: string; displayName?: string; password?: string; role: 'admin' | 'member' },
): Promise<{ member: Member; initialPassword?: string }> {
  const given = (input.password ?? '').trim()
  const initialPassword = given === '' ? generatePassword() : undefined
  const member = await createMember(db, {
    username: input.username,
    displayName: input.displayName,
    password: given === '' ? initialPassword! : given,
    role: input.role,
    mustChangePassword: true,
  })
  return initialPassword === undefined ? { member } : { member, initialPassword }
}

/** 管理员重置密码：同样只回一次新密码，并要求本人再改。 */
export async function resetMemberPassword(
  db: Querier,
  id: string,
  password?: string,
): Promise<{ initialPassword: string }> {
  const existing = await findMember(db, id)
  if (!existing) throw new HttpError(404, 'not-found')
  const given = (password ?? '').trim()
  const initialPassword = given === '' ? generatePassword() : given
  assertPassword(initialPassword)
  await db.query(
    `UPDATE dsh_users SET password_hash = $2, must_change_password = $3 WHERE id = $1`,
    [id, hashPassword(initialPassword), true],
  )
  return { initialPassword }
}

/** 成员自己改密码：必须校验旧密码，成功后清掉强制改密标记。 */
export async function changeOwnPassword(
  db: Querier,
  id: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const rows = await db.query<{ password_hash: string; status: string }>(
    `SELECT password_hash, status FROM dsh_users WHERE id = $1`,
    [id],
  )
  const row = rows.rows[0]
  if (!row || row.status !== 'active') throw new HttpError(401, 'unauthorized')
  if (!verifyPassword(currentPassword, row.password_hash)) throw new HttpError(401, 'invalid-password')
  assertPassword(newPassword)
  await db.query(`UPDATE dsh_users SET password_hash = $2, must_change_password = $3 WHERE id = $1`, [
    id,
    hashPassword(newPassword),
    false,
  ])
}

export async function updateMember(db: Db, id: string, patch: MemberPatch): Promise<void> {
  if (patch.password) assertPassword(patch.password)
  await withTx(db, async (tx) => {
    const locked = await tx.query(`SELECT id, role, status FROM dsh_users WHERE id = $1 FOR UPDATE`, [id])
    const current = locked.rows[0] as { role: string; status: string } | undefined
    if (!current) throw new HttpError(404, 'not-found')
    const nextRole = patch.role ?? current.role
    const nextStatus = patch.status ?? current.status
    const leavingAdmin = current.role === 'admin' && current.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active')
    if (leavingAdmin) {
      const others = await tx.query(
        `SELECT 1 FROM dsh_users WHERE role = 'admin' AND status = 'active' AND id <> $1 FOR UPDATE`,
        [id],
      )
      if (!others.rowCount) throw new HttpError(409, 'last-admin')
    }
    await tx.query(
      `UPDATE dsh_users
          SET display_name = COALESCE($2, display_name),
              role = COALESCE($3, role),
              status = COALESCE($4, status),
              password_hash = COALESCE($5, password_hash),
              must_change_password = CASE WHEN $5 IS NULL THEN must_change_password ELSE $6 END
        WHERE id = $1`,
      [
        id,
        patch.displayName ?? null,
        patch.role ?? null,
        patch.status ?? null,
        patch.password ? hashPassword(patch.password) : null,
        patch.password ? true : null,
      ],
    )
  })
}

/** 管理员改别人的角色；不允许顺手把自己降级，避免误操作丢掉管理入口。 */
export async function setMemberRole(db: Db, actorId: string, targetId: string, rawRole: unknown): Promise<Member> {
  const role = typeof rawRole === 'string' ? rawRole.trim() : ''
  if (role !== 'admin' && role !== 'member') throw new HttpError(422, 'invalid-role')
  if (targetId === actorId && role !== 'admin') throw new HttpError(422, 'cannot-demote-self')
  await updateMember(db, targetId, { role })
  const updated = await findMember(db, targetId)
  if (!updated) throw new HttpError(404, 'not-found')
  return updated
}

export async function ensureAdmin(db: Querier, username: string, password: string): Promise<void> {
  const existing = await db.query(`SELECT 1 FROM dsh_users WHERE role = 'admin' AND status = 'active' LIMIT 1`)
  if (existing.rowCount) return
  assertUsername(username)
  assertPassword(password)
  await createMember(db, { username, password, role: 'admin' })
}

export function assertUsername(username: string): void {
  if (!USERNAME.test(username) || username === '.' || username === '..') throw new HttpError(422, 'invalid-username')
}

export function assertPassword(password: string): void {
  if (password.length < 6) throw new HttpError(422, 'password-too-short')
}

/** 16 字符随机初始密码；base64url 不含需要转义的字符，方便直接抄给成员。 */
function generatePassword(): string {
  return randomBytes(12).toString('base64url')
}

interface MemberRow {
  id: string
  display_name: string
  role: string
  status: string
  must_change_password: unknown
  created_at: unknown
}

function mapMember(row: unknown): Member | undefined {
  if (!row || typeof row !== 'object') return undefined
  const value = row as MemberRow
  return {
    id: value.id,
    displayName: value.display_name,
    role: value.role === 'admin' ? 'admin' : 'member',
    status: value.status,
    mustChangePassword: asBool(value.must_change_password),
    createdAt: iso(value.created_at),
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : ''
}
