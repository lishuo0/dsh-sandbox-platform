import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readSse } from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 平台与脑之间的 HTTP 契约：鉴权、归属、幂等、模型、取消、事件续传。
 * 两边都是真实进程内服务，只有 DSH 内核与 LLM 被 MemoryGateway 替掉。
 */

let stack: JointStack
let workspaceId: string
let guestRoot: string
let sessionId: string

/** 绕开平台，直接按平台的身份调用脑。 */
async function brainCall(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    'x-app-id': stack.platform.config.brain.appId,
    'x-app-key': stack.platform.config.brain.appKey,
    'x-dsh-user-id': stack.userId,
    ...(init.headers ?? {}),
  }
  let body: string | undefined
  if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers['content-type'] = 'application/json'
  }
  return fetch(`${stack.brain.baseUrl}${path}`, { method: init.method ?? 'GET', headers, body })
}

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token, { modelIds: ['deepseek-chat', 'deepseek-reasoner'] })
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '契约工作区' },
  })
  workspaceId = workspace.body.data.id
  guestRoot = '/desk'
  const created = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId, title: '契约会话' },
  })
  sessionId = created.body.data.id
})

afterAll(async () => {
  await stack.close()
})

describe('脑鉴权', () => {
  it('缺用户头 401 user-required', async () => {
    const response = await brainCall(`/brain/v1/sessions/${sessionId}/events?after=-1`, {
      headers: { 'x-dsh-user-id': '' },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'user-required' } })
  })

  it('错误 appKey 401 且不区分未知 appId', async () => {
    const wrongKey = await brainCall(`/brain/v1/sessions/${sessionId}/events?after=-1`, {
      headers: { 'x-app-key': 'wrong-key-wrong-key' },
    })
    expect(wrongKey.status).toBe(401)

    const unknownApp = await brainCall(`/brain/v1/sessions/${sessionId}/events?after=-1`, {
      headers: { 'x-app-id': 'nobody' },
    })
    expect(unknownApp.status).toBe(401)
    expect(await unknownApp.json()).toEqual(await (await brainCall(`/brain/v1/sessions/${sessionId}/events?after=-1`, {
      headers: { 'x-app-key': 'wrong-key-wrong-key' },
    })).json())
  })
})

describe('会话归属', () => {
  it('别人的用户头得到 404，和不存在一样', async () => {
    const foreign = await brainCall(`/brain/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'x-dsh-user-id': 'someone-else' },
      body: { text: '偷看', requestId: 'r-foreign' },
    })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toMatchObject({ error: { code: 'session-not-found' } })

    const missing = await brainCall(`/brain/v1/sessions/s_missing/messages`, {
      method: 'POST',
      body: { text: '偷看', requestId: 'r-missing' },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'session-not-found' } })
  })

  it('属主可以正常投递', async () => {
    const owned = await brainCall(`/brain/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'x-request-id': 'r-direct' },
      body: { text: '直接投递', requestId: 'r-direct' },
    })
    expect(owned.status).toBe(202)
    expect(stack.gateway.prompts.at(-1)).toMatchObject({ sessionId, text: '直接投递', requestId: 'r-direct' })
  })
})

describe('平台编排', () => {
  it('同一 requestId 重复投递只进脑一次', async () => {
    const before = stack.gateway.prompts.length
    const body = { text: '幂等消息', requestId: 'req-idem-1' }
    expect((await api(stack.baseUrl, `/sessions/${sessionId}/messages`, { method: 'POST', token: stack.token, body })).status).toBe(202)
    expect((await api(stack.baseUrl, `/sessions/${sessionId}/messages`, { method: 'POST', token: stack.token, body })).status).toBe(202)
    expect(stack.gateway.prompts.length).toBe(before + 1)
  })

  it('切换模型会下发到脑', async () => {
    const switched = await api<{ modelId: string }>(stack.baseUrl, `/sessions/${sessionId}/model`, {
      method: 'POST',
      token: stack.token,
      body: { modelId: 'deepseek-reasoner' },
    })
    expect(switched.status).toBe(200)
    expect(switched.body.data).toEqual({ modelId: 'deepseek-reasoner' })
    expect(stack.gateway.modelSelections.at(-1)).toMatchObject({ sessionId, model: 'deepseek-reasoner' })
  })

  it('取消会下发到脑', async () => {
    const cancelled = await api(stack.baseUrl, `/sessions/${sessionId}/cancel`, { method: 'POST', token: stack.token })
    expect(cancelled.status).toBe(200)
    expect(stack.gateway.cancellations).toContain(sessionId)
  })

  it('事件流按 after 续传：after 超过 head 时只发 snapshot + ready', async () => {
    const stream = await readSse(stack.brain.baseUrl, `/brain/v1/sessions/${sessionId}/events?after=999`, {
      headers: {
        'x-app-id': stack.platform.config.brain.appId,
        'x-app-key': stack.platform.config.brain.appKey,
        'x-dsh-user-id': stack.userId,
      },
      until: (events) => events.some((event) => event.event === 'ready'),
    })
    try {
      const names = stream.events.map((event) => event.event)
      expect(names[0]).toBe('snapshot')
      expect(names).toContain('ready')
      expect(names).not.toContain('event')
    } finally {
      stream.close()
    }
  })

  it('会话视图与有界历史直接读共享库，不依赖脑在线', async () => {
    // 模拟内核写入的事件：平台只读不写。
    await stack.brainDb.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3::jsonb)`, [
      sessionId,
      1,
      JSON.stringify({ type: 'turn/start', time: 1_000, data: {} }),
    ])
    await stack.brainDb.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3::jsonb)`, [
      sessionId,
      2,
      JSON.stringify({ type: 'user/message', time: 2_000, data: { text: '你好', source: { kind: 'user' } } }),
    ])

    const view = await api<Record<string, unknown>>(stack.baseUrl, `/sessions/${sessionId}`, { token: stack.token })
    expect(view.status).toBe(200)
    expect(view.body.data).toMatchObject({
      id: sessionId,
      title: '契约会话',
      blank: false,
      running: true,
      last_prompt_at: new Date(2_000).toISOString(),
    })

    const history = await api<{ events: Array<{ seq: number; type: string }>; cursor: number; has_more: boolean }>(
      stack.baseUrl,
      `/sessions/${sessionId}/history`,
      { token: stack.token },
    )
    expect(history.body.data).toMatchObject({ cursor: 2, has_more: false })
    expect(history.body.data.events.map((event) => event.type)).toEqual(['turn/start', 'user/message'])

    const renamed = await api<{ title: string }>(stack.baseUrl, `/sessions/${sessionId}`, {
      method: 'PATCH',
      token: stack.token,
      body: { title: '契约会话（改名）' },
    })
    expect(renamed.body.data.title).toBe('契约会话（改名）')
  })

  it('平台列表里的会话状态是 ready', async () => {
    const list = await api<{ items: Array<{ id: string; create_state: string }> }>(
      stack.baseUrl,
      `/sessions?workspaceId=${workspaceId}`,
      { token: stack.token },
    )
    expect(list.body.data.items).toEqual([
      expect.objectContaining({ id: sessionId, create_state: 'ready' }),
    ])
    expect(stack.gateway.sessions.get(sessionId)).toMatchObject({ cwd: guestRoot })
  })
})
