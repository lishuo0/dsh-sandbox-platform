import type { Querier } from '../../kernel/db.js'
import { asJson } from '../../kernel/row.js'

const SCHEDULE_LIMIT = 200

export interface ScheduleTaskView {
  id: string
  session_id: string
  session_title: string
  title: string
  prompt: string
  kind: string
  rule: unknown
  status: string
  next_run_at: string
  last_delivery?: string
  generation: number
}

/** 只列当前成员自己会话上的定时任务；写入仍由会话里的工具完成。 */
export async function listSchedules(db: Querier, userId: string): Promise<ScheduleTaskView[]> {
  const rows = await db.query(
    `SELECT t.id, t.session_id, COALESCE(s.title, '') AS session_title,
            t.title, t.prompt, t.kind, t.rule, t.status, t.next_run_at,
            COALESCE(t.last_delivery, '') AS last_delivery, t.generation
       FROM dsh_schedule_tasks t
       JOIN dsh_sessions s ON s.id = t.session_id
      WHERE s.user_id = $1
      ORDER BY CASE WHEN t.status = 'active' THEN 0 ELSE 1 END, t.next_run_at
      LIMIT $2`,
    [userId, SCHEDULE_LIMIT],
  )
  return rows.rows.map((row) => ({
    id: String(row.id),
    session_id: String(row.session_id),
    session_title: String(row.session_title ?? ''),
    title: String(row.title ?? ''),
    prompt: String(row.prompt ?? ''),
    kind: String(row.kind ?? ''),
    rule: asJson(row.rule ?? '{}'),
    status: String(row.status ?? ''),
    next_run_at: iso(row.next_run_at),
    ...(row.last_delivery ? { last_delivery: String(row.last_delivery) } : {}),
    generation: Number(row.generation ?? 0),
  }))
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : ''
}
