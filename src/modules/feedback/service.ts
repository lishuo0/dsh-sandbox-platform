/**
 * 会话反馈的读取出口。
 *
 * `/feedback` 命令和「+ → 反馈」对话框把备注写成脑的 `feedback/record`
 * 会话事件；平台按归属把事件读回来，给成员自己看、给管理员汇总。
 * 事件本身是脑写的日志，平台只读不写。
 */

import type { Db } from '../../kernel/db.js'
import { asJson, asNumber } from '../../kernel/row.js'

export interface FeedbackEntry {
  sessionId: string
  seq: number
  at: string
  text: string
  category: string
  sessionTitle: string
  userId: string
  displayName: string
  workspaceId: string
}

export interface FeedbackViewer {
  id: string
  role: 'admin' | 'member'
}

export interface ListFeedbackOptions {
  limit: number
  sessionId?: string
}

export async function listFeedback(
  db: Db,
  viewer: FeedbackViewer,
  options: ListFeedbackOptions,
): Promise<FeedbackEntry[]> {
  const sqlite = db.dialect === 'sqlite'
  const filter = sqlite
    ? `json_extract(e.event, '$.type') = 'feedback/record'`
    : `e.event->>'type' = 'feedback/record'`
  // 跨会话汇总时 seq 只在会话内单调，按事件时间排才是真正的新到旧。
  const time = sqlite ? `json_extract(e.event, '$.time')` : `(e.event->>'time')::bigint`
  const order = sqlite ? `${time} DESC, e.seq DESC` : `${time} DESC NULLS LAST, e.seq DESC`
  const scope = viewer.role === 'admin' ? '' : viewer.id
  const rows = await db.query<{
    session_id: string
    seq: unknown
    event: unknown
    title: string | null
    user_id: string
    workspace_id: string | null
    display_name: string | null
  }>(
    `SELECT e.session_id, e.seq, e.event, s.title, s.user_id, s.workspace_id, u.display_name
       FROM dsh_session_events e
       JOIN dsh_sessions s ON s.id = e.session_id
       JOIN dsh_users u ON u.id = s.user_id
      WHERE ${filter}
        AND ($1 = '' OR s.user_id = $1)
        AND ($2 = '' OR s.id = $2)
      ORDER BY ${order}
      LIMIT $3`,
    [scope, options.sessionId ?? '', options.limit],
  )
  const entries: FeedbackEntry[] = []
  for (const row of rows.rows) {
    const event = parseEvent(row.event)
    const data = record(event?.data)
    const time = Number(event?.time)
    entries.push({
      sessionId: row.session_id,
      seq: asNumber(row.seq),
      at: Number.isFinite(time) ? new Date(time).toISOString() : '',
      text: typeof data?.text === 'string' ? data.text : '',
      category: typeof data?.category === 'string' ? data.category : '',
      sessionTitle: row.title ?? '',
      userId: row.user_id,
      displayName: row.display_name ?? '',
      workspaceId: row.workspace_id ?? '',
    })
  }
  return entries
}

function parseEvent(value: unknown): Record<string, unknown> | null {
  try {
    const event = asJson<Record<string, unknown>>(value)
    return event !== null && typeof event === 'object' && !Array.isArray(event) ? event : null
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
