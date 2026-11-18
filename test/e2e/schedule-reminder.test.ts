import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'
import { claimAndFire } from '../../src/modules/schedule/loop.js'

/**
 * 定时提醒的完整链路：平台循环认领任务 → 真实 HTTP 调脑 → 脑按归属校验接收。
 * 只把 DSH 内核和 LLM 换成 MemoryGateway，平台、脑、数据库都是真的。
 */

const OWNER = 'e2e-host:1'

let stack: JointStack
let sessionId: string

async function insertTask(kind: string, rule: string, at: string): Promise<string> {
  const id = `sch_${randomBytes(6).toString('hex')}`
  await stack.db.query(
    `INSERT INTO dsh_schedule_tasks (
       id, session_id, title, prompt, kind, rule, generation, status, desired_at, next_run_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'active', $7, $7)`,
    [id, sessionId, '喝水', '去喝一杯水', kind, rule, at],
  )
  return id
}

async function readTask(id: string): Promise<Record<string, unknown>> {
  const rows = await stack.db.query(`SELECT * FROM dsh_schedule_tasks WHERE id = $1`, [id])
  return rows.rows[0] as Record<string, unknown>
}

function ms(value: unknown): number {
  return value instanceof Date ? value.getTime() : new Date(String(value)).getTime()
}

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token)
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '定时工作区' },
  })
  const created = await api<{ id: string; createState: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId: workspace.body.data.id, title: '定时会话' },
  })
  if (created.body.data.createState !== 'ready') throw new Error(`开会话失败: ${created.status} ${created.text}`)
  sessionId = created.body.data.id
})

afterAll(async () => {
  await stack.close()
})

describe('定时提醒（平台 → 脑）', () => {
  it('一次性任务到点后由平台送进这条会话', async () => {
    const occurrence = Date.now() - 1_000
    const id = await insertTask('at', '{}', new Date(occurrence).toISOString())
    const before = stack.gateway.prompts.length

    await claimAndFire(stack.platform.deps, OWNER)

    const prompt = stack.gateway.prompts.at(-1)
    expect(stack.gateway.prompts.length).toBe(before + 1)
    expect(prompt).toMatchObject({ sessionId, requestId: `sched.${id}.${occurrence}` })
    expect(prompt?.text).toContain('[SCHEDULE REMINDER]')
    expect(prompt?.text).toContain(`schedule_id: ${id}`)
    expect(prompt?.text).toContain('prompt: 去喝一杯水')

    const row = await readTask(id)
    expect(row['status']).toBe('inactive')
    expect(row['last_delivery']).toBe('accepted')
    expect(row['last_request_id']).toBe(`sched.${id}.${occurrence}`)
  })

  it('重复任务送完后推进下一次时刻', async () => {
    const anchor = new Date(Date.now() - 1_000).toISOString()
    const id = await insertTask('every', JSON.stringify({ everySeconds: 60, anchor }), anchor)
    const before = stack.gateway.prompts.length

    await claimAndFire(stack.platform.deps, OWNER)

    expect(stack.gateway.prompts.length).toBe(before + 1)
    const row = await readTask(id)
    expect(row['status']).toBe('active')
    expect(row['last_delivery']).toBe('accepted')
    expect(ms(row['next_run_at'])).toBe(new Date(anchor).getTime() + 60_000)
  })
})
