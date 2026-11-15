import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import type { BrainClient } from '../../brain/client.js'
import { resolveModel, type ResolvedModel } from '../models/service.js'

export interface SessionRecord {
  id: string
  workspaceId: string
  guestRoot: string
  title: string
  status: string
  workspaceState: string
}

export async function listSessions(db: Querier, userId: string, workspaceId: string | null) {
  const rows = await db.query(
    `SELECT s.id, s.workspace_id, s.title, s.status, s.created_at, o.state AS create_state
       FROM dsh_sessions s
       LEFT JOIN dsh_platform_session_ops o ON o.session_id = s.id
      WHERE s.user_id = $1 AND ($2::text IS NULL OR s.workspace_id = $2)
      ORDER BY s.last_active_at DESC`,
    [userId, workspaceId],
  )
  return rows.rows
}

export async function openSession(
  db: Querier,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  input: { workspaceId: string; title?: string; modelId?: string },
) {
  const workspace = await activeWorkspace(db, userId, input.workspaceId)
  const model = await requireModel(db, key, userId, input.modelId)
  const id = `s_${randomBytes(16).toString('hex')}`
  await db.query(`INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, $4, 'platform')`, [
    id,
    userId,
    workspace.id,
    input.title ?? '',
  ])
  await db.query(`INSERT INTO dsh_platform_session_ops (session_id, user_id, state) VALUES ($1, $2, 'creating')`, [id, userId])
  const created = await brain.openSession({
    userId,
    workspaceId: workspace.id,
    sessionId: id,
    cwd: workspace.guest_root,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  })
  const state = created.ok ? 'ready' : created.status >= 500 ? 'unknown' : 'failed'
  await db.query(`UPDATE dsh_platform_session_ops SET state = $2, error_code = $3, updated_at = now() WHERE session_id = $1`, [
    id,
    state,
    created.ok ? null : created.code,
  ])
  return { id, createState: state, status: created.ok ? 201 : created.status || 502 }
}

/** 冷的会话重新交给脑，并带上这个用户当前的模型。已有会话由脑接着恢复。 */
export async function resumeSession(db: Querier, brain: BrainClient, key: Buffer, userId: string, sessionId: string, modelId?: string) {
  const session = await ownSession(db, userId, sessionId)
  if (session.workspaceState === 'archived') throw new HttpError(409, 'workspace-archived')
  const model = await requireModel(db, key, userId, modelId)
  const opened = await brain.openSession({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    cwd: session.guestRoot,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  })
  if (!opened.ok) throw new HttpError(opened.status || 502, opened.code)
  return { id: session.id, modelId: model.modelId }
}

export async function postMessage(
  db: Querier,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  sessionId: string,
  text: string,
  requestId: string,
) {
  const session = await ownSession(db, userId, sessionId)
  if (session.status !== 'active') throw new HttpError(409, 'session-inactive')
  const digest = createHash('sha256').update(text).digest('hex')
  const prior = await db.query(`SELECT digest, state FROM dsh_platform_message_requests WHERE session_id = $1 AND request_id = $2`, [
    session.id,
    requestId,
  ])
  const existing = prior.rows[0] as { digest: string; state: string } | undefined
  if (existing && existing.digest !== digest) throw new HttpError(409, 'conflict')
  if (existing?.state === 'accepted') return { requestId, state: 'accepted', status: 202 }
  await db.query(
    `INSERT INTO dsh_platform_message_requests (session_id, request_id, user_id, digest, state)
     VALUES ($1, $2, $3, $4, 'sending')
     ON CONFLICT (session_id, request_id) DO NOTHING`,
    [session.id, requestId, userId, digest],
  )
  const model = await requireModel(db, key, userId)
  const opened = await brain.openSession({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    cwd: session.guestRoot,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  })
  if (!opened.ok) {
    const state = opened.status >= 500 ? 'unknown' : 'rejected'
    await db.query(
      `UPDATE dsh_platform_message_requests SET state = $3, error_code = $4, updated_at = now() WHERE session_id = $1 AND request_id = $2`,
      [session.id, requestId, state, opened.code],
    )
    return { requestId, state, status: opened.status || 502 }
  }
  const sent = await brain.sendMessage({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    text,
    requestId,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  })
  const state = sent.ok ? 'accepted' : sent.status >= 500 ? 'unknown' : 'rejected'
  await db.query(
    `UPDATE dsh_platform_message_requests SET state = $3, error_code = $4, updated_at = now() WHERE session_id = $1 AND request_id = $2`,
    [session.id, requestId, state, sent.ok ? null : sent.code],
  )
  if (sent.ok) await db.query(`UPDATE dsh_sessions SET last_active_at = now() WHERE id = $1`, [session.id])
  return { requestId, state, status: sent.ok ? 202 : sent.status || 502 }
}

export async function switchModel(db: Querier, brain: BrainClient, key: Buffer, userId: string, sessionId: string, modelId: string) {
  const session = await ownSession(db, userId, sessionId)
  const model = await requireModel(db, key, userId, modelId)
  const switched = await brain.selectModel({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  })
  if (!switched.ok) throw new HttpError(switched.status || 502, switched.code)
  return { modelId: model.modelId }
}

export async function cancelSession(db: Querier, brain: BrainClient, userId: string, sessionId: string) {
  const session = await ownSession(db, userId, sessionId)
  const result = await brain.cancel({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    requestId: randomBytes(8).toString('hex'),
  })
  if (!result.ok) throw new HttpError(result.status || 502, result.code)
}

export async function history(db: Querier, userId: string, sessionId: string, after: number) {
  await ownSession(db, userId, sessionId)
  const rows = await db.query(
    `SELECT seq, event->>'type' AS type, event AS payload FROM dsh_session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`,
    [sessionId, after],
  )
  return rows.rows as { seq: number; type: string; payload: unknown }[]
}

export async function ownSession(db: Querier, userId: string, sessionId: string): Promise<SessionRecord> {
  const rows = await db.query(
    `SELECT s.id, s.workspace_id, s.title, s.status, w.guest_root, w.state AS workspace_state
       FROM dsh_sessions s
       JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  )
  const row = rows.rows[0] as
    | { id: string; workspace_id: string; title: string; status: string; guest_root: string; workspace_state: string }
    | undefined
  if (!row) throw new HttpError(404, 'not-found')
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    guestRoot: row.guest_root,
    title: row.title,
    status: row.status,
    workspaceState: row.workspace_state,
  }
}

async function activeWorkspace(db: Querier, userId: string, workspaceId: string) {
  const rows = await db.query(`SELECT id, guest_root, state FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [workspaceId, userId])
  const workspace = rows.rows[0] as { id: string; guest_root: string; state: string } | undefined
  if (!workspace || workspace.state !== 'active') throw new HttpError(404, 'workspace-not-found')
  return workspace
}

async function requireModel(db: Querier, key: Buffer, userId: string, selected?: string): Promise<ResolvedModel> {
  const model = await resolveModel(db, key, userId, selected)
  if (!model) throw new HttpError(422, 'model-config-required')
  return model
}
