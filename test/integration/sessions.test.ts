import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API, api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.js'

/**
 * 这一组不接脑：用的 baseUrl 指向一个不可达端口。
 * 目的不是测投递成功，而是测平台在脑不可用时的降级与不变量。
 */
let platform: TestPlatform
let token: string
let workspaceId: string
let sessionId: string

beforeAll(async () => {
  // 事件历史表在脑的 schema 里，平台回退读它，所以两套 schema 都装上。
  const database: TestDatabase = await createTestDatabase(['platform', 'brain'])
  platform = await startTestPlatform({ database })
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  await api(platform.baseUrl, '/settings/model', {
    method: 'POST',
    token,
    body: {
      baseUrl: 'https://llm.test/v1',
      apiKey: 'sk-test-0123456789',
      modelIds: ['deepseek-chat'],
      defaultModel: 'deepseek-chat',
    },
  })
  const workspace = await api<{ id: string }>(platform.baseUrl, '/workspaces', {
    method: 'POST',
    token,
    body: { name: '会话用工作区' },
  })
  workspaceId = workspace.body.data.id
})

afterAll(async () => {
  await platform.close()
})

describe('会话（脑不可用时的降级）', () => {
  it('没配模型不能开会话', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'frank', password: 'frank-password-1234' },
    })
    const frank = await login(platform.baseUrl, 'frank', 'frank-password-1234')
    const workspace = await api<{ id: string }>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token: frank,
      body: { name: 'frank 的工作区' },
    })
    const response = await api(platform.baseUrl, '/sessions', {
      method: 'POST',
      token: frank,
      body: { workspaceId: workspace.body.data.id },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('model-config-required')
  })

  it('工作区不属于自己 404', async () => {
    const response = await api(platform.baseUrl, '/sessions', {
      method: 'POST',
      token,
      body: { workspaceId: 'ws_missing' },
    })
    expect(response.status).toBe(404)
    expect(response.body.msg).toBe('workspace-not-found')
  })

  it('没带工作区就落到成员的默认工作区', async () => {
    const response = await api<{ id: string; createState: string }>(platform.baseUrl, '/sessions', {
      method: 'POST',
      token,
      body: { title: '默认块会话' },
    })
    // 脑不可达仍是 502，但会话已经落库。
    expect(response.status).toBe(502)
    const rows = await platform.db.query<{ workspace_id: string; name: string; is_default: unknown }>(
      `SELECT s.workspace_id, w.name, w.is_default
         FROM dsh_sessions s JOIN dsh_workspaces w ON w.id = s.workspace_id
        WHERE s.id = $1`,
      [response.body.data.id],
    )
    expect(rows.rows[0]?.name).toBe('默认工作区')
    expect(Number(rows.rows[0]?.is_default)).toBe(1)
  })

  it('开会话时脑不可达：落库、记为 unknown、返回 502', async () => {
    const response = await api<{ id: string; createState: string }>(platform.baseUrl, '/sessions', {
      method: 'POST',
      token,
      body: { workspaceId, title: '第一次会话' },
    })
    expect(response.status).toBe(502)
    expect(response.body.msg).toBe('unknown')
    expect(response.body.data.createState).toBe('unknown')
    sessionId = response.body.data.id
    expect(sessionId).toMatch(/^s_[0-9a-f]+$/)

    const row = await platform.db.query(`SELECT state FROM dsh_platform_session_ops WHERE session_id = $1`, [sessionId])
    expect(row.rows[0].state).toBe('unknown')
  })

  it('列表按工作区过滤，并带出参考平台的派生字段', async () => {
    const response = await api<{ items: Array<Record<string, unknown>>; next_cursor: string }>(
      platform.baseUrl,
      `/sessions?workspaceId=${workspaceId}`,
      { token },
    )
    expect(response.body.data.items).toEqual([
      expect.objectContaining({
        id: sessionId,
        workspace_id: workspaceId,
        create_state: 'unknown',
        title: '第一次会话',
        blank: true,
        running: false,
      }),
    ])
    expect(response.body.data.next_cursor).toBe('')

    const other = await api<{ items: unknown[] }>(platform.baseUrl, '/sessions?workspaceId=ws_missing', { token })
    expect(other.body.data.items).toEqual([])
  })

  it('同一 requestId 同内容重复投递按幂等返回，换内容 409', async () => {
    const body = { text: '你好', requestId: 'req-fixed-1' }
    const first = await api(platform.baseUrl, `/sessions/${sessionId}/messages`, { method: 'POST', token, body })
    expect(first.status).toBe(502)

    const again = await api(platform.baseUrl, `/sessions/${sessionId}/messages`, { method: 'POST', token, body })
    expect(again.status).toBe(502)

    const conflict = await api(platform.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token,
      body: { text: '换一句', requestId: 'req-fixed-1' },
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body.msg).toBe('conflict')
  })

  it('空文本且无附件 422', async () => {
    const response = await api(platform.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token,
      body: { text: '   ' },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('invalid-text')
  })

  it('停用的会话不能再投递', async () => {
    await platform.db.query(`UPDATE dsh_sessions SET status = 'archived' WHERE id = $1`, [sessionId])
    const response = await api(platform.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token,
      body: { text: '还在吗' },
    })
    expect(response.status).toBe(409)
    expect(response.body.msg).toBe('session-inactive')
    await platform.db.query(`UPDATE dsh_sessions SET status = 'active' WHERE id = $1`, [sessionId])
  })

  it('切换模型 / 取消都要经过脑，脑不可达返回 502', async () => {
    const switched = await api(platform.baseUrl, `/sessions/${sessionId}/model`, {
      method: 'POST',
      token,
      body: { modelId: 'deepseek-chat' },
    })
    expect(switched.status).toBe(502)

    const cancelled = await api(platform.baseUrl, `/sessions/${sessionId}/cancel`, { method: 'POST', token })
    expect(cancelled.status).toBe(502)
  })

  it('事件流回退到数据库历史', async () => {
    await platform.db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event)
       VALUES ($1, 0, '{"type":"user","data":{"text":"历史一"}}'::jsonb),
              ($1, 1, '{"type":"assistant","data":{"text":"历史二"}}'::jsonb)`,
      [sessionId],
    )
    const response = await fetch(`${platform.baseUrl}${API}/sessions/${sessionId}/events?after=-1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('event: snapshot')
    // 历史行的 type 会透传；seq 在两种方言下都归一成数字。
    expect(text).toContain('"seq":0,"type":"user"')
    expect(text).toContain('"seq":1,"type":"assistant"')
    expect(text).toContain('"replayed":2')
    expect(text).toContain('"live":false')
  })

  it('非法 after 400', async () => {
    const response = await api(platform.baseUrl, `/sessions/${sessionId}/events?after=abc`, { token })
    expect(response.status).toBe(400)
    expect(response.body.msg).toBe('invalid-after')
  })

  it('会话不属于自己 404', async () => {
    const frank = await login(platform.baseUrl, 'frank', 'frank-password-1234')
    const response = await api(platform.baseUrl, `/sessions/${sessionId}/cancel`, { method: 'POST', token: frank })
    expect(response.status).toBe(404)
  })

  it('工作区归档后恢复会话 409', async () => {
    await api(platform.baseUrl, `/workspaces/${workspaceId}`, { method: 'PATCH', token, body: { archived: true } })
    const response = await api(platform.baseUrl, `/sessions/${sessionId}/resume`, { method: 'POST', token, body: {} })
    expect(response.status).toBe(409)
    expect(response.body.msg).toBe('workspace-archived')
    await api(platform.baseUrl, `/workspaces/${workspaceId}`, { method: 'PATCH', token, body: { archived: false } })
  })

  it('管理员看沙箱列表：空表返回空分页', async () => {
    const response = await api<{ items: unknown[]; total: number; page: number; page_size: number }>(
      platform.baseUrl,
      '/admin/sandboxes',
      { token },
    )
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ items: [], total: 0, page: 1, page_size: 20 })
  })
})

describe('会话视图、改名归档与有界历史', () => {
  let userId: string

  beforeAll(async () => {
    const rows = await platform.db.query<{ user_id: string }>(`SELECT user_id FROM dsh_sessions WHERE id = $1`, [sessionId])
    userId = rows.rows[0]!.user_id
  })

  async function seedSession(id: string, title: string, at: string) {
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id, last_active_at)
       VALUES ($1, $2, $3, $4, 'platform', $5)`,
      [id, userId, workspaceId, title, at],
    )
    await platform.db.query(
      `INSERT INTO dsh_platform_session_ops (session_id, user_id, state, error_code) VALUES ($1, $2, 'ready', NULL)`,
      [id, userId],
    )
  }

  async function seedEvent(id: string, seq: number, event: unknown) {
    await platform.db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`, [
      id,
      seq,
      JSON.stringify(event),
    ])
  }

  it('GET /sessions/:id 带出脑事件的派生字段', async () => {
    await seedSession('s_view', '', '2026-02-01T00:00:00.000Z')
    await seedEvent('s_view', 1, { type: 'session/title', time: 1000, data: { title: '脑标题' } })
    await seedEvent('s_view', 2, { type: 'turn/start', time: 2000, data: {} })
    await seedEvent('s_view', 3, {
      type: 'user/message',
      time: 3000,
      data: { text: '你好', source: { kind: 'user' } },
    })

    const response = await api<Record<string, unknown>>(platform.baseUrl, '/sessions/s_view', { token })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      id: 's_view',
      workspace_id: workspaceId,
      title: '脑标题',
      create_state: 'ready',
      blank: false,
      running: true,
      last_prompt_at: new Date(3000).toISOString(),
    })

    const missing = await api(platform.baseUrl, '/sessions/s_missing', { token })
    expect(missing.status).toBe(404)

    const frank = await login(platform.baseUrl, 'frank', 'frank-password-1234')
    const foreign = await api(platform.baseUrl, '/sessions/s_view', { token: frank })
    expect(foreign.status).toBe(404)
  })

  it('PATCH /sessions/:id 改名与归档', async () => {
    await seedSession('s_patch', '旧名', '2026-02-02T00:00:00.000Z')

    const renamed = await api<{ title: string; status: string }>(platform.baseUrl, '/sessions/s_patch', {
      method: 'PATCH',
      token,
      body: { title: '新名' },
    })
    expect(renamed.status).toBe(200)
    expect(renamed.body.data.title).toBe('新名')

    const archived = await api<{ status: string }>(platform.baseUrl, '/sessions/s_patch', {
      method: 'PATCH',
      token,
      body: { archived: true },
    })
    expect(archived.status).toBe(200)
    expect(archived.body.data.status).toBe('archived')

    const empty = await api(platform.baseUrl, '/sessions/s_patch', { method: 'PATCH', token, body: {} })
    expect(empty.status).toBe(422)
    expect(empty.body.msg).toBe('nothing-to-update')
  })

  it('归档并要求停止时，脑不可达就不归档', async () => {
    await seedSession('s_stop', '跑着的', '2026-02-03T00:00:00.000Z')
    const response = await api(platform.baseUrl, '/sessions/s_stop', {
      method: 'PATCH',
      token,
      body: { archived: true, stopActivity: true },
    })
    expect(response.status).toBe(502)
    const view = await api<{ status: string }>(platform.baseUrl, '/sessions/s_stop', { token })
    expect(view.body.data.status).toBe('active')
  })

  it('GET /sessions/:id/history 分页', async () => {
    await seedSession('s_hist', '历史', '2026-02-04T00:00:00.000Z')
    for (const [seq, type] of [
      [1, 'turn/start'],
      [2, 'user/message'],
      [3, 'assistant/message'],
      [4, 'turn/end'],
      [5, 'turn/start'],
      [6, 'user/message'],
    ] as const) {
      await seedEvent('s_hist', seq, { type, time: seq * 1000, data: {} })
    }

    const newest = await api<{
      events: Array<{ seq: number; type: string }>
      cursor: number
      before: number
      next_before?: number
      has_more: boolean
    }>(platform.baseUrl, '/sessions/s_hist/history?limit=3', { token })
    expect(newest.status).toBe(200)
    expect(newest.body.data.events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(newest.body.data).toMatchObject({ cursor: 6, before: 7, next_before: 4, has_more: true })

    const older = await api<{ events: Array<{ seq: number }>; has_more: boolean }>(
      platform.baseUrl,
      `/sessions/s_hist/history?limit=3&before=${newest.body.data.next_before}`,
      { token },
    )
    expect(older.body.data.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(older.body.data.has_more).toBe(false)

    const delta = await api<{ events: Array<{ seq: number }>; after: number; before: number }>(
      platform.baseUrl,
      '/sessions/s_hist/history?after=3',
      { token },
    )
    expect(delta.body.data.events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(delta.body.data).toMatchObject({ after: 3, before: -1 })

    const conflict = await api(platform.baseUrl, '/sessions/s_hist/history?after=1&before=3', { token })
    expect(conflict.status).toBe(400)
    expect(conflict.body.msg).toBe('after-before-exclusive')

    const missing = await api(platform.baseUrl, '/sessions/s_missing/history', { token })
    expect(missing.status).toBe(404)
  })

  it('列表支持 limit + cursor 翻页', async () => {
    const first = await api<{ items: Array<{ id: string }>; next_cursor: string }>(
      platform.baseUrl,
      `/sessions?workspaceId=${workspaceId}&limit=1`,
      { token },
    )
    expect(first.status).toBe(200)
    expect(first.body.data.items).toHaveLength(1)
    expect(first.body.data.next_cursor).not.toBe('')

    const second = await api<{ items: Array<{ id: string }> }>(
      platform.baseUrl,
      `/sessions?workspaceId=${workspaceId}&limit=1&cursor=${encodeURIComponent(first.body.data.next_cursor)}`,
      { token },
    )
    expect(second.body.data.items[0]!.id).not.toBe(first.body.data.items[0]!.id)

    const bad = await api(platform.baseUrl, `/sessions?cursor=bad`, { token })
    expect(bad.status).toBe(400)
    expect(bad.body.msg).toBe('invalid-cursor')
  })
})
