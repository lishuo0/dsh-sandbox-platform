import type { AppConfig } from '../../config.js'
import type { Db } from '../../kernel/db.js'
import { asJson, asNumber } from '../../kernel/row.js'

/**
 * `dsh-context` 浏览器半要的数据。
 *
 * 概览和会话卡只读平台自己的投影表；会话详情按文档重放脑写的
 * `dsh_session_events`，归属校验在路由层用 `ownSession` 做。
 */

interface StepTotals {
  steps: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  usageSessions: number
}

interface SessionRow {
  id: string
  title: string | null
  status: string
  model_id: string | null
  created_at: unknown
  last_active_at: unknown
  tokens: unknown
  turns: unknown
  last_usage: unknown
  amount: unknown
  priced: unknown
}

export function pricingReady(cfg: AppConfig): boolean {
  const models = cfg.pricing?.models
  return models !== undefined && Object.keys(models).length > 0
}

/** 概览的四个块。scope 里的范围/筛选这一期只应用到会话卡搜索和分页。 */
export async function overview(
  db: Db,
  userId: string,
  body: Record<string, unknown>,
  ready: boolean,
): Promise<Record<string, unknown>> {
  const part = typeof body.part === 'string' ? body.part : ''
  if (part === 'summary') {
    return { revision: String(Date.now()), pricingReady: ready, summary: await summary(db, userId) }
  }
  if (part === 'days') {
    return { revision: String(Date.now()), pricingReady: ready, days: await days(db, userId) }
  }
  if (part === 'tally') {
    const field = body.tally === 'tools' || body.tally === 'cmds' || body.tally === 'skills'
      ? body.tally
      : 'tools'
    return { revision: String(Date.now()), pricingReady: ready, tally: { field, stats: [] } }
  }
  const scope = body.scope !== null && typeof body.scope === 'object'
    ? body.scope as Record<string, unknown>
    : {}
  const page = Math.max(0, Math.trunc(Number(body.page) || 0))
  return {
    revision: String(Date.now()),
    pricingReady: ready,
    page: await sessionPage(db, userId, scope, page),
  }
}

async function summary(db: Db, userId: string): Promise<Record<string, unknown>> {
  const totals = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS steps,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
            COALESCE(SUM(output_tokens), 0) AS output,
            COUNT(DISTINCT session_id) AS usage_sessions
       FROM dsh_usage_steps WHERE user_id = $1`,
    [userId],
  )
  const row = totals.rows[0] ?? {}
  const steps = count(row.steps)
  const input = count(row.input)
  const cacheRead = count(row.cache_read)
  const cacheWrite = count(row.cache_write)
  const output = count(row.output)
  const usageSessions = count(row.usage_sessions)

  const sessions = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived
       FROM dsh_sessions WHERE user_id = $1`,
    [userId],
  )
  const s = sessions.rows[0] ?? {}

  const priced = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS priced_steps,
            COUNT(DISTINCT session_id) AS priced_sessions,
            COALESCE(SUM(amount), 0) AS amount
       FROM dsh_usage_steps WHERE user_id = $1 AND amount IS NOT NULL`,
    [userId],
  )
  const p = priced.rows[0] ?? {}
  const pricedSteps = count(p.priced_steps)
  const totalSessions = count(s.total)
  return {
    sessions: count(s.active),
    sessionsTotal: totalSessions,
    sessionsArchived: count(s.archived),
    archivedScoped: 0,
    tokens: input + cacheRead + cacheWrite + output,
    turns: steps,
    costUsd: pricedSteps > 0 ? Number(p.amount) : null,
    costSessions: count(p.priced_sessions),
    usageSessions,
    cacheHit: null,
    tokenParts: [
      { key: 'uncached', value: input },
      { key: 'cacheRead', value: cacheRead },
      { key: 'cacheWrite', value: cacheWrite },
      { key: 'output', value: output },
    ],
    timing: {
      wallMs: 0, ttftMs: 0, genMs: 0, calls: steps,
      toolsMs: 0, toolCalls: 0, tools: {},
    },
    windowTiming: { calls: steps, toolCalls: 0, toolsMs: 0, wallMs: 0 },
    coverage: {
      complete: true,
      running: false,
      remaining: 0,
      failed: 0,
      total: usageSessions,
      covered: usageSessions,
      unsupported: 0,
    },
  }
}

async function days(db: Db, userId: string): Promise<Record<string, unknown>[]> {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - 6)
  const day = db.dialect === 'sqlite'
    ? `substr(at, 1, 10)`
    : `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${day} AS day,
            COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens), 0) AS tokens,
            COUNT(DISTINCT session_id) AS sessions,
            COALESCE(SUM(amount), 0) AS amount,
            COUNT(amount) AS priced
       FROM dsh_usage_steps
      WHERE user_id = $1 AND at >= $2
      GROUP BY day
      ORDER BY day`,
    [userId, start.toISOString()],
  )
  const found = new Map<string, Record<string, unknown>>()
  for (const row of rows.rows) found.set(String(row.day), row)
  const result: Record<string, unknown>[] = []
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(start)
    date.setUTCDate(start.getUTCDate() + offset)
    const key = date.toISOString().slice(0, 10)
    const row = found.get(key)
    result.push({
      key,
      tokens: count(row?.tokens),
      sessions: count(row?.sessions),
      costUsd: count(row?.priced) > 0 ? Number(row?.amount) : null,
    })
  }
  return result
}

async function sessionPage(
  db: Db,
  userId: string,
  scope: Record<string, unknown>,
  page: number,
): Promise<Record<string, unknown>> {
  const rows = await db.query<SessionRow>(
    `SELECT s.id, s.title, s.status, s.model_id, s.created_at, s.last_active_at,
            COALESCE(SUM(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens), 0) AS tokens,
            COUNT(u.seq) AS turns,
            MAX(u.at) AS last_usage,
            COALESCE(SUM(u.amount), 0) AS amount,
            COUNT(u.amount) AS priced
       FROM dsh_sessions s
       LEFT JOIN dsh_usage_steps u ON u.session_id = s.id AND u.user_id = $1
      WHERE s.user_id = $1
      GROUP BY s.id, s.title, s.status, s.model_id, s.created_at, s.last_active_at
      ORDER BY COALESCE(MAX(u.at), s.last_active_at) DESC`,
    [userId],
  )
  const latest = await latestSteps(db, userId)
  const query = typeof scope.query === 'string' ? scope.query.trim().toLowerCase() : ''
  const filtered = query === ''
    ? rows.rows
    : rows.rows.filter((row) => `${row.title ?? ''} ${row.id}`.toLowerCase().includes(query))
  const size = 20
  const total = filtered.length
  const items = filtered.slice(page * size, page * size + size).map((row) => {
    const step = latest.get(row.id)
    return {
      id: row.id,
      title: row.title && row.title !== '' ? row.title : row.id,
      updatedAt: ms(row.last_usage ?? row.last_active_at ?? row.created_at),
      running: row.status === 'active',
      archived: row.status === 'archived',
      tokens: count(row.tokens),
      turns: count(row.turns),
      steps: count(row.turns),
      parts: [],
      total: step?.total ?? 0,
      ...(step?.model ? { model: step.model } : row.model_id ? { model: row.model_id } : {}),
      costUsd: count(row.priced) > 0 ? Number(row.amount) : null,
      createdDay: isoDay(row.created_at),
    }
  })
  return {
    items,
    index: page,
    count: size,
    total,
    scopeTotal: total,
    groups: [],
  }
}

async function latestSteps(
  db: Db,
  userId: string,
): Promise<Map<string, { total: number; model: string; seq: number }>> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT u.session_id, u.seq, u.model,
            u.input_tokens + u.cache_read_tokens + u.cache_write_tokens AS total
       FROM dsh_usage_steps u
       JOIN (
         SELECT session_id, MAX(seq) AS seq
           FROM dsh_usage_steps WHERE user_id = $1 GROUP BY session_id
       ) m ON m.session_id = u.session_id AND m.seq = u.seq
      WHERE u.user_id = $1`,
    [userId],
  )
  const map = new Map<string, { total: number; model: string; seq: number }>()
  for (const row of rows.rows) {
    map.set(String(row.session_id), {
      total: count(row.total),
      model: typeof row.model === 'string' ? row.model : '',
      seq: count(row.seq),
    })
  }
  return map
}

/** 会话详情：重放脑的事件，并给出当前上下文大小和会话累计。 */
export async function detail(
  db: Db,
  sessionId: string,
): Promise<{ rev: number; head: Record<string, unknown>; events: unknown[] }> {
  const rows = await db.query<{ seq: unknown; event: unknown }>(
    `SELECT seq, event FROM dsh_session_events
      WHERE session_id = $1 ORDER BY seq LIMIT 5000`,
    [sessionId],
  )
  const requests: Record<string, unknown>[] = []
  const replay: unknown[] = []
  let latestUsage: Usage | null = null
  let turns = 0
  let maxSeq = 0
  for (const row of rows.rows) {
    const seq = asNumber(row.seq)
    if (seq > maxSeq) maxSeq = seq
    const event = parsedEvent(row.event)
    if (event === null) continue
    const type = event.type
    if (type === 'assistant/message') {
      const usage = usageOf(event)
      if (usage !== null) {
        latestUsage = usage
        turns += 1
        requests.push(requestPoint(seq, usage))
      }
    }
    if (typeof type === 'string' && KEEP.has(type)) replay.push(stripStream(event))
  }
  const rev = await sessionRev(db, sessionId, maxSeq)
  const head = headOf(latestUsage, requests, replay, rev)
  return { rev, head, events: replay }
}

/** `facts` 的按块读取；不认识的块名放进 `missing`。 */
export async function facts(
  db: Db,
  sessionId: string,
  parts: string[],
): Promise<Record<string, unknown>> {
  const { rev, head, events } = await detail(db, sessionId)
  const requests = Array.isArray(head.requests) ? head.requests : []
  const out: Record<string, unknown> = {}
  const missing: string[] = []
  for (const part of parts) {
    if (part === 'head') {
      out.head = head
    } else if (part === 'series' || part === 'requests') {
      out.series = requests
    } else if (part === 'events') {
      out.events = events
    } else if (part === 'nodes') {
      out.nodes = { nodes: [], archive: [], droppedNodes: 0 }
    } else if (part === 'files') {
      out.files = { fileOps: [] }
    } else if (part === 'commands') {
      out.commands = { commands: [] }
    } else if (part === 'spans') {
      out.spans = []
    } else {
      missing.push(part)
    }
  }
  return { rev, live: true, parts: out, ...(missing.length > 0 ? { missing } : {}) }
}

/** 会话列表的轻量头部；只返回属于当前用户的会话。 */
export async function heads(
  db: Db,
  userId: string,
  ids: string[],
): Promise<Record<string, unknown>> {
  if (ids.length === 0) return {}
  const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ')
  const owned = await db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions WHERE user_id = $1 AND id IN (${placeholders})`,
    [userId, ...ids],
  )
  const allowed = new Set(owned.rows.map((row) => row.id))
  const result: Record<string, unknown> = {}
  for (const id of ids) {
    if (!allowed.has(id)) continue
    const latest = await db.query<Record<string, unknown>>(
      `SELECT seq, provider, model,
              input_tokens + cache_read_tokens + cache_write_tokens AS total
         FROM dsh_usage_steps WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`,
      [id],
    )
    const row = latest.rows[0]
    const total = count(row?.total)
    const rev = await sessionRev(db, id, count(row?.seq))
    result[id] = {
      head: headOf(
        row === undefined
          ? null
          : {
              input: total,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              provider: typeof row.provider === 'string' ? row.provider : '',
              model: typeof row.model === 'string' ? row.model : '',
              at: 0,
            },
        [],
        [],
        rev,
      ),
    }
  }
  return result
}

interface Usage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  provider: string
  model: string
  at: number
}

const KEEP = new Set([
  'assistant/message',
  'request/header',
  'tool/call',
  'tool/result',
])

function headOf(
  usage: Usage | null,
  requests: Record<string, unknown>[],
  events: unknown[],
  rev: number,
): Record<string, unknown> {
  const context = usage === null ? 0 : usage.input + usage.cacheRead + usage.cacheWrite
  const last = requests.length > 0 ? requests[requests.length - 1] : undefined
  return {
    ok: true,
    current: {
      system: 0,
      tools: 0,
      user: context,
      inject: 0,
      skill: 0,
      assistant: 0,
      tool: 0,
      total: context,
    },
    requests,
    events,
    nodes: [],
    droppedNodes: 0,
    archive: [],
    counts: {
      turns: requests.length,
      steps: requests.length,
      injects: 0,
      compactions: 0,
      prunes: 0,
      skills: 0,
    },
    ...(last === undefined ? {} : { last }),
    detailRev: rev,
    ...(usage?.model ? { model: usage.model } : {}),
    ...(usage?.provider ? { provider: usage.provider } : {}),
    costRead: { ready: false },
    timing: {
      wallMs: 0, ttftMs: 0, genMs: 0, calls: requests.length,
      toolsMs: 0, toolCalls: 0, tools: {},
    },
    generatedAnswerTokens: usage?.output ?? 0,
  }
}

function requestPoint(seq: number, usage: Usage): Record<string, unknown> {
  const context = usage.input + usage.cacheRead + usage.cacheWrite
  return {
    seq,
    time: usage.at,
    prompt: context,
    total: context,
    system: 0,
    tools: 0,
    user: context,
    inject: 0,
    skill: 0,
    assistant: 0,
    tool: 0,
  }
}

function parsedEvent(value: unknown): Record<string, unknown> | null {
  try {
    const event = asJson<Record<string, unknown>>(value)
    return event !== null && typeof event === 'object' && !Array.isArray(event) ? event : null
  } catch {
    return null
  }
}

function usageOf(event: Record<string, unknown>): Usage | null {
  const data = record(event.data)
  const usage = record(data?.usage)
  if (usage === null) return null
  const count = (key: string): number => {
    const n = Number(usage[key])
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  }
  let input = count('inputTokens')
  const cacheRead = count('cacheReadTokens')
  const cacheWrite = count('cacheWriteTokens')
  const output = count('outputTokens')
  const total = count('totalTokens')
  if (input + cacheRead + cacheWrite + output === 0 && total > 0) input = total
  const message = record(data?.message)
  const source = record(message?.source) ?? record(data?.source)
  const time = Number(event.time)
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    provider: typeof source?.provider === 'string' ? source.provider : '',
    model: typeof source?.model === 'string' ? source.model : '',
    at: Number.isFinite(time) && time > 0 ? time : Date.now(),
  }
}

function stripStream(event: Record<string, unknown>): Record<string, unknown> {
  const data = record(event.data)
  if (data === null || data.stream === undefined) return event
  const { stream: _stream, ...rest } = data
  return { ...event, data: rest }
}

async function sessionRev(db: Db, sessionId: string, fallback: number): Promise<number> {
  try {
    const rows = await db.query<{ next_seq: unknown }>(
      `SELECT next_seq FROM dsh_session_headers WHERE session_id = $1`,
      [sessionId],
    )
    if (rows.rows[0] === undefined) return fallback
    return Math.max(0, count(rows.rows[0].next_seq) - 1)
  } catch (error) {
    if (missingTable(error)) return fallback
    throw error
  }
}

/** 空操作的 delta：形状必须完整，浏览器才不会把整块判坏。 */
export function emptyDelta(): Record<string, unknown> {
  const zero = {
    system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0,
  }
  return {
    added: [],
    viewNodes: [],
    viewHeader: null,
    viewSystem: null,
    system: null,
    tools: [],
    header: null,
    counts: zero,
    tokens: zero,
    removedCounts: zero,
    tokenUp: zero,
    tokenDown: zero,
    items: 0,
    total: 0,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function ms(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function isoDay(value: unknown): string {
  return new Date(ms(value)).toISOString().slice(0, 10)
}

function missingTable(error: unknown): boolean {
  const shaped = error as { code?: unknown; message?: unknown }
  return shaped?.code === '42P01'
    || (typeof shaped?.message === 'string' && shaped.message.includes('no such table'))
}
