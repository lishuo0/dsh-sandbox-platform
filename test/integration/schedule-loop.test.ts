import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestPlatform, type TestPlatform } from '../helpers/app.js'
import { createTestDatabase } from '../helpers/pg.js'
import { WORKSPACE_GUEST_ROOT } from '../../src/kernel/layout.js'
import { claimAndFire, deliverOne } from '../../src/modules/schedule/loop.js'
import { saveModel } from '../../src/modules/models/service.js'
import type { BrainClient } from '../../src/brain/client.js'

const OWNER = 'test-host:1'

interface BrainResult {
  ok: boolean
  status?: number
  code?: string
}

/** 平台只调两个脑接口；投递分支按下发的脚本作答。 */
class FakeBrain {
  calls: { kind: 'open' | 'send'; input: Record<string, unknown> }[] = []
  sendResults: BrainResult[] = []
  openResult: BrainResult = { ok: true }

  openSession(input: Record<string, unknown>) {
    this.calls.push({ kind: 'open', input })
    return Promise.resolve(this.openResult)
  }

  /** 模拟投递途中任务被另一台副本改写。 */
  onSend?: () => Promise<void>

  async sendMessage(input: Record<string, unknown>) {
    this.calls.push({ kind: 'send', input })
    await this.onSend?.()
    return this.sendResults.shift() ?? { ok: true }
  }

  sendsFor(id: string) {
    return this.calls
      .filter((call) => call.kind === 'send')
      .filter((call) => String(call.input.text).includes(`schedule_id: ${id}`))
  }

  reset() {
    this.calls = []
    this.sendResults = []
    this.openResult = { ok: true }
    this.onSend = undefined
  }
}

let platform: TestPlatform
let brain: FakeBrain
let userId: string
let workspaceId: string
let sessionId: string

async function addUser(id: string): Promise<void> {
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role, status) VALUES ($1, $2, 'x', 'member', 'active')`,
    [id, id],
  )
}

async function addWorkspace(id: string, owner: string, state = 'active'): Promise<string> {
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, state) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, owner, id, `/tmp/host/${id}`, WORKSPACE_GUEST_ROOT, state],
  )
  return WORKSPACE_GUEST_ROOT
}

async function addSession(id: string, owner: string, workspace: string): Promise<void> {
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, status) VALUES ($1, $2, $3, 'active')`,
    [id, owner, workspace],
  )
}

interface TaskInput {
  kind?: string
  rule?: string
  session?: string
  generation?: number
  status?: string
  nextRunAt?: string
  attemptCount?: number
  leaseOwner?: string | null
  leaseUntil?: string | null
  lastRequestId?: string | null
  lastDelivery?: string | null
  pendingOccurrence?: string | null
}

async function insertTask(input: TaskInput = {}): Promise<string> {
  const id = `sch_${randomBytes(6).toString('hex')}`
  const at = input.nextRunAt ?? new Date(Date.now() - 1_000).toISOString()
  await platform.db.query(
    `INSERT INTO dsh_schedule_tasks (
       id, session_id, title, prompt, kind, rule, generation, status, desired_at, next_run_at,
       lease_owner, lease_until, last_request_id, last_delivery, attempt_count, pending_occurrence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      input.session ?? sessionId,
      '喝水',
      '去喝一杯水',
      input.kind ?? 'at',
      input.rule ?? '{}',
      input.generation ?? 1,
      input.status ?? 'active',
      at,
      input.leaseOwner ?? null,
      input.leaseUntil ?? null,
      input.lastRequestId ?? null,
      input.lastDelivery ?? null,
      input.attemptCount ?? 0,
      input.pendingOccurrence ?? null,
    ],
  )
  return id
}

interface TaskRow {
  status: string
  generation: number | string
  next_run_at: string | Date
  lease_owner: string | null
  lease_until: string | Date | null
  last_request_id: string | null
  last_delivery: string | null
  attempt_count: number | string
  pending_occurrence: string | Date | null
}

async function readTask(id: string): Promise<TaskRow> {
  const rows = await platform.db.query(`SELECT * FROM dsh_schedule_tasks WHERE id = $1`, [id])
  return rows.rows[0] as unknown as TaskRow
}

/** PG 回来是 Date，SQLite 回来是 ISO 字符串；统一按毫秒看。 */
function ms(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
}

function iso(value: unknown): string {
  return new Date(ms(value)).toISOString()
}

async function retire(id: string): Promise<void> {
  await platform.db.query(
    `UPDATE dsh_schedule_tasks SET status = 'inactive', generation = generation + 1, lease_owner = NULL, lease_until = NULL WHERE id = $1`,
    [id],
  )
}

beforeAll(async () => {
  const database = await createTestDatabase(['platform'])
  platform = await startTestPlatform({ database })
  brain = new FakeBrain()
  platform.deps.brain = brain as unknown as BrainClient

  userId = 'u_sched_owner'
  await addUser(userId)
  workspaceId = await addWorkspace('ws_sched', userId)
  sessionId = 's_sched'
  await addSession(sessionId, userId, 'ws_sched')
  await saveModel(platform.db, platform.deps.credentialsKey, userId, {
    baseUrl: 'https://llm.test/v1',
    apiKey: 'sk-test-schedule-1234',
    modelIds: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
  })
})

afterAll(async () => {
  await platform.close()
})

describe('定时任务投递', () => {
  it('一次性任务发完即停用', async () => {
    brain.reset()
    const occurrence = Date.now() - 1_000
    const id = await insertTask({ nextRunAt: new Date(occurrence).toISOString() })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('inactive')
    expect(row.last_delivery).toBe('accepted')
    expect(row.lease_owner).toBeNull()
    expect(row.last_request_id).toBe(`sched.${id}.${occurrence}`)
    const sends = brain.sendsFor(id)
    expect(sends).toHaveLength(1)
    // 沙箱里所有工作区的挂载点都是固定值，定时任务恢复会话时也用它当 cwd。
    expect(brain.calls.find((call) => call.kind === 'open')?.input.cwd).toBe(WORKSPACE_GUEST_ROOT)
    const text = String(sends[0]?.input.text)
    expect(text).toContain('[SCHEDULE REMINDER]')
    expect(text).toContain(`occurrence: ${new Date(occurrence).toISOString()}`)
    expect(text).toContain('prompt: 去喝一杯水')
    expect(sends[0]?.input.modelKey).toBe('sk-test-schedule-1234')
    expect(sends[0]?.input.modelId).toBe('deepseek-chat')
  })

  it('重复任务按规则推到下一个时刻', async () => {
    brain.reset()
    const anchor = new Date(Date.now() - 1_000)
    const id = await insertTask({
      kind: 'every',
      rule: JSON.stringify({ everySeconds: 60, anchor: anchor.toISOString() }),
      nextRunAt: anchor.toISOString(),
    })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('active')
    expect(row.last_delivery).toBe('accepted')
    expect(row.pending_occurrence).toBeNull()
    expect(Number(row.attempt_count)).toBe(0)
    expect(row.lease_owner).toBeNull()
    expect(ms(row.next_run_at)).toBe(anchor.getTime() + 60_000)
    expect(brain.sendsFor(id)).toHaveLength(1)
    await retire(id)
  })

  it('脑明确拒绝：计入失败并留待重试', async () => {
    brain.reset()
    brain.sendResults = [{ ok: false, status: 400, code: 'model-required' }]
    const occurrence = new Date(Date.now() - 1_000)
    const id = await insertTask({ nextRunAt: occurrence.toISOString(), attemptCount: 1 })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('active')
    expect(Number(row.attempt_count)).toBe(2)
    expect(row.last_delivery).toBe('rejected')
    expect(iso(row.pending_occurrence)).toBe(occurrence.toISOString())
    // 30 秒后再试，不在当前时刻反复打
    expect(ms(row.next_run_at)).toBeGreaterThan(Date.now() + 20_000)
    expect(row.lease_owner).toBeNull()
    await retire(id)
  })

  it('连续失败满 5 次停用', async () => {
    brain.reset()
    brain.sendResults = [{ ok: false, status: 422, code: 'nope' }]
    const id = await insertTask({ attemptCount: 4 })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('inactive')
    expect(Number(row.attempt_count)).toBe(5)
    expect(row.last_delivery).toBe('rejected')
  })

  it('结果未知：保留请求号，重试用同一个请求号', async () => {
    brain.reset()
    brain.sendResults = [{ ok: false, status: 502, code: 'brain-unreachable' }]
    const occurrence = Date.now() - 1_000
    const id = await insertTask({ nextRunAt: new Date(occurrence).toISOString() })

    await claimAndFire(platform.deps, OWNER)

    const first = await readTask(id)
    expect(first.status).toBe('active')
    expect(first.last_delivery).toBe('unknown')
    expect(first.lease_owner).toBeNull()
    expect(first.last_request_id).toBe(`sched.${id}.${occurrence}`)
    expect(ms(first.next_run_at)).toBe(occurrence)

    // 下一轮同一条任务再被认领，请求号沿用，脑那边才能去重。
    brain.reset()
    await claimAndFire(platform.deps, OWNER)

    const sends = brain.sendsFor(id)
    expect(sends).toHaveLength(1)
    expect(sends[0]?.input.requestId).toBe(first.last_request_id)
    const after = await readTask(id)
    expect(after.status).toBe('inactive')
    expect(after.last_delivery).toBe('accepted')
  })

  it('开会话失败也按结果未知处理', async () => {
    brain.reset()
    brain.openResult = { ok: false, status: 503, code: 'busy' }
    const occurrence = Date.now() - 1_000
    const id = await insertTask({ nextRunAt: new Date(occurrence).toISOString() })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.last_delivery).toBe('unknown')
    expect(row.last_request_id).toBe(`sched.${id}.${occurrence}`)
    expect(brain.sendsFor(id)).toHaveLength(0)
    await retire(id)
  })

  it('没有模型：挂起 60 秒，不推进也不投递', async () => {
    brain.reset()
    await addUser('u_sched_nomodel')
    await addWorkspace('ws_nomodel', 'u_sched_nomodel')
    await addSession('s_nomodel', 'u_sched_nomodel', 'ws_nomodel')
    const id = await insertTask({ session: 's_nomodel' })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('active')
    expect(row.last_delivery).toBeNull()
    expect(ms(row.next_run_at)).toBeLessThan(Date.now())
    const until = ms(row.lease_until)
    expect(until).toBeGreaterThan(Date.now() + 50_000)
    expect(brain.sendsFor(id)).toHaveLength(0)
    await retire(id)
  })

  it('工作区已归档：同样挂起', async () => {
    brain.reset()
    await addWorkspace('ws_sched_archived', userId, 'archived')
    await addSession('s_sched_archived', userId, 'ws_sched_archived')
    const id = await insertTask({ session: 's_sched_archived' })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('active')
    expect(ms(row.lease_until)).toBeGreaterThan(Date.now() + 50_000)
    expect(brain.sendsFor(id)).toHaveLength(0)
    await retire(id)
  })

  it('认领后任务被改过：放开租约，不投递', async () => {
    brain.reset()
    const id = await insertTask({
      leaseOwner: OWNER,
      leaseUntil: new Date(Date.now() + 40_000).toISOString(),
    })
    const claimed = await readTask(id)

    // 模拟认领之后、投递之前另一台副本改了代际
    await platform.db.query(`UPDATE dsh_schedule_tasks SET generation = generation + 1 WHERE id = $1`, [id])
    await deliverOne(platform.deps, OWNER, { ...claimed, id } as unknown as Record<string, unknown>)

    const row = await readTask(id)
    expect(row.lease_owner).toBeNull()
    expect(brain.sendsFor(id)).toHaveLength(0)
    await retire(id)
  })

  it('认领后下一次时刻被改过：放开租约，不投递', async () => {
    brain.reset()
    const id = await insertTask({
      leaseOwner: OWNER,
      leaseUntil: new Date(Date.now() + 40_000).toISOString(),
    })
    const claimed = await readTask(id)

    await platform.db.query(
      `UPDATE dsh_schedule_tasks SET next_run_at = $2 WHERE id = $1`,
      [id, new Date(Date.now() + 600_000).toISOString()],
    )
    await deliverOne(platform.deps, OWNER, { ...claimed, id } as unknown as Record<string, unknown>)

    const row = await readTask(id)
    expect(row.lease_owner).toBeNull()
    expect(brain.sendsFor(id)).toHaveLength(0)
    await retire(id)
  })

  it('规则算不出下一次：计失败并推迟，满 5 次停用', async () => {
    brain.reset()
    const id = await insertTask({
      kind: 'every',
      // 间隔小于下限，平台算不出下一次
      rule: JSON.stringify({ everySeconds: 30, anchor: new Date(Date.now() - 60_000).toISOString() }),
      attemptCount: 4,
    })

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.status).toBe('inactive')
    expect(Number(row.attempt_count)).toBe(5)
    expect(row.last_delivery).toBe('rejected')
    expect(row.lease_owner).toBeNull()
    // 消息本身发出去了，只是推进不了
    expect(brain.sendsFor(id)).toHaveLength(1)
  })

  it('投递途中被改写：消息照发，只补记请求号，不推进', async () => {
    brain.reset()
    const occurrence = Date.now() - 1_000
    const id = await insertTask({ nextRunAt: new Date(occurrence).toISOString() })
    brain.onSend = async () => {
      await platform.db.query(`UPDATE dsh_schedule_tasks SET generation = generation + 1 WHERE id = $1`, [id])
    }

    await claimAndFire(platform.deps, OWNER)

    const row = await readTask(id)
    expect(row.last_delivery).toBe('accepted')
    expect(row.last_request_id).toBe(`sched.${id}.${occurrence}`)
    expect(Number(row.generation)).toBe(2)
    expect(row.lease_owner).toBeNull()
    expect(brain.sendsFor(id)).toHaveLength(1)
    await retire(id)
  })
})
