import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readSse } from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { API, api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 会话 composer 能力面：投影、消息反馈、会话反馈、命令、目标、预设、
 * 后台任务和硬取消。平台只判归属与状态，能力本身在脑里执行。
 */

let stack: JointStack
let workspaceId: string
let sessionId: string

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token)
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: 'composer 工作区' },
  })
  workspaceId = workspace.body.data.id
  const session = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId, title: 'composer 会话' },
  })
  sessionId = session.body.data.id
})

afterAll(async () => {
  await stack.close()
})

describe('会话 composer 能力', () => {
  it('投影快照由脑返回', async () => {
    const response = await api<{ projections: unknown[] }>(stack.baseUrl, `/sessions/${sessionId}/projections`, {
      token: stack.token,
    })
    expect(response.status).toBe(200)
    expect(response.body.data.projections).toEqual([{ kind: 'baseline', tokens: 0 }])
  })

  it('消息反馈 GET/POST/DELETE 原样转发', async () => {
    const list = await api<{ items: unknown[] }>(stack.baseUrl, `/sessions/${sessionId}/message-feedback`, {
      token: stack.token,
    })
    expect(list.status).toBe(200)
    expect(list.body.data.items).toEqual([{ messageId: 'm1', value: 'up' }])

    const put = await api<{ item: unknown }>(stack.baseUrl, `/sessions/${sessionId}/message-feedback`, {
      method: 'POST',
      token: stack.token,
      body: { messageId: 'm2', value: 'down' },
    })
    expect(put.status).toBe(200)
    expect(put.body.data.item).toEqual({ messageId: 'm2', value: 'down' })

    const removed = await api<{ removed: boolean }>(stack.baseUrl, `/sessions/${sessionId}/message-feedback`, {
      method: 'DELETE',
      token: stack.token,
      body: { messageId: 'm2' },
    })
    expect(removed.status).toBe(200)
    expect(removed.body.data.removed).toBe(true)
  })

  it('会话反馈落给脑记录', async () => {
    const response = await api<{ recorded: boolean }>(stack.baseUrl, `/sessions/${sessionId}/feedback`, {
      method: 'POST',
      token: stack.token,
      body: { text: '回答很好', category: 'other' },
    })
    expect(response.status).toBe(200)
    expect(response.body.data.recorded).toBe(true)
    expect(stack.gateway.composerCalls).toContainEqual({
      method: 'POST',
      path: '/feedback',
      body: { text: '回答很好', category: 'other' },
    })
  })

  it('命令清单和执行都走脑', async () => {
    const list = await api<{ items: Array<{ name: string }> }>(stack.baseUrl, `/sessions/${sessionId}/commands`, {
      token: stack.token,
    })
    expect(list.status).toBe(200)
    expect(list.body.data.items.map((item) => item.name)).toEqual(['/help'])

    const run = await api<{ result: { line: string } }>(stack.baseUrl, `/sessions/${sessionId}/commands`, {
      method: 'POST',
      token: stack.token,
      body: { line: '/plan on' },
    })
    expect(run.status).toBe(200)
    expect(run.body.data.result.line).toBe('/plan on')
    expect(stack.gateway.composerCalls).toContainEqual({ method: 'POST', path: '/commands', body: '/plan on' })
  })

  it('目标读取、整体编辑和动作', async () => {
    const read = await api<{ goal: { objective: string } }>(stack.baseUrl, `/sessions/${sessionId}/goal`, {
      token: stack.token,
    })
    expect(read.body.data.goal.objective).toBe('完成接口')

    const edited = await api<{ objective: string }>(stack.baseUrl, `/sessions/${sessionId}/goal`, {
      method: 'PUT',
      token: stack.token,
      body: { objective: '把 composer 接口补齐' },
    })
    expect(edited.body.data.objective).toBe('把 composer 接口补齐')

    const paused = await api<{ action: string }>(stack.baseUrl, `/sessions/${sessionId}/goal/pause`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(paused.body.data.action).toBe('pause')

    const unknown = await api(stack.baseUrl, `/sessions/${sessionId}/goal/bogus`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.msg).toBe('invalid-goal-action')
  })

  it('选择预设', async () => {
    const response = await api<{ agentPreset: string }>(stack.baseUrl, `/sessions/${sessionId}/preset`, {
      method: 'POST',
      token: stack.token,
      body: { agentPreset: 'read-only' },
    })
    expect(response.status).toBe(200)
    expect(response.body.data.agentPreset).toBe('read-only')
  })

  it('任务清单和输出都是脑的 SSE 原样转发', async () => {
    const roster = await readSse(stack.baseUrl, `${API}/sessions/${sessionId}/jobs`, {
      headers: { authorization: `Bearer ${stack.token}` },
      until: (events) => events.some((event) => event.event === 'rows'),
    })
    try {
      const rows = roster.events.find((event) => event.event === 'rows')
      expect(rows?.data).toMatchObject({ jobs: [{ id: 'bash-1', status: 'running' }] })
    } finally {
      roster.close()
    }

    const output = await readSse(stack.baseUrl, `${API}/sessions/${sessionId}/jobs/bash-1/output?from=3`, {
      headers: { authorization: `Bearer ${stack.token}` },
      until: (events) => events.some((event) => event.event === 'output'),
    })
    try {
      const names = output.events.map((event) => event.event)
      expect(names).toEqual(expect.arrayContaining(['opened', 'output']))
      expect(output.events.find((event) => event.event === 'opened')?.data).toMatchObject({ from: 3 })
    } finally {
      output.close()
    }
  })

  it('from 必须是自然数', async () => {
    const response = await api(stack.baseUrl, `/sessions/${sessionId}/jobs/bash-1/output?from=-2`, {
      token: stack.token,
    })
    expect(response.status).toBe(400)
    expect(response.body.msg).toBe('invalid-from')
  })

  it('结束任务由脑执行', async () => {
    const response = await api<{ outcome: string }>(stack.baseUrl, `/sessions/${sessionId}/jobs/bash-1/kill`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(response.status).toBe(200)
    expect(response.body.data.outcome).toBe('requested')
    expect(stack.gateway.killedJobs).toEqual(['bash-1'])
  })

  it('硬取消闭合脑上的轮次', async () => {
    const response = await api<{ forceClosed: boolean }>(stack.baseUrl, `/sessions/${sessionId}/force-cancel`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(response.status).toBe(202)
    expect(response.body.data.forceClosed).toBe(true)
  })

  it('别人的会话一律 404，不会碰到脑', async () => {
    const foreign = await api(stack.baseUrl, '/sessions/s_missing/goal', { token: stack.token })
    expect(foreign.status).toBe(404)
    expect(foreign.body.msg).toBe('not-found')
  })
})
