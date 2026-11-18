import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { isSlug } from '../../kernel/layout.js'
import { asBool, asJson } from '../../kernel/row.js'
import { seal } from '../../kernel/seal.js'
import { requireGroupForMember } from '../groups/service.js'

const HEADER = /^[A-Za-z0-9-]+$/
const KIND = 'mcp-header'

export type McpScope = 'private' | 'public'

interface Actor {
  id: string
  role: string
}

interface McpRow {
  user_id: string
  display_name: string
  server_name: string
  target: string
  config: unknown
  enabled: unknown
  scope: McpScope
  group_id: string | null
  updated_at: string
}

interface McpConfig {
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
}

export interface HeaderSpec {
  secret?: string
  value?: string
  /** 保留数据库里已有的值（含加密引用），用于编辑时不想重填密钥。 */
  keepSecret?: boolean
}

export async function listMcp(db: Querier, viewerId: string) {
  const rows = await db.query(
    `SELECT m.user_id, u.display_name, m.server_name, m.target, m.config, m.enabled, m.scope, m.group_id, m.updated_at
       FROM dsh_mcp_servers m JOIN dsh_users u ON u.id = m.user_id
      WHERE m.user_id = $1 OR m.scope = 'public'
      ORDER BY m.scope, m.server_name`,
    [viewerId],
  )
  return rows.rows.map((row) => summaryOf(row as unknown as McpRow, viewerId))
}

export async function getMcp(db: Querier, user: Actor, name: string, scope: McpScope) {
  return summaryOf(await requireMcp(db, user, name, scope), user.id)
}

export async function saveMcp(
  db: Querier,
  key: Buffer,
  actor: Actor,
  input: {
    name: string
    url: string
    scope: McpScope
    timeoutMs?: number
    headers?: Record<string, HeaderSpec>
    groupId?: string | null
  },
): Promise<void> {
  if (!isSlug(input.name)) throw new HttpError(422, 'invalid-name')
  if (!input.url.startsWith('https://')) throw new HttpError(422, 'invalid-url')
  if (input.scope === 'public' && actor.role !== 'admin') throw new HttpError(403, 'admin-only')
  const previous = await findForScope(db, actor.id, input.name, input.scope)
  if (previous === undefined && (await ownsOtherScope(db, actor.id, input.name, input.scope))) {
    throw new HttpError(409, 'name-taken')
  }
  const groupId = await groupOf(db, actor, input.scope, input.groupId)
  const owner = previous?.user_id ?? actor.id
  const previousConfig = parseConfig(previous?.config)
  const stored = await headersOf(db, key, owner, input.name, previousConfig?.headers, input.headers)
  const timeoutMs = input.timeoutMs ?? previousConfig?.toolCallTimeoutMs
  const config = {
    headers: stored,
    ...(timeoutMs ? { toolCallTimeoutMs: timeoutMs } : {}),
  }
  if (previous !== undefined) {
    await db.query(
      `UPDATE dsh_mcp_servers SET target = $4, config = $5::jsonb, group_id = $6, updated_at = now()
        WHERE user_id = $1 AND server_name = $2 AND scope = $3`,
      [owner, input.name, input.scope, input.url, JSON.stringify(config), groupId],
    )
    return
  }
  try {
    await db.query(
      `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, config, scope, group_id)
       VALUES ($1, $2, 'streamable-http', $3, $4::jsonb, $5, $6)`,
      [owner, input.name, input.url, JSON.stringify(config), input.scope, groupId],
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    throw new HttpError(409, 'name-taken')
  }
}

/** 分组必须是调用者看得见的；公开 server 只能挂公开分组。 */
async function groupOf(
  db: Querier,
  actor: Actor,
  scope: McpScope,
  groupId: string | null | undefined,
): Promise<string | null> {
  if (groupId === undefined || groupId === null || groupId.trim() === '') return null
  const group = await requireGroupForMember(db, actor, 'mcp', groupId.trim())
  if (scope === 'public' && group.visibility !== 'public') throw new HttpError(422, 'invalid-group')
  return group.id
}

export async function setMcpEnabled(
  db: Querier,
  user: Actor,
  name: string,
  scope: McpScope,
  enabled: boolean,
): Promise<void> {
  if (scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  const result = await db.query(
    `UPDATE dsh_mcp_servers SET enabled = $4, updated_at = now()
      WHERE server_name = $2 AND scope = $3 AND ($3 = 'public' OR user_id = $1)`,
    [user.id, name, scope, enabled],
  )
  if (!result.rowCount) throw new HttpError(404, 'not-found')
}

export async function removeMcp(
  db: Querier,
  user: Actor,
  name: string,
  scope: McpScope,
): Promise<void> {
  const row = await requireEditable(db, user, name, scope)
  const removed = await db.query(
    `DELETE FROM dsh_mcp_servers WHERE user_id = $1 AND server_name = $2 AND scope = $3`,
    [row.user_id, name, scope],
  )
  if (!removed.rowCount) throw new HttpError(404, 'not-found')
  await db.query(
    `DELETE FROM dsh_workspace_mcp_servers
      WHERE server_name = $1 AND server_scope = $2
        AND ($2 = 'public' OR workspace_id IN (SELECT id FROM dsh_workspaces WHERE user_id = $3))`,
    [name, scope, row.user_id],
  )
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name LIKE $3`, [
    row.user_id,
    KIND,
    `${name}/%`,
  ])
}

function summaryOf(row: McpRow, viewerId: string) {
  const config = parseConfig(row.config)
  const headers = Object.entries(config?.headers ?? {}).map(([name, stored]) =>
    stored.startsWith('cred:mcp/')
      ? { name, secret: true }
      : { name, secret: false, value: stored },
  )
  return {
    name: row.server_name,
    url: row.target,
    scope: row.scope,
    group_id: row.group_id ?? null,
    enabled: asBool(row.enabled),
    timeoutMs: config?.toolCallTimeoutMs ?? null,
    headers,
    updatedAt: row.updated_at,
    ownerId: row.user_id,
    ownerDisplayName: row.display_name,
    mine: row.user_id === viewerId,
  }
}

async function requireMcp(db: Querier, user: Actor, name: string, scope: McpScope): Promise<McpRow> {
  const rows = await db.query(
    `SELECT m.user_id, u.display_name, m.server_name, m.target, m.config, m.enabled, m.scope, m.group_id, m.updated_at
       FROM dsh_mcp_servers m JOIN dsh_users u ON u.id = m.user_id
      WHERE m.server_name = $1 AND m.scope = $2`,
    [name, scope],
  )
  const row = rows.rows[0] as unknown as McpRow | undefined
  if (row === undefined) throw new HttpError(404, 'not-found')
  if (scope === 'private' && row.user_id !== user.id) throw new HttpError(404, 'not-found')
  return row
}

async function requireEditable(db: Querier, user: Actor, name: string, scope: McpScope): Promise<McpRow> {
  const row = await requireMcp(db, user, name, scope)
  if (scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  return row
}

async function findForScope(
  db: Querier,
  userId: string,
  name: string,
  scope: McpScope,
): Promise<McpRow | undefined> {
  const rows = await db.query(
    `SELECT user_id, server_name, target, config, enabled, scope, updated_at
       FROM dsh_mcp_servers
      WHERE server_name = $1 AND scope = $2 AND ($2 = 'public' OR user_id = $3)`,
    [name, scope, userId],
  )
  return rows.rows[0] as unknown as McpRow | undefined
}

async function ownsOtherScope(db: Querier, userId: string, name: string, scope: McpScope): Promise<boolean> {
  const other = scope === 'public' ? 'private' : 'public'
  const rows = await db.query(
    `SELECT 1 FROM dsh_mcp_servers WHERE user_id = $1 AND server_name = $2 AND scope = $3`,
    [userId, name, other],
  )
  return rows.rows.length > 0
}

/** 不传 headers 就保留原来的；传入则整组替换。密钥写成脑能解开的引用。 */
async function headersOf(
  db: Querier,
  key: Buffer,
  owner: string,
  name: string,
  previous: Record<string, string> | undefined,
  headers: Record<string, HeaderSpec> | undefined,
): Promise<Record<string, string>> {
  if (headers === undefined) return previous ?? {}
  const stored: Record<string, string> = {}
  for (const [header, spec] of Object.entries(headers)) {
    if (!HEADER.test(header)) throw new HttpError(422, 'invalid-header')
    if (spec.keepSecret) {
      const kept = previous?.[header]
      if (kept === undefined) throw new HttpError(422, 'missing-secret')
      stored[header] = kept
      continue
    }
    if (typeof spec.secret === 'string' && spec.secret.length > 0) {
      const ref = `${name}/${header}`
      await db.query(
        `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
        [owner, KIND, ref, seal(key, spec.secret)],
      )
      stored[header] = `cred:mcp/${ref}`
    } else if (typeof spec.value === 'string' && spec.value.length > 0) {
      stored[header] = spec.value
    }
  }
  return stored
}

function parseConfig(value: unknown): McpConfig | undefined {
  return asJson<McpConfig | undefined>(value)
}
