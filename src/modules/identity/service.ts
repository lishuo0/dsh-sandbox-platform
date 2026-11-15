import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import { withTx, type Db, type Querier } from '../../kernel/db.js'
import { hashPassword, verifyPassword } from '../../kernel/passwords.js'

const USERNAME = /^[A-Za-z0-9._-]{1,64}$/

export interface Member {
  id: string
  displayName: string
  role: 'admin' | 'member'
  status: string
}

export interface MemberPatch {
  displayName?: string
  role?: 'admin' | 'member'
  status?: 'active' | 'disabled'
  password?: string
}

export async function findMember(db: Querier, id: string): Promise<Member | undefined> {
  const rows = await db.query(`SELECT id, display_name, role, status FROM dsh_users WHERE id = $1`, [id])
  return mapMember(rows.rows[0])
}

export async function authenticate(db: Querier, username: string, password: string): Promise<Member | undefined> {
  const rows = await db.query(`SELECT id, display_name, role, status, password_hash FROM dsh_users WHERE id = $1`, [username])
  const row = rows.rows[0] as (MemberRow & { password_hash: string }) | undefined
  if (!row || row.status !== 'active' || !verifyPassword(password, row.password_hash)) return undefined
  return mapMember(row)
}

export async function listMembers(db: Querier): Promise<Member[]> {
  const rows = await db.query(`SELECT id, display_name, role, status FROM dsh_users ORDER BY created_at`)
  return rows.rows.map((row) => mapMember(row)!).filter(Boolean)
}

export async function createMember(
  db: Querier,
  input: { username: string; displayName?: string; password: string; role: 'admin' | 'member' },
): Promise<Member> {
  assertUsername(input.username)
  assertPassword(input.password)
  try {
    await db.query(`INSERT INTO dsh_users (id, display_name, password_hash, role) VALUES ($1, $2, $3, $4)`, [
      input.username,
      input.displayName?.trim() || input.username,
      hashPassword(input.password),
      input.role,
    ])
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, 'username-taken')
    throw error
  }
  return { id: input.username, displayName: input.displayName?.trim() || input.username, role: input.role, status: 'active' }
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
              password_hash = COALESCE($5, password_hash)
        WHERE id = $1`,
      [id, patch.displayName ?? null, patch.role ?? null, patch.status ?? null, patch.password ? hashPassword(patch.password) : null],
    )
  })
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
  if (password.length < 12) throw new HttpError(422, 'password-too-short')
}

interface MemberRow {
  id: string
  display_name: string
  role: string
  status: string
}

function mapMember(row: unknown): Member | undefined {
  if (!row || typeof row !== 'object') return undefined
  const value = row as MemberRow
  return {
    id: value.id,
    displayName: value.display_name,
    role: value.role === 'admin' ? 'admin' : 'member',
    status: value.status,
  }
}
