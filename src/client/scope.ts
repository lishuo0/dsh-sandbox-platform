/**
 * 客户端 Remote 调用在平台侧的信封工具与成员会话归属。
 *
 * 归属判断在 `src/client/mux`（每个端点自己查 `dsh_sessions` / `dsh_workspaces`），
 * 这里只保留信封构造、参数注入和会话登记，不承载任何全局帧过滤。
 */

import type { Db } from '../kernel/db.js'
import type { ObjectStore } from '../kernel/objects.js'
import { ensureDefaultWorkspace } from '../modules/workspaces/service.js'

export interface SessionAccess {
  ids(): Promise<Set<string>>
  /** 这条会话已经记在当前成员名下。 */
  allows(sessionId: string): Promise<boolean>
  /**
   * 这些 agentId 里哪些是别的成员的顶层会话。
   *
   * DSH 的 agentId 就是会话 id，但子会话不在平台表里；只有查得到行、且行属于
   * 别人时才算越权，查不到的交给脑按它自己的 agent 表判。
   */
  foreignAgents(agentIds: readonly string[]): Promise<Set<string>>
  /**
   * 客户端新建的会话记到当前成员名下，并保证它挂在某块工作区上。
   *
   * `workspaceId` 决定脑把这条会话路由到哪台沙箱；没给（或之前记下来还没挂
   * 工作区的老会话）时落到成员的默认工作区。会话永远不留在 `workspace_id`
   * 为空的状态，否则沙箱注册表会把它判为未知会话。
   */
  claim(sessionId: string, workspaceId?: string): Promise<void>
}

export function sessionAccess(db: Db, objects: ObjectStore, userId: string): SessionAccess {
  let at = 0
  let ids = new Set<string>()
  const load = async (): Promise<Set<string>> => {
    if (Date.now() - at < 500) return ids
    const rows = await db.query<{ id: string }>(`SELECT id FROM dsh_sessions WHERE user_id = $1`, [userId])
    ids = new Set(rows.rows.map((row) => row.id))
    at = Date.now()
    return ids
  }
  const workspaceFor = async (workspaceId: string | undefined): Promise<string> =>
    workspaceId ?? (await ensureDefaultWorkspace(db, objects, userId)).id
  return {
    ids: load,
    async allows(sessionId) {
      return (await load()).has(sessionId)
    },
    async foreignAgents(agentIds) {
      if (agentIds.length === 0) return new Set()
      const rows = await db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM dsh_sessions WHERE id IN (${agentIds.map((_, index) => `$${index + 1}`).join(', ')})`,
        [...agentIds],
      )
      return new Set(rows.rows.filter((row) => row.user_id !== userId).map((row) => row.id))
    },
    async claim(sessionId, workspaceId) {
      const existing = await db.query<{ user_id: string; workspace_id: string | null }>(
        `SELECT user_id, workspace_id FROM dsh_sessions WHERE id = $1`,
        [sessionId],
      )
      const row = existing.rows[0]
      if (row !== undefined) {
        if (row.user_id !== userId) return
        if (row.workspace_id === null) {
          const target = await workspaceFor(workspaceId)
          await db.query(
            `UPDATE dsh_sessions SET workspace_id = $2 WHERE id = $1 AND workspace_id IS NULL`,
            [sessionId, target],
          )
        }
        ids.add(sessionId)
        return
      }
      const target = await workspaceFor(workspaceId)
      await db.query(
        `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client') ON CONFLICT (id) DO NOTHING`,
        [sessionId, userId, target],
      )
      ids.add(sessionId)
      at = Date.now()
    },
  }
}

/** 用一条失败信封回掉客户端的 Remote 调用；客户端只认 `result.ok === false`。 */
export function failure(rpcId: unknown, code: string, message: string, details: unknown = {}): string {
  const id = typeof rpcId === 'string' && rpcId ? rpcId : 'invalid-request'
  return JSON.stringify({
    type: 'server-response',
    rpcId: id,
    result: {
      ok: false,
      error: { code, message, details },
    },
  })
}

/** 请求信封里的 rpcId，用来回一条失败。 */
export function rpcIdOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { rpcId?: unknown }).rpcId : undefined
}

/**
 * 定时任务 Remote 调用统一补上当前成员的会话范围。
 *
 * 脑不认租户，`sessionIds` 是平台代理给它的唯一范围来源：catalog/list 只返回
 * 这些会话的任务，create/edit/view 也只认这些会话。客户端自己的请求里没有
 * 这个参数，补在 `payload.args` 上，和脑侧 Remote 方法的第二个参数对上。
 */
export function withSessionScope(value: unknown, sessionIds: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null) return value
  const copy = structuredClone(value) as Record<string, unknown>
  const payload = typeof copy.payload === 'object' && copy.payload !== null
    ? copy.payload as Record<string, unknown>
    : {}
  const args = typeof payload.args === 'object' && payload.args !== null
    ? payload.args as Record<string, unknown>
    : {}
  payload.args = { ...args, sessionIds }
  copy.payload = payload
  return copy
}

/** `payload.args.request`；没有 request 的 Remote 调用返回 undefined。 */
export function requestOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = (value as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const args = (payload as { args?: unknown }).args
  if (typeof args !== 'object' || args === null) return undefined
  const request = (args as { request?: unknown }).request
  return typeof request === 'object' && request !== null ? request as Record<string, unknown> : undefined
}
