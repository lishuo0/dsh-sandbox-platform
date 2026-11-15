/**
 * 客户端的会话接口在脑上是同一个进程。平台按 `dsh_sessions` 决定这条会话属于谁。
 */

import type { Db } from '../kernel/db.js'

const SESSION_KEYS = new Set(['sessionId', 'workspaceFileScopeId'])

export interface SessionAccess {
  ids(): Promise<Set<string>>
  /** 这条会话已经记在当前成员名下。 */
  allows(sessionId: string): Promise<boolean>
  /** 客户端新建的会话记到当前成员名下。别人已经占有的 id 不会改写。 */
  claim(sessionId: string, cwd?: string): Promise<void>
}

export function sessionAccess(db: Db, userId: string): SessionAccess {
  let at = 0
  let ids = new Set<string>()
  const load = async (): Promise<Set<string>> => {
    if (Date.now() - at < 500) return ids
    const rows = await db.query<{ id: string }>(`SELECT id FROM dsh_sessions WHERE user_id = $1`, [userId])
    ids = new Set(rows.rows.map((row) => row.id))
    at = Date.now()
    return ids
  }
  return {
    ids: load,
    async allows(sessionId) {
      return (await load()).has(sessionId)
    },
    async claim(sessionId, cwd) {
      const existing = await db.query<{ user_id: string }>(`SELECT user_id FROM dsh_sessions WHERE id = $1`, [sessionId])
      const owner = existing.rows[0]?.user_id
      if (owner !== undefined) {
        if (owner === userId) ids.add(sessionId)
        return
      }
      let workspaceId: string | null = null
      if (cwd) {
        const workspace = await db.query<{ id: string }>(
          `SELECT id FROM dsh_workspaces WHERE user_id = $1 AND guest_root = $2 LIMIT 1`,
          [userId, cwd],
        )
        workspaceId = workspace.rows[0]?.id ?? null
      }
      await db.query(
        `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client') ON CONFLICT (id) DO NOTHING`,
        [sessionId, userId, workspaceId],
      )
      ids.add(sessionId)
      at = Date.now()
    },
  }
}

/** 请求体里点名的会话。新建会话可以不带 id。 */
export function sessionIdsIn(value: unknown): string[] {
  const found = new Set<string>()
  walk(value, found)
  return [...found]
}

export function isCreate(path: string): boolean {
  return path === '/api/session/create' || path === '/api/session/fork'
}

/** 列表和搜索只留下这个成员的会话。 */
export function filterSessionPayload(value: unknown, owned: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => filterSessionPayload(item, owned))
  if (typeof value !== 'object' || value === null) return value
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'items' && Array.isArray(child)) {
      copy[key] = child.filter((item) => {
        if (typeof item !== 'object' || item === null) return true
        const id = (item as { sessionId?: unknown }).sessionId
        return typeof id !== 'string' || owned.has(id)
      }).map((item) => filterSessionPayload(item, owned))
      continue
    }
    if (key === 'projections' && typeof child === 'object' && child !== null && !Array.isArray(child)) {
      const next: Record<string, unknown> = {}
      for (const [id, row] of Object.entries(child)) if (owned.has(id)) next[id] = row
      copy[key] = next
      continue
    }
    copy[key] = filterSessionPayload(child, owned)
  }
  return copy
}

/** 控制流里一条不属于这个成员的投影。整帧丢掉。 */
export function hiddenProjection(value: unknown, owned: Set<string>): boolean {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; sessionId?: unknown; value?: unknown }
  if (frame.type === 'projection' && typeof frame.sessionId === 'string') return !owned.has(frame.sessionId)
  if (frame.type === 'item') return hiddenProjection(frame.value, owned)
  return false
}

export function createdSessionId(value: unknown): string | undefined {
  return firstString(value, 'sessionId')
}

export function requestedCwd(value: unknown): string | undefined {
  return firstString(value, 'cwd')
}

export function denied(rpcId: unknown): string {
  const id = typeof rpcId === 'string' && rpcId ? rpcId : 'invalid-request'
  return JSON.stringify({
    type: 'server-response',
    rpcId: id,
    result: {
      ok: false,
      error: { code: 'session/not-found', message: 'session not found', details: {} },
    },
  })
}

function walk(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (SESSION_KEYS.has(key) && typeof child === 'string' && child) found.add(child)
    else walk(child, found)
  }
}

function firstString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const direct = (value as Record<string, unknown>)[key]
  if (typeof direct === 'string' && direct) return direct
  for (const child of Object.values(value)) {
    const found = firstString(child, key)
    if (found) return found
  }
  return undefined
}
