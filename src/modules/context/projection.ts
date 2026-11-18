import { createHash } from 'node:crypto'
import type { AppConfig } from '../../config.js'
import type { Deps } from '../../app/deps.js'
import type { Db } from '../../kernel/db.js'
import { asJson, asNumber } from '../../kernel/row.js'

/**
 * 把脑写的 `assistant/message` 投影成平台自己的计价用量。
 *
 * 脑只在沙箱里改状态，事件仍由脑写进共享库；平台只读事件、只写
 * `dsh_usage_steps` / `dsh_usage_cursors`，不反过来驱动脑。
 */

interface Candidate {
  session_id: string
  next_seq: unknown
  user_id: string
  workspace_id: string
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

const BATCH = 500
const SESSIONS_PER_TICK = 8

export function startUsageProjection(deps: Deps): void {
  setInterval(() => {
    void projectUsage(deps).catch((error: unknown) => {
      console.error('context projection', error instanceof Error ? error.message : error)
    })
  }, 3000)
}

/** 扫一批会话；导出给测试直接驱动。 */
export async function projectUsage(deps: Deps): Promise<number> {
  let candidates: Candidate[]
  try {
    candidates = await candidatesWithNewEvents(deps.db)
  } catch (error) {
    // 脑还没建表时平台照常启动，等表出现后再投影。
    if (missingTable(error)) return 0
    throw error
  }
  let written = 0
  for (const candidate of candidates) {
    written += await projectSession(deps, candidate)
  }
  return written
}

async function candidatesWithNewEvents(db: Db): Promise<Candidate[]> {
  const rows = await db.query<Candidate>(
    `SELECT h.session_id, h.next_seq, s.user_id, s.workspace_id
       FROM dsh_session_headers h
       JOIN dsh_sessions s ON s.id = h.session_id
       LEFT JOIN dsh_usage_cursors c ON c.session_id = h.session_id
      WHERE h.next_seq > COALESCE(c.seq, 0)
      ORDER BY h.next_seq - COALESCE(c.seq, 0) DESC
      LIMIT ${SESSIONS_PER_TICK}`,
  )
  return rows.rows
}

async function projectSession(deps: Deps, candidate: Candidate): Promise<number> {
  const sessionId = candidate.session_id
  const cursor = await cursorOf(deps.db, sessionId)
  const rows = await deps.db.query<{ seq: unknown; event: unknown }>(
    `SELECT seq, event FROM dsh_session_events
      WHERE session_id = $1 AND seq > $2
      ORDER BY seq
      LIMIT ${BATCH}`,
    [sessionId, cursor],
  )
  let latest = cursor
  let written = 0
  for (const row of rows.rows) {
    const seq = asNumber(row.seq)
    if (seq > latest) latest = seq
    const usage = usageOf(row.event)
    if (usage === null) continue
    const amount = priceOf(deps.config, usage.provider, usage.model, usage)
    const inserted = await insertStep(
      deps.db, sessionId, seq, candidate, usage, amount, priceVersionOf(deps.config),
    )
    written += inserted
  }
  // 这一页没读满，说明剩下的 seq 都是缺口；直接推进到脑登记的最后一条。
  const nextSeq = asNumber(candidate.next_seq)
  if (rows.rows.length < BATCH) latest = Math.max(latest, nextSeq - 1)
  await saveCursor(deps.db, sessionId, latest)
  return written
}

async function cursorOf(db: Db, sessionId: string): Promise<number> {
  const rows = await db.query<{ seq: unknown }>(
    `SELECT seq FROM dsh_usage_cursors WHERE session_id = $1`,
    [sessionId],
  )
  return rows.rows[0] === undefined ? 0 : asNumber(rows.rows[0].seq)
}

async function insertStep(
  db: Db,
  sessionId: string,
  seq: number,
  candidate: Candidate,
  usage: Usage,
  amount: number | null,
  version: string,
): Promise<number> {
  const values = [
    sessionId,
    seq,
    candidate.user_id,
    candidate.workspace_id ?? '',
    new Date(usage.at).toISOString(),
    usage.provider,
    usage.model,
    usage.input,
    usage.cacheRead,
    usage.cacheWrite,
    usage.output,
    amount === null ? null : version,
    amount,
  ]
  const columns = `(session_id, seq, user_id, workspace_id, at, provider, model,
                    input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                    price_version, amount)`
  const result = await db.query(
    db.dialect === 'sqlite'
      ? `INSERT OR IGNORE INTO dsh_usage_steps ${columns}
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`
      : `INSERT INTO dsh_usage_steps ${columns}
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (session_id, seq) DO NOTHING`,
    values,
  )
  return result.rowCount ?? 0
}

async function saveCursor(db: Db, sessionId: string, seq: number): Promise<void> {
  await db.query(
    db.dialect === 'sqlite'
      ? `INSERT INTO dsh_usage_cursors (session_id, seq) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET seq = max(dsh_usage_cursors.seq, excluded.seq)`
      : `INSERT INTO dsh_usage_cursors (session_id, seq) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET seq = GREATEST(dsh_usage_cursors.seq, EXCLUDED.seq)`,
    [sessionId, seq],
  )
}

function usageOf(value: unknown): Usage | null {
  let event: {
    type?: string
    time?: unknown
    data?: {
      usage?: Record<string, unknown>
      source?: { provider?: unknown; model?: unknown }
      message?: { source?: { provider?: unknown; model?: unknown } }
    }
  }
  try {
    event = asJson(value)
  } catch {
    return null
  }
  if (event?.type !== 'assistant/message') return null
  const usage = event.data?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null
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
  const source = event.data?.message?.source ?? event.data?.source
  const provider = typeof source?.provider === 'string' ? source.provider : ''
  const model = typeof source?.model === 'string' ? source.model : ''
  const time = Number(event.time)
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    provider,
    model,
    at: Number.isFinite(time) && time > 0 ? time : Date.now(),
  }
}

/** 价目按 `provider/model` → `model` → `*` 查找；没配价时金额留空。 */
function priceOf(cfg: AppConfig, provider: string, model: string, usage: Usage): number | null {
  const models = cfg.pricing?.models
  if (models === undefined) return null
  const price = models[`${provider}/${model}`] ?? models[model] ?? models['*']
  if (price === undefined) return null
  const amount = tokens(usage.input, price.input)
    + tokens(usage.cacheRead, price.cacheRead)
    + tokens(usage.cacheWrite, price.cacheWrite)
    + tokens(usage.output, price.output)
  return Number(amount.toFixed(12))
}

function tokens(count: number, pricePerMillion: number): number {
  const rate = Number(pricePerMillion)
  return Number.isFinite(rate) && rate > 0 ? (count * rate) / 1_000_000 : 0
}

/** 改价只影响之后的投影；旧账保留当时的价格版本。 */
let versionCache: { source: string; version: string } | null = null
function priceVersionOf(cfg: AppConfig): string {
  const source = JSON.stringify(cfg.pricing?.models ?? null)
  if (versionCache?.source === source) return versionCache.version
  const version = createHash('sha1').update(source).digest('hex').slice(0, 12)
  versionCache = { source, version }
  return version
}

function missingTable(error: unknown): boolean {
  const shaped = error as { code?: unknown; message?: unknown }
  return shaped?.code === '42P01'
    || (typeof shaped?.message === 'string' && shaped.message.includes('no such table'))
}
