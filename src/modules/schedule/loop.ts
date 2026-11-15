import { hostname } from 'node:os'
import type { Deps } from '../../app/deps.js'
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

async function claimAndFire(deps: Deps, owner: string) {
  const claimed = await deps.db.query(
    `UPDATE dsh_schedule_tasks AS t
        SET lease_owner = $1, lease_until = now() + interval '45 seconds', updated_at = now()
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
                t.next_run_at, t.last_request_id, t.last_delivery, t.attempt_count, t.pending_occurrence`,
    [owner],
  )
  for (const row of claimed.rows) await deliverOne(deps, owner, row)
}

async function deliverOne(deps: Deps, owner: string, row: Record<string, unknown>) {
  const id = String(row.id)
  const generation = Number(row.generation)
  const fresh = await deps.db.query(`SELECT generation, status FROM dsh_schedule_tasks WHERE id = $1 AND lease_owner = $2`, [id, owner])
  const current = fresh.rows[0] as { generation: string; status: string } | undefined
  if (!current || Number(current.generation) !== generation || current.status !== 'active') {
    await release(deps, id, generation)
    return
  }
  const session = await deps.db.query(
    `SELECT s.id, s.user_id, s.workspace_id, s.status, w.guest_root, w.state AS workspace_state
       FROM dsh_sessions s
       LEFT JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1`,
    [row.session_id],
  )
  const owned = session.rows[0] as
    | { id: string; user_id: string; workspace_id: string; status: string; guest_root: string; workspace_state: string | null }
    | undefined
  const model = owned ? await resolveModel(deps.db, deps.credentialsKey, owned.user_id) : undefined
  if (!owned || owned.status !== 'active' || owned.workspace_state === 'archived' || !model) {
    await hold(deps, id, generation)
    return
  }
  const occurrence = new Date(String(row.pending_occurrence ?? row.next_run_at))
  const requestId = row.last_delivery === 'unknown' && row.last_request_id ? String(row.last_request_id) : `sched.${id}.${occurrence.getTime()}`
  const call = {
    userId: owned.user_id,
    workspaceId: owned.workspace_id,
    sessionId: owned.id,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
  }
  const opened = await deps.brain.openSession({ ...call, cwd: owned.guest_root })
  const sent = opened.ok
    ? await deps.brain.sendMessage({
        ...call,
        requestId,
        text: ['[SCHEDULE REMINDER]', `schedule_id: ${id}`, `occurrence: ${occurrence.toISOString()}`, `title: ${String(row.title)}`, `prompt: ${String(row.prompt)}`].join('\n'),
      })
    : opened
  if (sent.ok) {
    await advance(deps, id, generation, row, occurrence, requestId)
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
  await deps.db.query(
    `UPDATE dsh_schedule_tasks
        SET attempt_count = $3,
            status = CASE WHEN $3 >= 5 THEN 'inactive' ELSE status END,
            lease_owner = NULL,
            lease_until = NULL,
            last_delivery = 'rejected',
            next_run_at = CASE WHEN $3 >= 5 THEN next_run_at ELSE now() + interval '30 seconds' END,
            pending_occurrence = COALESCE(pending_occurrence, $4),
            updated_at = now()
      WHERE id = $1 AND generation = $2`,
    [id, generation, attempts, occurrence.toISOString()],
  )
}

async function advance(deps: Deps, id: string, generation: number, row: Record<string, unknown>, occurrence: Date, requestId: string) {
  if (row.kind === 'after' || row.kind === 'at') {
    await deps.db.query(
      `UPDATE dsh_schedule_tasks
          SET status = 'inactive', lease_owner = NULL, lease_until = NULL,
              last_request_id = $3, last_delivery = 'accepted', updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [id, generation, requestId],
    )
    return
  }
  let following: Date
  try {
    following = nextRun(row.rule as ScheduleRule, occurrence)
  } catch (error) {
    await deps.db.query(
      `UPDATE dsh_schedule_tasks
          SET attempt_count = attempt_count + 1,
              status = CASE WHEN attempt_count + 1 >= 5 THEN 'inactive' ELSE status END,
              lease_owner = NULL, lease_until = NULL, last_delivery = 'rejected', updated_at = now()
        WHERE id = $1 AND generation = $2`,
      [id, generation],
    )
    console.error('schedule next', error instanceof Error ? error.message : error)
    return
  }
  await deps.db.query(
    `UPDATE dsh_schedule_tasks
        SET next_run_at = $3, pending_occurrence = NULL, attempt_count = 0,
            lease_owner = NULL, lease_until = NULL,
            last_request_id = $4, last_delivery = 'accepted', updated_at = now()
      WHERE id = $1 AND generation = $2`,
    [id, generation, following.toISOString(), requestId],
  )
}

async function release(deps: Deps, id: string, generation: number) {
  await deps.db.query(`UPDATE dsh_schedule_tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND generation = $2`, [id, generation])
}

async function hold(deps: Deps, id: string, generation: number) {
  await deps.db.query(`UPDATE dsh_schedule_tasks SET lease_until = now() + interval '60 seconds' WHERE id = $1 AND generation = $2`, [id, generation])
}
