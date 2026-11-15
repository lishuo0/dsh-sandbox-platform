import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { isSlug } from '../../kernel/layout.js'
import { seal } from '../../kernel/seal.js'

const HEADER = /^[A-Za-z0-9-]+$/
const KIND = 'mcp-header'

export async function listMcp(db: Querier, userId: string) {
  const rows = await db.query(
    `SELECT server_name, target, config, enabled, updated_at FROM dsh_mcp_servers WHERE user_id = $1 ORDER BY server_name`,
    [userId],
  )
  return rows.rows.map((row) => {
    const value = row as { server_name: string; target: string; config: { headers?: Record<string, string>; toolCallTimeoutMs?: number }; enabled: boolean; updated_at: string }
    const headers = Object.entries(value.config?.headers ?? {}).map(([name, stored]) => ({
      name,
      secret: stored.startsWith('cred:mcp/'),
    }))
    return {
      name: value.server_name,
      url: value.target,
      enabled: value.enabled,
      timeoutMs: value.config?.toolCallTimeoutMs ?? null,
      headers,
      updatedAt: value.updated_at,
    }
  })
}

export async function saveMcp(
  db: Querier,
  key: Buffer,
  userId: string,
  input: { name: string; url: string; timeoutMs?: number; headers?: Record<string, { secret?: string; value?: string }> },
): Promise<void> {
  if (!isSlug(input.name)) throw new HttpError(422, 'invalid-name')
  if (!input.url.startsWith('https://')) throw new HttpError(422, 'invalid-url')
  const stored = await headersOf(db, key, userId, input.name, input.headers)
  const timeoutMs = input.timeoutMs ?? (await previousTimeout(db, userId, input.name))
  const config = {
    headers: stored,
    ...(timeoutMs ? { toolCallTimeoutMs: timeoutMs } : {}),
  }
  await db.query(
    `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, config)
     VALUES ($1, $2, 'streamable-http', $3, $4::jsonb)
     ON CONFLICT (user_id, server_name) DO UPDATE
       SET target = $3, config = $4::jsonb, updated_at = now()`,
    [userId, input.name, input.url, JSON.stringify(config)],
  )
}

export async function setMcpEnabled(db: Querier, userId: string, name: string, enabled: boolean): Promise<void> {
  const result = await db.query(`UPDATE dsh_mcp_servers SET enabled = $3, updated_at = now() WHERE user_id = $1 AND server_name = $2`, [
    userId,
    name,
    enabled,
  ])
  if (!result.rowCount) throw new HttpError(404, 'not-found')
}

export async function removeMcp(db: Querier, userId: string, name: string): Promise<void> {
  const result = await db.query(`DELETE FROM dsh_mcp_servers WHERE user_id = $1 AND server_name = $2`, [userId, name])
  if (!result.rowCount) throw new HttpError(404, 'not-found')
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name LIKE $3`, [userId, KIND, `${name}/%`])
}

async function previousTimeout(db: Querier, userId: string, name: string): Promise<number | undefined> {
  const rows = await db.query(`SELECT config FROM dsh_mcp_servers WHERE user_id = $1 AND server_name = $2`, [userId, name])
  return (rows.rows[0]?.config as { toolCallTimeoutMs?: number } | undefined)?.toolCallTimeoutMs
}

/** 不传 headers 就保留原来的。传入则整组替换，密钥写成脑能解开的引用。 */
async function headersOf(
  db: Querier,
  key: Buffer,
  userId: string,
  name: string,
  headers: Record<string, { secret?: string; value?: string }> | undefined,
): Promise<Record<string, string>> {
  if (headers === undefined) {
    const rows = await db.query(`SELECT config FROM dsh_mcp_servers WHERE user_id = $1 AND server_name = $2`, [userId, name])
    const config = rows.rows[0]?.config as { headers?: Record<string, string> } | undefined
    return config?.headers ?? {}
  }
  const stored: Record<string, string> = {}
  for (const [header, spec] of Object.entries(headers)) {
    if (!HEADER.test(header)) throw new HttpError(422, 'invalid-header')
    if (spec.secret) {
      const ref = `${name}/${header}`
      await db.query(
        `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
        [userId, KIND, ref, seal(key, spec.secret)],
      )
      stored[header] = `cred:mcp/${ref}`
    } else if (spec.value) {
      stored[header] = spec.value
    }
  }
  return stored
}
