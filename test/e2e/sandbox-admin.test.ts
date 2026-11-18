import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login } from '../helpers/app.js'
import { startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 管理员的沙箱排障面：`/admin/sandboxes` 读共享库里的 `dsh_sandboxes`。
 *
 * 这些行是脑侧的 E2B binding store 写下的（工作区 = 一块卷 = 一台沙箱），
 * 平台只读、只给管理员看归属，不碰会话内容。
 */

let stack: JointStack
let memberToken = ''

beforeAll(async () => {
  stack = await startJointStack()
  await api(stack.baseUrl, '/admin/users', {
    method: 'POST',
    token: stack.token,
    body: { username: 'ivy', password: 'ivy-password-1234' },
  })
  memberToken = await login(stack.baseUrl, 'ivy', 'ivy-password-1234')
})

afterAll(async () => {
  await stack.close()
})

interface SandboxPage {
  items: Array<Record<string, unknown>>
  total: number
  page: number
  page_size: number
}

describe('/admin/sandboxes', () => {
  it('空表返回空分页', async () => {
    const response = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes', { token: stack.token })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ items: [], total: 0, page: 1, page_size: 20 })
  })

  it('真实沙箱行按最近使用倒序透出归属', async () => {
    await stack.db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
       VALUES ('w_new', 'ivy', '新工作区', '/var/w_new', '/desk')`,
    )
    await stack.db.query(
      `INSERT INTO dsh_sandboxes (
         user_id, workspace_id, session_id, scope, sandbox_id, external_id,
         endpoint, workspace_root, state, expires_at, last_used_at
       ) VALUES
         ('ivy', 'w_old', 's_old', 'workspace', 'sbx-old', 'ext-old',
          'https://old.e2b.test', '/desk', 'ready', '2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z'),
         ('ivy', 'w_new', 's_new', 'workspace', 'sbx-new', 'ext-new',
          'https://new.e2b.test', '/desk', 'creating', '2026-03-02T00:00:00Z', '2026-02-01T00:00:00Z')`,
    )

    const response = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes', { token: stack.token })
    expect(response.status).toBe(200)
    expect(response.body.data.total).toBe(2)
    expect(response.body.data.items.map((row) => row.sandbox_id)).toEqual(['sbx-new', 'sbx-old'])
    expect(response.body.data.items[0]).toMatchObject({
      user_id: 'ivy',
      user_display_name: 'ivy',
      workspace_id: 'w_new',
      workspace_name: '新工作区',
      session_id: 's_new',
      scope: 'workspace',
      platform: 'e2b',
      state: 'creating',
      endpoint: 'https://new.e2b.test',
      // 平台不直连 E2B，实时状态标为未知。
      unknown: true,
    })
    // 排障面不带会话内容，也不带密钥类字段。
    expect(Object.keys(response.body.data.items[0] ?? {}).sort()).toEqual(
      [
        'endpoint',
        'expires_at',
        'last_used_at',
        'platform',
        'sandbox_id',
        'scope',
        'session_id',
        'state',
        'unknown',
        'user_display_name',
        'user_id',
        'workspace_id',
        'workspace_name',
      ],
    )
  })

  it('分页参数生效，page_size 上限 100，非法值回退默认', async () => {
    const second = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?page=2&page_size=1', { token: stack.token })
    expect(second.body.data).toMatchObject({ page: 2, page_size: 1, total: 2 })
    expect(second.body.data.items.map((row) => row.sandbox_id)).toEqual(['sbx-old'])

    const clamped = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?page_size=500', { token: stack.token })
    expect(clamped.body.data.page_size).toBe(100)
    expect(clamped.body.data.items).toHaveLength(2)

    const fallback = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?page=0&page_size=nope', { token: stack.token })
    expect(fallback.body.data).toMatchObject({ page: 1, page_size: 20 })
  })

  it('按登录名和状态筛选，总数跟着过滤条件走', async () => {
    const byUser = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?user_id=ivy', { token: stack.token })
    expect(byUser.body.data.total).toBe(2)

    const creating = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?state=creating', { token: stack.token })
    expect(creating.body.data.total).toBe(1)
    expect(creating.body.data.items.map((row) => row.sandbox_id)).toEqual(['sbx-new'])

    const combined = await api<SandboxPage>(
      stack.baseUrl,
      '/admin/sandboxes?user_id=ivy&state=creating',
      { token: stack.token },
    )
    expect(combined.body.data.total).toBe(1)

    const ghost = await api<SandboxPage>(stack.baseUrl, '/admin/sandboxes?user_id=ghost', { token: stack.token })
    expect(ghost.body.data).toEqual({ items: [], total: 0, page: 1, page_size: 20 })
  })

  it('普通成员无权查看 403', async () => {
    const response = await api(stack.baseUrl, '/admin/sandboxes', { token: memberToken })
    expect(response.status).toBe(403)
    expect(response.body.msg).toBe('forbidden')
  })
})
