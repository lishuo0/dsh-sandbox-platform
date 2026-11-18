import { hostname } from 'node:os'
import type { Deps } from '../../app/deps.js'
import { WORKSPACE_GUEST_ROOT } from '../../kernel/layout.js'
import { asJson } from '../../kernel/row.js'
import { resolveModel } from '../models/service.js'
import { nextRun, type ScheduleRule } from './clock.js'

/** 平台副本认领到期任务，先恢复会话再按平常的发消息送出。不在脑进程里计时。 */
export function startScheduleLoop(deps: Deps): void {
  const owner = `${hostname()}:${process.pid}`
  setInterval(() => {
    void claimAndFire(deps, owner).catch((error: unknown) => {
      console.error('schedule', error instanceof Error ? error.message : error)
    })
  }, 2000)
}

const CLAIM_PG = `UPDATE dsh_schedule_tasks AS t
    SET lease_owner = $1, lease_until = $2, updated_at = now()
   FROM (
     SELECT id FROM dsh_schedule_tasks
      WHERE status = 'active' AND next_run_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_run_at
      FOR UPDATE SKIP LOCKED
      LIMIT 8
   ) AS due
  WHERE t.id = due.id
  RETURNING t.id, t.session_id, t.title, t.prompt, t.kind, t.rule, t.generation,
            t.next_run_at, t.last_request_id, t.last_delivery, t.attempt_count, t.pending_occurrence`

const CLAIM_SQLITE = `UPDATE dsh_schedule_tasks
    SET lease_owner = $1, lease_until = $2, updated_at = now()
  WHERE id IN (
    SELECT id FROM dsh_schedule_tasks
     WHERE status = 'active' AND next_run_at <= now()
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY next_run_at
     LIMIT 8
  )
  RETURNING id, session_id, title, prompt, kind, rule, generation,
            next_run_at, last_request_id, last_delivery, attempt_count, pending_occurrence`

/** 认领一批到期任务并投递；导出给测试直接驱动，正常运行由上面的定时器调用。 */
export async function claimAndFire(deps: Deps, owner: string) {
  const leaseUntil = new Date(Date.now() + 45_000).toISOString()
  const claimed = await deps.db.query(deps.db.dialect === 'sqlite' ? CLAIM_SQLITE : CLAIM_PG, [owner, leaseUntil])
  for (const row of claimed.rows) await deliverOne(deps, owner, row)
}

/** 投递一条已认领的任务；导出给测试直接驱动认领之后的复查与分支。 */
export async function deliverOne(deps: Deps, owner: string, row: Record<string, unknown>) {
  const id = String(row.id)
  const generation = Number(row.generation)
  const fresh = await deps.db.query(
    `SELECT generation, status, next_run_at FROM dsh_schedule_tasks WHERE id = $1 AND lease_owner = $2`,
    [id, owner],
  )
  const current = fresh.rows[0] as { generation: string; status: string; next_run_at: string | Date } | undefined
  const stale = current !== undefined && instant(current.next_run_at) !== instant(row.next_run_at)
  if (!current || Number(current.generation) !== generation || current.status !== 'active' || stale) {
    await release(deps, id, owner)
    return
  }
  const session = await deps.db.query(
    `SELECT s.id, s.user_id, s.workspace_id, s.status, w.state AS workspace_state
       FROM dsh_sessions s
       JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1`,
    [row.session_id],
  )
  const owned = session.rows[0] as
    | { id: string; user_id: string; workspace_id: string; status: string; workspace_state: string | null }
    | undefined
  const model = owned ? await resolveModel(deps.db, deps.credentialsKey, owned.user_id) : undefined
  if (!owned || owned.status !== 'active' || owned.workspace_state === 'archived' || !model) {
    await hold(deps, id, generation)
    return
  }
  const occurrence = new Date(instant(row.pending_occurrence ?? row.next_run_at))
  const requestId = row.last_delivery === 'unknown' && row.last_request_id ? String(row.last_request_id) : `sched.${id}.${occurrence.getTime()}`
  const call = {
    userId: owned.user_id,
    workspaceId: owned.workspace_id,
    sessionId: owned.id,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
    modelIds: model.modelIds,
  }
  const opened = await deps.brain.openSession({ ...call, cwd: WORKSPACE_GUEST_ROOT })
  const sent = opened.ok
    ? await deps.brain.sendMessage({
        ...call,
        requestId,
        text: ['[SCHEDULE REMINDER]', `schedule_id: ${id}`, `occurrence: ${occurrence.toISOString()}`, `title: ${String(row.title)}`, `prompt: ${String(row.prompt)}`].join('\n'),
      })
    : opened
  if (sent.ok) {
    await advance(deps, id, generation, owner, row, occurrence, requestId)
    return
  }
  if (sent.status >= 500 || sent.status === 0) {
    await deps.db.query(
      `UPDATE dsh_schedule_tasks
          SET last_request_id = $3, last_delivery = 'unknown', lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [id, generation, requestId],
    )
    return
  }
  const attempts = Number(row.attempt_count) + 1
  const retryAt = new Date(Date.now() + 30_000).toISOString()
  await deps.db.query(
    `UPDATE dsh_schedule_tasks
        SET attempt_count = $3,
            status = CASE WHEN $3 >= 5 THEN 'inactive' ELSE status END,
            lease_owner = NULL,
            lease_until = NULL,
            last_delivery = 'rejected',
            next_run_at = CASE WHEN $3 >= 5 THEN next_run_at ELSE $5 END,
            pending_occurrence = COALESCE(pending_occurrence, $4),
            updated_at = now()
      WHERE id = $1 AND generation = $2`,
    [id, generation, attempts, occurrence.toISOString(), retryAt],
  )
}

async function advance(deps: Deps, id: string, generation: number, owner: string, row: Record<string, unknown>, occurrence: Date, requestId: string) {
  let changed: number
  if (row.kind === 'after' || row.kind === 'at') {
    const result = await deps.db.query(
      `UPDATE dsh_schedule_tasks
          SET status = 'inactive', lease_owner = NULL, lease_until = NULL,
              last_request_id = $3, last_delivery = 'accepted', updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [id, generation, requestId],
    )
    changed = result.rowCount ?? 0
  } else {
    let following: Date
    try {
      following = nextRun(String(row.kind), asJson<ScheduleRule>(row.rule), occurrence)
    } catch (error) {
      const retryAt = new Date(Date.now() + 30_000).toISOString()
      await deps.db.query(
        `UPDATE dsh_schedule_tasks
            SET attempt_count = attempt_count + 1,
                status = CASE WHEN attempt_count + 1 >= 5 THEN 'inactive' ELSE status END,
                next_run_at = CASE WHEN attempt_count + 1 >= 5 THEN next_run_at ELSE $3 END,
                lease_owner = NULL, lease_until = NULL, last_delivery = 'rejected', updated_at = now()
          WHERE id = $1 AND generation = $2`,
        [id, generation, retryAt],
      )
      console.error('schedule next', error instanceof Error ? error.message : error)
      return
    }
    const result = await deps.db.query(
      `UPDATE dsh_schedule_tasks
          SET next_run_at = $3, pending_occurrence = NULL, attempt_count = 0,
              lease_owner = NULL, lease_until = NULL,
              last_request_id = $4, last_delivery = 'accepted', updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [id, generation, following.toISOString(), requestId],
    )
    changed = result.rowCount ?? 0
  }
  if (changed > 0) return
  // 代际对不上就放弃推进，但消息已经收下，只补记投递编号，下次不会换号重发。
  await deps.db.query(
    `UPDATE dsh_schedule_tasks
        SET last_request_id = $2, last_delivery = 'accepted', lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $3`,
    [id, requestId, owner],
  )
}

/** 只放开自己持有的租约；被别的副本改过或接手时不要动别人的。 */
async function release(deps: Deps, id: string, owner: string) {
  await deps.db.query(`UPDATE dsh_schedule_tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`, [id, owner])
}

async function hold(deps: Deps, id: string, generation: number) {
  const until = new Date(Date.now() + 60_000).toISOString()
  await deps.db.query(`UPDATE dsh_schedule_tasks SET lease_until = $3 WHERE id = $1 AND generation = $2`, [id, generation, until])
}

/** PostgreSQL 的 timestamptz 回来是 Date，SQLite 回来是 ISO 字符串；按毫秒比较。 */
function instant(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
}
