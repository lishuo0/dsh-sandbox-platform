import { createHash, randomBytes } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Db, Querier } from '../../kernel/db.js'
import type { ObjectStore } from '../../kernel/objects.js'
import type { BrainClient } from '../../brain/client.js'
import { WORKSPACE_GUEST_ROOT } from '../../kernel/layout.js'
import { asBool, asJson, asNumber } from '../../kernel/row.js'
import { resolveModel, type ResolvedModel } from '../models/service.js'
import { ensureDefaultWorkspace } from '../workspaces/service.js'

export interface SessionRecord {
  id: string
  workspaceId: string
  title: string
  status: string
  workspaceState: string
  /** 成员为这条会话选中的模型；空表示沿用成员默认模型。 */
  modelId?: string
}

/** 对外会话视图：不含工作区路径和成员归属。 */
export interface SessionItem {
  id: string
  workspace_id: string
  title: string
  status: string
  create_state: string
  create_error?: string
  blank: boolean
  running: boolean
  last_prompt_at?: string
  created_at: string
  last_active_at: string
}

export interface SessionPage {
  items: SessionItem[]
  nextCursor: string
}

const SESSION_PAGE_SIZE = 20
const SESSION_MAX_PAGE_SIZE = 100
const HISTORY_PAGE_SIZE = 200
const MAX_HISTORY_PAGE_SIZE = 2000
const EVENT_BATCH = 200
const TITLE_MAX_RUNES = 200

export function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return SESSION_PAGE_SIZE
  return Math.min(limit, SESSION_MAX_PAGE_SIZE)
}

/**
 * 会话视图的列。标题、blank、running、最后一句用户消息的时间都从脑写入的
 * `dsh_session_events` 只读推导；SQLite 把事件存成文本、PostgreSQL 存 jsonb。
 */
function sessionItemSelect(db: Db): string {
  const sqlite = db.dialect === 'sqlite'
  const type = sqlite ? `json_extract(e.event, '$.type')` : `e.event->>'type'`
  const dataTitle = sqlite ? `json_extract(e.event, '$.data.title')` : `e.event->'data'->>'title'`
  const sourceKind = sqlite ? `json_extract(e.event, '$.data.source.kind')` : `e.event->'data'->'source'->>'kind'`
  const time = sqlite ? `CAST(json_extract(e.event, '$.time') AS INTEGER)` : `NULLIF(e.event->>'time', '')::bigint`
  const runningFallback = sqlite ? '0' : 'false'
  // PostgreSQL 的时间戳带微秒，游标要保留完整精度，否则同一毫秒内的会话会翻页丢失。
  const cursorAt = sqlite
    ? 's.last_active_at'
    : `to_char(s.last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  return `s.id, COALESCE(s.workspace_id, '') AS workspace_id, s.status,
    COALESCE(NULLIF(s.title, ''), (
      SELECT ${dataTitle} FROM dsh_session_events e
       WHERE e.session_id = s.id AND ${type} = 'session/title'
       ORDER BY e.seq DESC LIMIT 1
    ), '') AS title,
    COALESCE(o.state, 'unknown') AS create_state,
    COALESCE(o.error_code, '') AS create_error,
    NOT EXISTS (
      SELECT 1 FROM dsh_session_events e
       WHERE e.session_id = s.id AND ${type} = 'turn/start'
    ) AS blank,
    COALESCE((
      SELECT (${type} = 'turn/start') FROM dsh_session_events e
       WHERE e.session_id = s.id AND ${type} IN ('turn/start', 'turn/end')
       ORDER BY e.seq DESC LIMIT 1
    ), ${runningFallback}) AS running,
    (
      SELECT ${time} FROM dsh_session_events e
       WHERE e.session_id = s.id AND ${type} = 'user/message' AND ${sourceKind} = 'user'
       ORDER BY e.seq DESC LIMIT 1
    ) AS last_prompt_at,
    s.created_at, s.last_active_at, ${cursorAt} AS cursor_at`
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return typeof value === 'string' ? value : ''
}

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function toSessionItem(row: Record<string, unknown>): SessionItem {
  const item: SessionItem = {
    id: String(row.id),
    workspace_id: String(row.workspace_id ?? ''),
    title: String(row.title ?? ''),
    status: String(row.status ?? ''),
    create_state: String(row.create_state ?? 'unknown'),
    blank: asBool(row.blank),
    running: asBool(row.running),
    created_at: toIso(row.created_at),
    last_active_at: toIso(row.last_active_at),
  }
  if (typeof row.create_error === 'string' && row.create_error !== '') item.create_error = row.create_error
  const promptAt = toMillis(row.last_prompt_at)
  if (promptAt !== null) item.last_prompt_at = new Date(promptAt).toISOString()
  return item
}

function encodeSessionCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url')
}

function decodeSessionCursor(raw: string): { at: string; id: string } {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const index = text.lastIndexOf('|')
  if (index <= 0 || index === text.length - 1) throw new HttpError(400, 'invalid-cursor')
  return { at: text.slice(0, index), id: text.slice(index + 1) }
}

/** 按最近活跃倒序分页；游标是 (last_active_at, id)。 */
export async function listSessions(
  db: Db,
  userId: string,
  workspaceId: string | null,
  options: { limit?: number; cursor?: string } = {},
): Promise<SessionPage> {
  const limit = clampPageSize(options.limit)
  const args: unknown[] = [userId]
  let where = 'WHERE s.user_id = $1'
  if (workspaceId) {
    args.push(workspaceId)
    where += ` AND s.workspace_id = $${args.length}`
  }
  if (options.cursor) {
    const cursor = decodeSessionCursor(options.cursor)
    args.push(cursor.at, cursor.id)
    where += ` AND (s.last_active_at, s.id) < ($${args.length - 1}::timestamptz, $${args.length}::text)`
  }
  args.push(limit + 1)
  const rows = await db.query(
    `SELECT ${sessionItemSelect(db)}
       FROM dsh_sessions s
       LEFT JOIN dsh_platform_session_ops o ON o.session_id = s.id
      ${where}
      ORDER BY s.last_active_at DESC, s.id DESC
      LIMIT $${args.length}`,
    args,
  )
  const items = rows.rows.map(toSessionItem)
  let nextCursor = ''
  if (items.length > limit) {
    items.length = limit
    const last = rows.rows[limit - 1] as Record<string, unknown>
    nextCursor = encodeSessionCursor(String(last.cursor_at ?? ''), String(last.id))
  }
  return { items, nextCursor }
}

export interface SessionSearchHit {
  session_id: string
  snippet: string
}

export interface SessionSearchResult {
  items: SessionSearchHit[]
  has_more: boolean
}

const SEARCH_LIMIT = 20
const SEARCH_MAX_QUERY_RUNES = 500
const SEARCH_SNIPPET_RUNES = 240

/**
 * 只搜当前成员自己的会话：标题和用户/助手消息、会话标题事件。
 * SQLite 事件是文本，PostgreSQL 是 jsonb，两边各用各的子串函数。
 */
export async function searchSessions(db: Db, userId: string, rawQuery: string): Promise<SessionSearchResult> {
  const query = rawQuery.trim()
  if (query === '') return { items: [], has_more: false }
  if ([...query].length > SEARCH_MAX_QUERY_RUNES) throw new HttpError(400, 'invalid request')
  const sqlite = db.dialect === 'sqlite'
  const type = sqlite ? `json_extract(e.event, '$.type')` : `e.event->>'type'`
  const contains = (expression: string) =>
    sqlite ? `instr(lower(${expression}), lower($2)) > 0` : `strpos(lower(${expression}), lower($2)) > 0`
  const eventTextExpr = sqlite ? 'e.event' : 'e.event::text'
  const hits = await db.query<{ id: string; title: string }>(
    `SELECT s.id, COALESCE(s.title, '') AS title
       FROM dsh_sessions s
      WHERE s.user_id = $1
        AND (
          ${contains(`COALESCE(s.title, '')`)}
          OR EXISTS (
            SELECT 1 FROM dsh_session_events e
             WHERE e.session_id = s.id
               AND ${type} IN ('user/message', 'assistant/message', 'session/title')
               AND ${contains(eventTextExpr)}
          )
        )
      ORDER BY s.last_active_at DESC, s.id DESC
      LIMIT $3`,
    [userId, query, SEARCH_LIMIT + 1],
  )
  const hasMore = hits.rows.length > SEARCH_LIMIT
  const page = hits.rows.slice(0, SEARCH_LIMIT)
  const items: SessionSearchHit[] = []
  for (const row of page) {
    const event = await db.query<Record<string, unknown>>(
      `SELECT e.event AS payload FROM dsh_session_events e
        WHERE e.session_id = $1
          AND ${type} IN ('user/message', 'assistant/message', 'session/title')
          AND ${contains(eventTextExpr)}
        ORDER BY e.seq
        LIMIT 1`,
      [row.id, query],
    )
    const extracted = event.rows[0] === undefined ? '' : eventText(asJson(event.rows[0].payload))
    const source = extracted !== '' ? extracted : row.title
    items.push({ session_id: row.id, snippet: snippetAround(source, query, SEARCH_SNIPPET_RUNES) })
  }
  return { items, has_more: hasMore }
}

function eventText(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const data = (event as { data?: unknown }).data
  if (!data || typeof data !== 'object') return ''
  const record = data as { title?: unknown; text?: unknown; content?: unknown; message?: unknown }
  const parts: string[] = []
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const part of value) {
      if (!part || typeof part !== 'object') continue
      const { type, text } = part as { type?: unknown; text?: unknown }
      if (type === 'text' && typeof text === 'string' && text !== '') parts.push(text)
    }
  }
  collect((record.message as { content?: unknown } | undefined)?.content)
  if (parts.length === 0) collect(record.content)
  if (parts.length === 0) {
    if (typeof record.text === 'string' && record.text !== '') parts.push(record.text)
    else if (typeof record.title === 'string' && record.title !== '') parts.push(record.title)
  }
  return parts.join(' ')
}

function snippetAround(text: string, query: string, maxRunes: number): string {
  const trimmed = text.trim()
  const runes = [...trimmed]
  if (runes.length <= maxRunes) return trimmed
  const index = lowerIndexOf(runes, query)
  let start = index >= 0 ? index - Math.floor(maxRunes / 3) : 0
  if (start < 0) start = 0
  let end = start + maxRunes
  if (end > runes.length) {
    end = runes.length
    start = end - maxRunes
  }
  return `${start > 0 ? '…' : ''}${runes.slice(start, end).join('')}${end < runes.length ? '…' : ''}`
}

function lowerIndexOf(haystack: readonly string[], needle: string): number {
  const target = [...needle.toLowerCase()]
  if (target.length === 0 || target.length > haystack.length) return -1
  const lower = haystack.map((char) => char.toLowerCase())
  for (let i = 0; i <= lower.length - target.length; i += 1) {
    let matched = true
    for (let j = 0; j < target.length; j += 1) {
      if (lower[i + j] !== target[j]) {
        matched = false
        break
      }
    }
    if (matched) return i
  }
  return -1
}

export async function getSession(db: Db, userId: string, sessionId: string): Promise<SessionItem> {
  const rows = await db.query(
    `SELECT ${sessionItemSelect(db)}
       FROM dsh_sessions s
       LEFT JOIN dsh_platform_session_ops o ON o.session_id = s.id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  )
  const row = rows.rows[0]
  if (!row) throw new HttpError(404, 'not-found')
  return toSessionItem(row)
}

/** 改标题或归档；归档时可按要求先中断当前轮次。 */
export async function updateSession(
  db: Db,
  brain: BrainClient,
  userId: string,
  sessionId: string,
  input: { title?: string; archived?: boolean; stopActivity?: boolean },
): Promise<SessionItem> {
  if (input.title === undefined && input.archived === undefined) throw new HttpError(422, 'nothing-to-update')
  const current = await ownSession(db, userId, sessionId)
  if (input.archived === true && input.stopActivity === true && current.status !== 'archived') {
    const cancelled = await brain.cancel({
      userId,
      workspaceId: current.workspaceId,
      sessionId: current.id,
      requestId: randomBytes(8).toString('hex'),
    })
    if (!cancelled.ok) {
      // 脑上没有活跃 Agent 时取消会返回 not found，按「已经停了」处理。
      const missing = cancelled.status === 404 && cancelled.code === 'session-not-found'
      if (!missing) throw new HttpError(cancelled.status || 502, cancelled.code)
    }
  }
  const title = input.title === undefined ? null : normalizeTitle(input.title)
  const status = input.archived === undefined ? null : input.archived ? 'archived' : 'active'
  await db.query(
    `UPDATE dsh_sessions SET title = COALESCE($3, title), status = COALESCE($4, status), last_active_at = now()
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId, title, status],
  )
  return getSession(db, userId, sessionId)
}

function normalizeTitle(raw: string): string {
  const title = raw.trim()
  if ([...title].length > TITLE_MAX_RUNES) throw new HttpError(422, 'title-too-long')
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 0x20 && char !== '\t') || code === 0x7f) throw new HttpError(422, 'title-invalid')
  }
  return title
}

export async function openSession(
  db: Querier,
  objects: ObjectStore,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  input: { workspaceId?: string; title?: string; modelId?: string; sessionId?: string },
) {
  // 客户端会带自己分配的空会话 id，并且可能用同一个 id 重试；重复 create 要
  // 幂等复用这条会话。别人占用的 id 不允许接管。
  const id = input.sessionId ?? `s_${randomBytes(16).toString('hex')}`
  const prior = await db.query<{ user_id: string; workspace_id: string; state: string | null }>(
    `SELECT s.user_id, s.workspace_id, o.state
       FROM dsh_sessions s
       LEFT JOIN dsh_platform_session_ops o ON o.session_id = s.id
      WHERE s.id = $1`,
    [id],
  )
  const existing = prior.rows[0]
  if (existing !== undefined) {
    if (existing.user_id !== userId) throw new HttpError(409, 'session/id-conflict')
    if (existing.state === 'ready') return { id, createState: 'ready', status: 200 }
  }
  // 没指定工作区就落到成员的默认工作区；指定了必须是这个成员自己的。
  const workspace = existing !== undefined
    ? { id: existing.workspace_id, state: 'active' }
    : input.workspaceId
      ? await activeWorkspace(db, userId, input.workspaceId)
      : await defaultGuest(db, objects, userId)
  const model = await requireModel(db, key, userId, input.modelId)
  await db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, $4, 'platform') ON CONFLICT (id) DO NOTHING`,
    [id, userId, workspace.id, input.title ?? ''],
  )
  await db.query(
    `INSERT INTO dsh_platform_session_ops (session_id, user_id, state) VALUES ($1, $2, 'creating')
     ON CONFLICT (session_id) DO UPDATE SET state = 'creating', error_code = NULL, updated_at = now()`,
    [id, userId],
  )
  const created = await brain.openSession({
    userId,
    workspaceId: workspace.id,
    sessionId: id,
    cwd: WORKSPACE_GUEST_ROOT,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
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
    cwd: WORKSPACE_GUEST_ROOT,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
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
    cwd: WORKSPACE_GUEST_ROOT,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
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
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
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
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
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

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** 客户端可以带自己的 request_id；空值由平台生成，格式不对直接拒绝。 */
function normalizeRequestId(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return randomBytes(8).toString('hex')
  if (!REQUEST_ID.test(trimmed)) throw new HttpError(400, 'invalid-request-id')
  return trimmed
}

export async function forceCancelSession(
  db: Querier,
  brain: BrainClient,
  userId: string,
  sessionId: string,
  requestId?: string,
) {
  const session = await ownSession(db, userId, sessionId)
  const result = await brain.forceCancel({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    requestId: normalizeRequestId(requestId),
  })
  // 没有活跃轮次时脑回 session-not-found；硬取消本来就是幂等的。
  if (!result.ok && !(result.status === 404 && result.code === 'session-not-found')) {
    throw new HttpError(result.status || 502, result.code)
  }
  return result.ok ? result.value ?? null : { forceClosed: false }
}

export function requireActive(session: SessionRecord) {
  if (session.status !== 'active') throw new HttpError(409, 'session-inactive')
  if (session.workspaceState !== 'active') throw new HttpError(409, 'workspace-archived')
}

/** 脑上可能已经没有这个会话（重启/驱逐过）；用它选中的模型（没有则成员默认）重新领养回来。 */
async function ensureActive(db: Querier, brain: BrainClient, key: Buffer, userId: string, session: SessionRecord) {
  const model = await requireModel(db, key, userId, session.modelId)
  const opened = await brain.openSession({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    cwd: WORKSPACE_GUEST_ROOT,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
  })
  if (!opened.ok) throw new HttpError(opened.status || 502, opened.code)
  return model
}

/**
 * composer 能力（投影、反馈、命令、目标、预设）都在脑里，平台只确认归属与状态，
 * 再把调用转发到脑的 `/brain/v1/sessions/{id}/...`。读写都不落在平台宿主上。
 */
export async function composerCall(
  db: Querier,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  sessionId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  suffix: string,
  body?: unknown,
): Promise<unknown> {
  const session = await ownSession(db, userId, sessionId)
  requireActive(session)
  const model = await ensureActive(db, brain, key, userId, session)
  const result = await brain.call(method, {
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    path: `/brain/v1/sessions/${encodeURIComponent(session.id)}${suffix}`,
    body,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelApi: model.api,
    modelId: model.modelId,
    modelIds: model.modelIds,
  })
  if (!result.ok) throw new HttpError(result.status || 502, result.code)
  return result.value ?? null
}

const GOAL_ACTIONS = new Set(['pause', 'resume', 'complete', 'clear'])

/** 老版本脑没有 commands 路由时给空列表，客户端回落内置命令菜单。 */
export async function commands(db: Querier, brain: BrainClient, key: Buffer, userId: string, sessionId: string) {
  try {
    return await composerCall(db, brain, key, userId, sessionId, 'GET', '/commands')
  } catch (error) {
    if (error instanceof HttpError && error.status === 501) return { items: [] }
    throw error
  }
}

export async function executeCommand(
  db: Querier,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  sessionId: string,
  body: unknown,
) {
  return composerCall(db, brain, key, userId, sessionId, 'POST', '/commands', body)
}

export async function goalAction(
  db: Querier,
  brain: BrainClient,
  key: Buffer,
  userId: string,
  sessionId: string,
  action: string,
  body: unknown,
) {
  if (!GOAL_ACTIONS.has(action)) throw new HttpError(400, 'invalid-goal-action')
  return composerCall(db, brain, key, userId, sessionId, 'POST', `/goal/${action}`, body)
}

/** 后台任务的 SSE 流：清单或单个任务的输出。流由脑写，平台原样转发。 */
export async function jobStream(
  db: Querier,
  brain: BrainClient,
  userId: string,
  sessionId: string,
  job: { jobId?: string; from?: number },
  req: Parameters<BrainClient['pipeJobs']>[1],
  res: Parameters<BrainClient['pipeJobs']>[2],
) {
  const session = await ownSession(db, userId, sessionId)
  const result = await brain.pipeJobs(
    { userId, workspaceId: session.workspaceId, sessionId: session.id, jobId: job.jobId, from: job.from },
    req,
    res,
  )
  if (!result.ok) throw new HttpError(result.status || 502, result.code)
}

export async function killJob(db: Querier, brain: BrainClient, userId: string, sessionId: string, jobId: string) {
  const session = await ownSession(db, userId, sessionId)
  const result = await brain.killJob({
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    jobId,
  })
  if (!result.ok) throw new HttpError(result.status || 502, result.code)
  return result.value ?? {}
}

export async function history(db: Querier, userId: string, sessionId: string, after: number) {
  await ownSession(db, userId, sessionId)
  const rows = await db.query(
    `SELECT seq, event AS payload FROM dsh_session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`,
    [sessionId, after],
  )
  return rows.rows.map((row) => {
    const payload = asJson<{ type?: string }>((row as { payload: unknown }).payload)
    return { seq: asNumber((row as { seq: unknown }).seq), type: payload?.type ?? '', payload }
  })
}

export interface HistoryOptions {
  after?: number
  before?: number
  limit?: number
  maxMessages?: number
  minMessages?: number
  minTurns?: number
}

export interface HistoryEvent {
  seq: number
  type: string
  time?: number
  data: unknown
  ignorable?: boolean
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
}

export interface HistoryPage {
  events: HistoryEvent[]
  cursor: number
  after: number
  before: number
  next_before?: number
  has_more: boolean
}

function decodeHistoryEvent(row: Record<string, unknown>): HistoryEvent {
  const value = asJson<Record<string, unknown>>(row.event) ?? {}
  const event: HistoryEvent = {
    seq: asNumber(row.seq),
    type: typeof value.type === 'string' ? value.type : '',
    data: value.data ?? null,
  }
  const time = toMillis(value.time)
  if (time !== null) event.time = time
  if (value.ignorable === true) event.ignorable = true
  if (value.sourceEventSeqs !== undefined && value.sourceEventSeqs !== null) event.sourceEventSeqs = value.sourceEventSeqs
  if (value.surfaceOp !== undefined && value.surfaceOp !== null) event.surfaceOp = value.surfaceOp
  return event
}

async function maxSeq(db: Querier, sessionId: string): Promise<number> {
  const rows = await db.query<{ seq: unknown }>(
    `SELECT COALESCE(MAX(seq), -1) AS seq FROM dsh_session_events WHERE session_id = $1`,
    [sessionId],
  )
  return asNumber(rows.rows[0]?.seq ?? -1)
}

async function readEvents(db: Querier, sessionId: string, from: number, limit: number): Promise<HistoryEvent[]> {
  const rows = await db.query(
    `SELECT seq, event FROM dsh_session_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq LIMIT $3`,
    [sessionId, from, limit],
  )
  return rows.rows.map(decodeHistoryEvent)
}

function isAppendMessage(event: HistoryEvent): boolean {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
  const op = event.surfaceOp
  if (op === undefined || op === null || op === '') return true
  return op === 'append' || op === '"append"'
}

/**
 * 从 before（不含）往回取一页。
 *
 * 页边界与 DSH 一致：先满足 minMessages / minTurns，再停在 turn/start 上；
 * maxMessages 是消息数上限，maxEvents 是防止无界扫描的硬上限。返回按 seq 升序。
 */
async function readEventsBefore(
  db: Querier,
  sessionId: string,
  before: number,
  maxEvents: number,
  maxMessages: number,
  minMessages: number,
  minTurns: number,
): Promise<{ events: HistoryEvent[]; hasMore: boolean }> {
  if (before <= 0 || maxEvents <= 0) return { events: [], hasMore: false }
  const window = minMessages > 0 || minTurns > 0
  const newestFirst: HistoryEvent[] = []
  let cursor = before
  let messages = 0
  let turns = 0
  let stop = false

  while (newestFirst.length < maxEvents) {
    const limit = Math.min(EVENT_BATCH, maxEvents - newestFirst.length)
    const rows = await db.query(
      `SELECT seq, event FROM dsh_session_events WHERE session_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3`,
      [sessionId, cursor, limit],
    )
    const batch = rows.rows.map(decodeHistoryEvent)
    if (batch.length === 0) break
    for (const event of batch) {
      newestFirst.push(event)
      if (isAppendMessage(event)) messages += 1
      if (event.type === 'turn/start') turns += 1
      if (window && messages >= minMessages && turns >= minTurns && event.type === 'turn/start') {
        stop = true
        break
      }
      if (maxMessages > 0 && messages >= maxMessages) {
        stop = true
        break
      }
    }
    cursor = batch[batch.length - 1]!.seq
    if (stop || batch.length < limit || newestFirst.length >= maxEvents) break
  }

  const events = newestFirst.reverse()
  if (events.length === 0) return { events, hasMore: false }
  const more = await db.query(
    `SELECT EXISTS (SELECT 1 FROM dsh_session_events WHERE session_id = $1 AND seq < $2) AS more`,
    [sessionId, events[0]!.seq],
  )
  return { events, hasMore: asBool(more.rows[0]?.more) }
}

/**
 * 有界历史：不传 after/before 时返回最新一页；after 向前增量，before 往回翻。
 */
export async function historyPage(
  db: Querier,
  userId: string,
  sessionId: string,
  options: HistoryOptions = {},
): Promise<HistoryPage> {
  const after = options.after ?? -1
  const before = options.before ?? -1
  const limit = options.limit ?? 0
  const maxMessages = options.maxMessages ?? 0
  const minMessages = options.minMessages ?? 0
  const minTurns = options.minTurns ?? 0
  if (after < -1 || before < -1 || limit < 0 || maxMessages < 0 || minMessages < 0 || minTurns < 0) {
    throw new HttpError(400, 'invalid-pagination')
  }
  if (after >= 0 && before >= 0) throw new HttpError(400, 'after-before-exclusive')
  if (maxMessages > 0 && minMessages > maxMessages) throw new HttpError(400, 'invalid-pagination')

  await ownSession(db, userId, sessionId)
  const cursor = await maxSeq(db, sessionId)

  if (after >= 0) {
    const size = Math.min(limit > 0 ? limit : HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE)
    const events = await readEvents(db, sessionId, after + 1, size + 1)
    const hasMore = events.length > size
    return { events: hasMore ? events.slice(0, size) : events, cursor, after, before: -1, has_more: hasMore }
  }

  const cut = before >= 0 ? before : cursor + 1
  let maxEvents = limit
  if (maxEvents <= 0) maxEvents = maxMessages > 0 || minTurns > 0 ? MAX_HISTORY_PAGE_SIZE : HISTORY_PAGE_SIZE
  maxEvents = Math.min(maxEvents, MAX_HISTORY_PAGE_SIZE)
  const needMessages = minTurns > 0 && minMessages === 0 ? 50 : minMessages
  const { events, hasMore } = await readEventsBefore(db, sessionId, cut, maxEvents, maxMessages, needMessages, minTurns)
  const page: HistoryPage = { events, cursor, after: -1, before: cut, has_more: hasMore }
  if (hasMore && events.length > 0) page.next_before = events[0]!.seq
  return page
}

export async function ownSession(db: Querier, userId: string, sessionId: string): Promise<SessionRecord> {
  const rows = await db.query(
    `SELECT s.id, s.workspace_id, s.title, s.status, s.model_id, w.state AS workspace_state
       FROM dsh_sessions s
       JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  )
  const row = rows.rows[0] as
    | { id: string; workspace_id: string; title: string; status: string; model_id: string | null; workspace_state: string }
    | undefined
  if (!row) throw new HttpError(404, 'not-found')
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    workspaceState: row.workspace_state,
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
  }
}

async function activeWorkspace(db: Querier, userId: string, workspaceId: string) {
  const rows = await db.query(`SELECT id, state FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [workspaceId, userId])
  const workspace = rows.rows[0] as { id: string; state: string } | undefined
  if (!workspace || workspace.state !== 'active') throw new HttpError(404, 'workspace-not-found')
  return workspace
}

async function defaultGuest(db: Querier, objects: ObjectStore, userId: string) {
  const workspace = await ensureDefaultWorkspace(db, objects, userId)
  return { id: workspace.id, state: workspace.state }
}

async function requireModel(db: Querier, key: Buffer, userId: string, selected?: string): Promise<ResolvedModel> {
  const model = await resolveModel(db, key, userId, selected)
  if (!model) throw new HttpError(422, 'model-config-required')
  return model
}
