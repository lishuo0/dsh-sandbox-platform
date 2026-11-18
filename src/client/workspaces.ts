/**
 * 工作区 RPC 的平台收口，以及 `workspace/follow` 流的数据源。
 *
 * 脑不认识租户：浏览器的 Peer 是脑的 `owner`，脑的 `workspace/follow` 会把所有
 * 成员的工作区和会话都推过来。所以工作区的读写都在平台这边完成——写落到
 * `dsh_workspaces`，读完再让脑重新投影（会话创建/文件面要用）；浏览器侧的
 * `workspace/follow` 由 `workspaceState` 从平台表合成，只含当前成员的行。
 */

import { randomBytes } from 'node:crypto'
import type { Db } from '../kernel/db.js'
import { HttpError, isUniqueViolation } from '../kernel/errors.js'
import type { ObjectStore } from '../kernel/objects.js'
import type { BrainClient } from '../brain/client.js'
import { WORKSPACE_GUEST_ROOT } from '../kernel/layout.js'
import {
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  ownedWorkspace,
  selectionFrom,
  updateWorkspace,
} from '../modules/workspaces/service.js'
import { failure, requestOf, rpcIdOf } from './scope.js'

export interface WorkspaceIntercept {
  readonly db: Db
  readonly objects: ObjectStore
  readonly brain: BrainClient
  readonly userId: string
}

/** 脑侧 `workspaceView` 的线上形状。 */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** `workspace/follow` 基线与增量共用的完整状态。 */
export interface WorkspaceStateValue {
  items: WorkspaceView[]
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
}

export interface HomeContext {
  readonly db: Db
  readonly objects: ObjectStore
  readonly brain: { syncWorkspaces(userId: string): Promise<unknown> }
  readonly userId: string
}

/**
 * 首页加载前的准备工作：成员至少有一块工作区，并让脑重新投影一次。
 *
 * 首页的输入框要等成员选中一块工作区才解锁，而选择器只列脑投影里的工作区。
 * 新成员（或清过库的环境）一块工作区都没有时，页面会一直停在「选择一个工作区
 * 开始」且没有可选项。这里补一块默认工作区；顺手同步投影，脑重启后丢失的
 * 工作区和会话也在这个时机补回来。
 */
export async function prepareClientHome(context: HomeContext): Promise<void> {
  await ensureDefaultWorkspace(context.db, context.objects, context.userId)
  await context.brain.syncWorkspaces(context.userId)
}

/**
 * 拦截 `workspace/*` 里由平台负责的动词。
 *
 * 返回要回给客户端的 JSON 文本；返回 undefined 表示这个动词不属于平台，
 * 照常转给脑。排序、置顶也在平台落库——脑上的进程内状态是所有租户共用的，
 * 不能让一个成员拖动就改到别人的视图。
 */
export async function interceptWorkspace(
  path: string,
  parsed: unknown,
  context: WorkspaceIntercept,
): Promise<string | undefined> {
  const request = requestOf(parsed) ?? {}
  const rpcId = rpcIdOf(parsed)
  switch (path) {
    case 'workspace/create':
      return await create(request, rpcId, context)
    case 'workspace/rename':
      return await rename(request, rpcId, context)
    case 'workspace/delete':
      return await remove(request, rpcId, context)
    case 'workspace/archiveSession':
      return await archive(true, request, rpcId, context)
    case 'workspace/unarchiveSession':
      return await archive(false, request, rpcId, context)
    case 'workspace/insertBefore':
      return await reorder(request, rpcId, context)
    case 'workspace/insertSessionBefore':
      return await moveSession(request, rpcId, context)
    case 'workspace/pinSession':
      return await pin(true, request, rpcId, context)
    case 'workspace/unpinSession':
      return await pin(false, request, rpcId, context)
    default:
      return undefined
  }
}

async function create(
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const title = string(request.title)?.trim() || '新工作区'
  try {
    const workspace = await createWorkspace(
      context.db,
      context.objects,
      context.userId,
      title,
      selectionFrom(request),
    )
    await context.brain.syncWorkspaces(context.userId)
    const view = await viewOf(context.db, context.userId, workspace.id)
    return ok(rpcId, { workspace: view ?? fallbackView(workspace), created: true })
  } catch (error) {
    return failed(rpcId, error)
  }
}

async function rename(
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const workspaceId = string(request.workspaceId)
  const title = string(request.title)?.trim()
  if (workspaceId === undefined) return bad(rpcId, 'workspace/not-found', 'Workspace not found')
  if (!title) return bad(rpcId, 'gateway/bad-request', 'Workspace rename requires a non-blank title')
  const conflict = await context.db.query<{ id: string }>(
    `SELECT id FROM dsh_workspaces WHERE user_id = $1 AND name = $2 AND id <> $3`,
    [context.userId, title, workspaceId],
  )
  if (conflict.rows.length > 0) {
    return bad(rpcId, 'workspace/name-conflict', `Workspace name '${title}' is already in use`, { name: title })
  }
  try {
    await updateWorkspace(context.db, context.userId, workspaceId, { name: title })
  } catch (error) {
    return failed(rpcId, error)
  }
  await context.brain.syncWorkspaces(context.userId)
  const view = await viewOf(context.db, context.userId, workspaceId)
  if (view === undefined) return bad(rpcId, 'workspace/not-found', `Workspace "${workspaceId}" not found`, { workspaceId })
  return ok(rpcId, { workspace: view })
}

async function remove(
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const workspaceId = string(request.workspaceId)
  if (workspaceId === undefined) return bad(rpcId, 'workspace/not-found', 'Workspace not found', { workspaceId: '' })
  try {
    // 会话先转到默认工作区再删；任何会话都不会因此失去归属。
    await deleteWorkspace(context.db, context.objects, context.userId, workspaceId)
  } catch (error) {
    return failed(rpcId, error)
  }
  await context.brain.syncWorkspaces(context.userId)
  return ok(rpcId, { deleted: true })
}

/**
 * 归档 / 取消归档一条成员自己的会话。
 *
 * 平台把 `dsh_sessions.status` 当作归档位：脑的投影读它，重启后归档集合不会丢。
 */
async function archive(
  archived: boolean,
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const sessionId = string(request.sessionId)
  if (sessionId === undefined) return bad(rpcId, 'session/not-found', 'session not found', { sessionId: '' })
  const owned = await context.db.query<{ id: string; workspace_id: string; status: string | null }>(
    `SELECT id, workspace_id, status FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, context.userId],
  )
  const row = owned.rows[0]
  if (row === undefined) {
    return bad(rpcId, 'session/not-found', `session "${sessionId}" not found`, { sessionId })
  }
  // 归档一条还在跑的会话要先把回合停掉，否则后台任务会继续消耗额度、写工作区。
  // 脑上没有活跃 Agent 时取消会失败，归档本身不能因此被挡；停止按尽力而为处理。
  if (archived && row.status !== 'archived') {
    try {
      await context.brain.cancel?.({
        userId: context.userId,
        workspaceId: row.workspace_id,
        sessionId,
        requestId: randomBytes(8).toString('hex'),
      })
    } catch {
      // 脑不可达时归档仍要落库；停止是补充动作，不是前置条件。
    }
  }
  await context.db.query(
    archived
      ? `UPDATE dsh_sessions SET status = 'archived', pinned_at = NULL WHERE id = $1 AND user_id = $2`
      : `UPDATE dsh_sessions SET status = 'active' WHERE id = $1 AND user_id = $2`,
    [sessionId, context.userId],
  )
  await context.brain.syncWorkspaces(context.userId)
  const rows = await context.db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions WHERE user_id = $1 AND status = 'archived' ORDER BY created_at DESC`,
    [context.userId],
  )
  return ok(rpcId, { archivedSessionIds: rows.rows.map((row) => row.id) })
}

/**
 * 成员拖动工作区后的显示顺序。
 *
 * 顺序落在 `dsh_workspaces.sort_order`，只重排当前成员自己的行；脑上的
 * `workspace/follow` 会把这行当成投影读走，不需要（也不允许）写进程级排序。
 */
async function reorder(
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const workspaceId = string(request.workspaceId)
  const beforeId = request.beforeWorkspaceId === undefined ? undefined : string(request.beforeWorkspaceId)
  if (workspaceId === undefined || await ownedWorkspace(context.db, context.userId, workspaceId) === undefined) {
    return bad(rpcId, 'workspace/not-found', `Workspace "${workspaceId ?? ''}" not found`, { workspaceId: workspaceId ?? '' })
  }
  if (beforeId !== undefined && await ownedWorkspace(context.db, context.userId, beforeId) === undefined) {
    return bad(rpcId, 'workspace/not-found', `Workspace "${beforeId}" not found`, { workspaceId: beforeId })
  }
  const order = await workspaceOrder(context.db, context.userId)
  const next = movedBefore(order, workspaceId, beforeId)
  if (!sameOrder(next, order)) {
    await context.db.transaction(async (q) => {
      for (const [index, id] of next.entries()) {
        await q.query(`UPDATE dsh_workspaces SET sort_order = $2 WHERE id = $1 AND user_id = $3`, [id, index + 1, context.userId])
      }
    })
    await context.brain.syncWorkspaces(context.userId)
  }
  return ok(rpcId, { workspaceIds: next })
}

/** 成员在工作区里拖动会话后的顺序；只动当前成员、当前工作区的行。 */
async function moveSession(
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const workspaceId = string(request.workspaceId)
  const sessionId = string(request.sessionId)
  const beforeId = request.beforeSessionId === undefined ? undefined : string(request.beforeSessionId)
  if (workspaceId === undefined || await ownedWorkspace(context.db, context.userId, workspaceId) === undefined) {
    return bad(rpcId, 'workspace/not-found', `Workspace "${workspaceId ?? ''}" not found`, { workspaceId: workspaceId ?? '' })
  }
  if (sessionId === undefined || !await ownedSession(context.db, context.userId, sessionId)) {
    return bad(rpcId, 'session/not-found', `session "${sessionId ?? ''}" not found`, { sessionId: sessionId ?? '' })
  }
  if (beforeId !== undefined && !await ownedSession(context.db, context.userId, beforeId)) {
    return bad(rpcId, 'session/not-found', `session "${beforeId}" not found`, { sessionId: beforeId })
  }
  if (!await sessionInWorkspace(context.db, context.userId, workspaceId, sessionId)) {
    return bad(rpcId, 'workspace/move-invalid', 'The Session is not in this Workspace.', { workspaceId, sessionId })
  }
  if (beforeId !== undefined && !await sessionInWorkspace(context.db, context.userId, workspaceId, beforeId)) {
    return bad(rpcId, 'workspace/move-invalid', 'The anchor Session is not in this Workspace.', { workspaceId, sessionId: beforeId })
  }
  const order = await sessionOrder(context.db, workspaceId)
  const next = movedBefore(order, sessionId, beforeId)
  if (!sameOrder(next, order)) {
    await context.db.transaction(async (q) => {
      for (const [index, id] of next.entries()) {
        await q.query(`UPDATE dsh_sessions SET sort_order = $2 WHERE id = $1 AND user_id = $3`, [id, index + 1, context.userId])
      }
    })
    await context.brain.syncWorkspaces(context.userId)
  }
  const view = await viewOf(context.db, context.userId, workspaceId)
  if (view === undefined) return bad(rpcId, 'workspace/not-found', 'Workspace not found', { workspaceId })
  return ok(rpcId, { workspace: view })
}

/**
 * 置顶 / 取消置顶一条成员自己的会话。
 *
 * 置顶集合落在 `dsh_sessions.pinned_at`，归档时清空；脑的基线从同一列读，
 * 不会再有几个租户共用一份进程内 pin 列表。
 */
async function pin(
  pinned: boolean,
  request: Record<string, unknown>,
  rpcId: unknown,
  context: WorkspaceIntercept,
): Promise<string> {
  const sessionId = string(request.sessionId)
  if (sessionId === undefined) return bad(rpcId, 'session/not-found', 'session not found', { sessionId: '' })
  const rows = await context.db.query<{ status: string }>(
    `SELECT status FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, context.userId],
  )
  const row = rows.rows[0]
  if (row === undefined) {
    return bad(rpcId, 'session/not-found', `session "${sessionId}" not found`, { sessionId })
  }
  if (pinned && row.status !== 'active') {
    return bad(rpcId, 'gateway/bad-request', 'An archived Session cannot be pinned.', { sessionId })
  }
  await context.db.query(
    pinned
      ? `UPDATE dsh_sessions SET pinned_at = $2 WHERE id = $1 AND user_id = $3`
      : `UPDATE dsh_sessions SET pinned_at = NULL WHERE id = $1 AND user_id = $2`,
    pinned ? [sessionId, new Date().toISOString(), context.userId] : [sessionId, context.userId],
  )
  await context.brain.syncWorkspaces(context.userId)
  return ok(rpcId, { pinnedSessionIds: await pinnedSessionIds(context.db, context.userId) })
}

/** 当前成员的显示顺序；默认工作区优先、最近活跃优先，和脑的投影一致。 */
async function workspaceOrder(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM dsh_workspaces
      WHERE user_id = $1 AND state <> 'archived'
      ORDER BY sort_order ASC, is_default DESC, last_active_at DESC, created_at DESC, id`,
    [userId],
  )
  return rows.rows.map((row) => row.id)
}

async function sessionOrder(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY sort_order ASC, created_at DESC, id`,
    [workspaceId],
  )
  return rows.rows.map((row) => row.id)
}

async function pinnedSessionIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions
      WHERE user_id = $1 AND pinned_at IS NOT NULL
      ORDER BY pinned_at DESC, id DESC`,
    [userId],
  )
  return rows.rows.map((row) => row.id)
}

/** 会话是否属于当前成员（不看工作区）；跨租户一律当不存在。 */
async function ownedSession(db: Db, userId: string, sessionId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  )
  return rows.rows.length > 0
}

async function sessionInWorkspace(db: Db, userId: string, workspaceId: string, sessionId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions WHERE id = $1 AND user_id = $2 AND workspace_id = $3 AND status = 'active'`,
    [sessionId, userId, workspaceId],
  )
  return rows.rows.length > 0
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** 把 `id` 移到 `beforeId` 前面；没给锚点就移到末尾。无效输入原样返回。 */
function movedBefore(ids: readonly string[], id: string, beforeId: string | undefined): string[] {
  if (!ids.includes(id)) return [...ids]
  if (beforeId !== undefined && (!ids.includes(beforeId) || beforeId === id)) return [...ids]
  const without = ids.filter((candidate) => candidate !== id)
  const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

/**
 * `workspace/follow` 的一帧完整状态：只含当前成员的工作区、会话、归档与置顶。
 *
 * 两端的 Remote 契约要求每一代先发一次 `baseline`；之后变化可以整帧 `replace`。
 * 平台是唯一数据源（`dsh_workspaces` / `dsh_sessions`），所以这里不经过脑：
 * 脑的进程内投影是所有租户共用的，跨成员的行不能出现在这条流上。
 */
export async function workspaceState(db: Db, userId: string): Promise<WorkspaceStateValue> {
  const items: WorkspaceView[] = []
  for (const workspaceId of await workspaceOrder(db, userId)) {
    const view = await viewOf(db, userId, workspaceId)
    if (view !== undefined) items.push(view)
  }
  const archived = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions
      WHERE user_id = $1 AND status = 'archived'
      ORDER BY created_at DESC, id`,
    [userId],
  )
  return {
    items,
    archivedSessionIds: archived.rows.map((row) => row.id),
    pinnedSessionIds: await pinnedSessionIds(db, userId),
  }
}

/** 一块工作区连同它的会话，形状与脑的 `workspaceView` 一致。 */
export async function viewOf(db: Db, userId: string, workspaceId: string): Promise<WorkspaceView | undefined> {
  const rows = await db.query<{
    id: string
    name: string
    created_at: unknown
    last_active_at: unknown
  }>(
    `SELECT id, name, created_at, last_active_at
       FROM dsh_workspaces WHERE id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  const row = rows.rows[0]
  if (row === undefined) return undefined
  const sessions = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY sort_order ASC, created_at DESC, id`,
    [workspaceId],
  )
  return {
    workspaceId: row.id,
    path: WORKSPACE_GUEST_ROOT,
    title: row.name,
    sessionIds: sessions.rows.map((session) => session.id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.last_active_at),
  }
}

function fallbackView(workspace: { id: string; name: string }): WorkspaceView {
  const now = new Date().toISOString()
  return {
    workspaceId: workspace.id,
    path: WORKSPACE_GUEST_ROOT,
    title: workspace.name,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

function ok(rpcId: unknown, value: unknown): string {
  const id = typeof rpcId === 'string' && rpcId ? rpcId : 'invalid-request'
  return JSON.stringify({ type: 'server-response', rpcId: id, result: { ok: true, value } })
}

function bad(rpcId: unknown, code: string, message: string, details: unknown = {}): string {
  return failure(rpcId, code, message, details)
}

/** 平台侧错误映射：404 是工作区不存在，其余按输入错误处理。 */
function failed(rpcId: unknown, error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 404) return bad(rpcId, 'workspace/not-found', error.message || 'Workspace not found')
    return bad(rpcId, 'gateway/bad-request', error.message || 'Workspace request rejected')
  }
  if (isUniqueViolation(error)) return bad(rpcId, 'workspace/name-conflict', 'That workspace name is already in use')
  return bad(rpcId, 'workspace/internal', error instanceof Error ? error.message : String(error))
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
