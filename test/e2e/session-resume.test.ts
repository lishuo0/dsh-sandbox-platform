import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 会话恢复全链路：库里的冷会话 → POST /sessions/:id/resume
 * → BrainClient → 脑路由 create/adopt → MemoryGateway 重新登记。
 *
 * 恢复是平台唯一的「热起来」入口：脑不会自己拉起冷会话（防止跨租户唤醒），
 * 所以平台必须带上当前成员的模型和名单，由脑原地认领。
 */

let stack: JointStack
let workspaceId = ''
let sessionId = ''
let hankToken = ''

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token, { modelIds: ['deepseek-chat', 'deepseek-reasoner'] })
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '恢复工作区' },
  })
  workspaceId = workspace.body.data.id
  const created = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId, title: '待恢复' },
  })
  expect(created.status).toBe(201)
  sessionId = created.body.data.id

  await api(stack.baseUrl, '/admin/users', {
    method: 'POST',
    token: stack.token,
    body: { username: 'hank', password: 'hank-password-1234' },
  })
  hankToken = await login(stack.baseUrl, 'hank', 'hank-password-1234')
})

afterAll(async () => {
  await stack.close()
})

describe('会话恢复', () => {
  it('冷会话重新交给脑，带指定模型并登记可选模型', async () => {
    // 模拟副本重启：脑内存里没有这条会话了。
    stack.gateway.sessions.delete(sessionId)
    const registered = stack.gateway.registeredModels.length
    const selections = stack.gateway.modelSelections.length

    const resumed = await api<{ id: string; modelId: string }>(stack.baseUrl, `/sessions/${sessionId}/resume`, {
      method: 'POST',
      token: stack.token,
      body: { modelId: 'deepseek-reasoner' },
    })
    expect(resumed.status).toBe(200)
    expect(resumed.body.data).toEqual({ id: sessionId, modelId: 'deepseek-reasoner' })

    // 脑原地认领了同一条会话，cwd 仍是工作区客户机根。
    expect(stack.gateway.sessions.get(sessionId)).toMatchObject({ cwd: '/desk' })
    // 成员配置的模型名单随创建头下发，指定的模型装到会话上。
    expect(stack.gateway.registeredModels.length).toBe(registered + 1)
    expect(stack.gateway.registeredModels.at(-1)).toEqual({
      provider: 'user',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    })
    expect(stack.gateway.modelSelections.length).toBe(selections + 1)
    expect(stack.gateway.modelSelections.at(-1)).toMatchObject({ sessionId, model: 'deepseek-reasoner' })
  })

  it('恢复后可以继续投递消息', async () => {
    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { text: '继续吧', requestId: 'req-after-resume' },
    })
    expect(sent.status).toBe(202)
    expect(stack.gateway.prompts.at(-1)).toMatchObject({ sessionId, text: '继续吧', requestId: 'req-after-resume' })
  })

  it('不指定模型时用成员默认模型', async () => {
    const resumed = await api<{ id: string; modelId: string }>(stack.baseUrl, `/sessions/${sessionId}/resume`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(resumed.status).toBe(200)
    expect(resumed.body.data).toEqual({ id: sessionId, modelId: 'deepseek-chat' })
  })

  it('名单之外的模型按未配置处理 422', async () => {
    const resumed = await api(stack.baseUrl, `/sessions/${sessionId}/resume`, {
      method: 'POST',
      token: stack.token,
      body: { modelId: 'gpt-unknown' },
    })
    expect(resumed.status).toBe(422)
    expect(resumed.body.msg).toBe('model-config-required')
  })

  it('别人的会话恢复不了 404', async () => {
    const resumed = await api(stack.baseUrl, `/sessions/${sessionId}/resume`, {
      method: 'POST',
      token: hankToken,
      body: {},
    })
    expect(resumed.status).toBe(404)
    expect(resumed.body.msg).toBe('not-found')
  })

  it('成员没配模型的会话恢复 422', async () => {
    const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
      method: 'POST',
      token: hankToken,
      body: { name: 'hank 工作区' },
    })
    await stack.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id)
       VALUES ('s_hank_resume', 'hank', $1, 'hank 会话', 'platform')`,
      [workspace.body.data.id],
    )
    const resumed = await api(stack.baseUrl, '/sessions/s_hank_resume/resume', {
      method: 'POST',
      token: hankToken,
      body: {},
    })
    expect(resumed.status).toBe(422)
    expect(resumed.body.msg).toBe('model-config-required')
  })

  it('工作区归档后不能恢复 409', async () => {
    const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
      method: 'POST',
      token: stack.token,
      body: { name: '归档工作区' },
    })
    const created = await api<{ id: string }>(stack.baseUrl, '/sessions', {
      method: 'POST',
      token: stack.token,
      body: { workspaceId: workspace.body.data.id, title: '归档会话' },
    })
    expect(created.status).toBe(201)

    const archived = await api(stack.baseUrl, `/workspaces/${workspace.body.data.id}`, {
      method: 'PATCH',
      token: stack.token,
      body: { archived: true },
    })
    expect(archived.status).toBe(200)

    const resumed = await api(stack.baseUrl, `/sessions/${created.body.data.id}/resume`, {
      method: 'POST',
      token: stack.token,
      body: {},
    })
    expect(resumed.status).toBe(409)
    expect(resumed.body.msg).toBe('workspace-archived')
  })
})
