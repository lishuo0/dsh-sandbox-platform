import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 会话内容搜索、成员身份、定时任务清单和管理员排障接口。
 *
 * 搜索和定时任务都只看当前成员自己的会话；管理员接口要额外过角色校验，
 * 并且仍然按租户收口——管理员也不能取消别人的会话。
 */

let stack: JointStack
let ivyToken = ''
let sessionId = ''
let ivySessionId = ''

async function createSession(token: string, title: string): Promise<string> {
  const response = await api<{ id: string; createState: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token,
    body: { title },
  })
  if (response.body.data.createState !== 'ready') throw new Error(`开会话失败: ${response.status} ${response.text}`)
  return response.body.data.id
}

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token)
  sessionId = await createSession(stack.token, '管理员会话')

  await api(stack.baseUrl, '/admin/users', {
    method: 'POST',
    token: stack.token,
    body: { username: 'ivy', password: 'ivy-password-1234' },
  })
  ivyToken = await login(stack.baseUrl, 'ivy', 'ivy-password-1234')
  await configureModel(stack.baseUrl, ivyToken)
  ivySessionId = await createSession(ivyToken, '别人的会话')

  await stack.db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, 1, $2)`, [
    sessionId,
    JSON.stringify({
      type: 'user/message',
      data: { message: { content: [{ type: 'text', text: '帮我排查沙箱注册表的问题' }] } },
    }),
  ])
  await stack.db.query(`INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, 1, $2)`, [
    ivySessionId,
    JSON.stringify({ type: 'user/message', data: { text: '别人的沙箱注册表问题' } }),
  ])
})

afterAll(async () => {
  await stack.close()
})

interface SearchHit {
  session_id: string
  snippet: string
}

interface SearchResult {
  items: SearchHit[]
  has_more: boolean
}

describe('GET /me', () => {
  it('回当前成员的 id 和显示名', async () => {
    const response = await api<{ user_id: string; display_name: string }>(stack.baseUrl, '/me', { token: stack.token })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ user_id: stack.userId, display_name: stack.userId })
  })

  it('未登录 401，且普通成员不会看到角色字段', async () => {
    expect((await api(stack.baseUrl, '/me')).status).toBe(401)
    const member = await api<Record<string, unknown>>(stack.baseUrl, '/me', { token: ivyToken })
    expect(member.body.data).toEqual({ user_id: 'ivy', display_name: 'ivy' })
  })
})

describe('GET /search/sessions', () => {
  it('搜到自己的消息，摘要带命中上下文', async () => {
    const response = await api<SearchResult>(stack.baseUrl, '/search/sessions?q=沙箱注册表', { token: stack.token })
    expect(response.status).toBe(200)
    expect(response.body.data.items).toEqual([
      expect.objectContaining({ session_id: sessionId, snippet: expect.stringContaining('沙箱注册表') }),
    ])
    expect(response.body.data.has_more).toBe(false)
  })

  it('query 是 q 的兼容别名', async () => {
    const response = await api<SearchResult>(stack.baseUrl, '/search/sessions?query=沙箱注册表', { token: stack.token })
    expect(response.body.data.items.map((hit) => hit.session_id)).toEqual([sessionId])
  })

  it('空查询回空数组，不返回全部会话', async () => {
    const response = await api<SearchResult>(stack.baseUrl, '/search/sessions?q=', { token: stack.token })
    expect(response.body.data).toEqual({ items: [], has_more: false })
  })

  it('搜不到别人的会话', async () => {
    const response = await api<SearchResult>(stack.baseUrl, '/search/sessions?q=沙箱注册表', { token: ivyToken })
    expect(response.body.data.items.map((hit) => hit.session_id)).toEqual([ivySessionId])
  })

  it('超长查询 400', async () => {
    const response = await api(stack.baseUrl, `/search/sessions?q=${'x'.repeat(501)}`, { token: stack.token })
    expect(response.status).toBe(400)
    expect(response.body.msg).toBe('invalid request')
  })
})

interface ScheduleItem {
  id: string
  session_id: string
  session_title: string
  title: string
  prompt: string
  kind: string
  rule: Record<string, unknown>
  status: string
  next_run_at: string
  last_delivery?: string
  generation: number
}

describe('GET /schedules', () => {
  async function addTask(
    id: string,
    targetSession: string,
    status: string,
    at: string,
    delivery = '',
  ): Promise<void> {
    await stack.db.query(
      `INSERT INTO dsh_schedule_tasks (
         id, session_id, title, prompt, kind, rule, status, desired_at, next_run_at, last_delivery
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
      [id, targetSession, '喝水', '去喝一杯水', 'every', '{"everySeconds":300}', status, at, delivery || null],
    )
  }

  beforeAll(async () => {
    await addTask('sch_own_active', sessionId, 'active', '2026-03-01T00:00:00Z')
    await addTask('sch_own_done', sessionId, 'inactive', '2026-02-01T00:00:00Z', 'accepted')
    await addTask('sch_foreign', ivySessionId, 'active', '2026-02-15T00:00:00Z')
  })

  it('只列自己的任务，active 排前面，rule 解析成对象', async () => {
    const response = await api<{ items: ScheduleItem[] }>(stack.baseUrl, '/schedules', { token: stack.token })
    expect(response.status).toBe(200)
    const items = response.body.data.items
    expect(items.map((item) => item.id)).toEqual(['sch_own_active', 'sch_own_done'])
    expect(items[0]).toMatchObject({
      session_id: sessionId,
      session_title: '管理员会话',
      title: '喝水',
      prompt: '去喝一杯水',
      kind: 'every',
      rule: { everySeconds: 300 },
      status: 'active',
      generation: 1,
    })
    expect(items[1]?.last_delivery).toBe('accepted')
    expect(items[0]).not.toHaveProperty('last_delivery')
  })

  it('别人的任务看不到', async () => {
    const response = await api<{ items: ScheduleItem[] }>(stack.baseUrl, '/schedules', { token: ivyToken })
    expect(response.body.data.items.map((item) => item.id)).toEqual(['sch_foreign'])
  })
})

describe('PATCH /admin/users/:id/role', () => {
  it('升成管理员后新请求立即生效', async () => {
    const promoted = await api<{ id: string; role: string }>(stack.baseUrl, '/admin/users/ivy/role', {
      method: 'PATCH',
      token: stack.token,
      body: { role: 'admin' },
    })
    expect(promoted.status).toBe(200)
    expect(promoted.body.data).toMatchObject({ id: 'ivy', role: 'admin' })

    const me = await api<{ role: string }>(stack.baseUrl, '/auth/me', { token: ivyToken })
    expect(me.body.data.role).toBe('admin')

    const demoted = await api<{ role: string }>(stack.baseUrl, '/admin/users/ivy/role', {
      method: 'PATCH',
      token: stack.token,
      body: { role: 'member' },
    })
    expect(demoted.body.data.role).toBe('member')
  })

  it('非法角色 422，缺字段也 422', async () => {
    for (const body of [{ role: 'superuser' }, { role: 123 }, {}]) {
      const response = await api(stack.baseUrl, '/admin/users/ivy/role', {
        method: 'PATCH',
        token: stack.token,
        body,
      })
      expect(response.status).toBe(422)
      expect(response.body.msg).toBe('invalid-role')
    }
  })

  it('不能取消自己的管理员角色', async () => {
    const response = await api(stack.baseUrl, '/admin/users/admin/role', {
      method: 'PATCH',
      token: stack.token,
      body: { role: 'member' },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('cannot-demote-self')
  })

  it('用户不存在 404，普通成员调用 403', async () => {
    const missing = await api(stack.baseUrl, '/admin/users/ghost/role', {
      method: 'PATCH',
      token: stack.token,
      body: { role: 'member' },
    })
    expect(missing.status).toBe(404)

    const forbidden = await api(stack.baseUrl, '/admin/users/admin/role', {
      method: 'PATCH',
      token: ivyToken,
      body: { role: 'admin' },
    })
    expect(forbidden.status).toBe(403)
  })
})

describe('管理员不能绕过成员归属取消会话', () => {
  it('管理员别名路由已移除，全部按 404 处理', async () => {
    for (const token of [stack.token, ivyToken]) {
      const response = await api(stack.baseUrl, `/admin/sessions/${sessionId}/force-cancel`, {
        method: 'POST',
        token,
        body: { request_id: 'admin-force-1' },
      })
      expect(response.status).toBe(404)
    }
  })

  it('管理员走成员路由取消别人的会话也是 404，自己的会话正常 202', async () => {
    const foreign = await api(stack.baseUrl, `/sessions/${ivySessionId}/force-cancel`, {
      method: 'POST',
      token: stack.token,
      body: { request_id: 'admin-force-2' },
    })
    expect(foreign.status).toBe(404)

    const own = await api<{ forceClosed: boolean }>(stack.baseUrl, `/sessions/${sessionId}/force-cancel`, {
      method: 'POST',
      token: stack.token,
      body: { request_id: 'admin-force-3' },
    })
    expect(own.status).toBe(202)
    expect(own.body.data.forceClosed).toBe(true)
  })

  it('request_id 格式不对 400', async () => {
    const response = await api(stack.baseUrl, `/sessions/${sessionId}/force-cancel`, {
      method: 'POST',
      token: stack.token,
      body: { request_id: 'bad id!' },
    })
    expect(response.status).toBe(400)
    expect(response.body.msg).toBe('invalid-request-id')
  })
})
