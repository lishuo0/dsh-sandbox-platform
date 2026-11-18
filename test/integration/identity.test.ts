import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

let platform: TestPlatform
let admin: string

beforeAll(async () => {
  platform = await startTestPlatform()
  admin = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
})

afterAll(async () => {
  await platform.close()
})

describe('健康检查与登录', () => {
  it('GET /health 公开可读', async () => {
    const response = await api(platform.baseUrl, '/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  it('正确口令登录返回令牌与角色', async () => {
    const response = await api<{ accessToken: string; userId: string; role: string }>(platform.baseUrl, '/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin-password-123' },
    })
    expect(response.status).toBe(200)
    expect(response.body.code).toBe(0)
    expect(response.body.data).toMatchObject({ userId: 'admin', role: 'admin', tokenType: 'bearer' })
    expect(response.body.data.accessToken).toEqual(expect.any(String))
  })

  it('错误口令 401 且不泄露原因', async () => {
    const response = await api(platform.baseUrl, '/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'wrong-password' },
    })
    expect(response.status).toBe(401)
    expect(response.body.msg).toBe('unauthorized')
  })

  it('不存在的用户同样 401', async () => {
    const response = await api(platform.baseUrl, '/auth/login', {
      method: 'POST',
      body: { username: 'nobody', password: 'whatever-long' },
    })
    expect(response.status).toBe(401)
  })

  it('受保护路由缺令牌 401', async () => {
    const response = await api(platform.baseUrl, '/auth/me')
    expect(response.status).toBe(401)
  })

  it('伪造令牌 401', async () => {
    const response = await api(platform.baseUrl, '/auth/me', { token: 'a.b.c' })
    expect(response.status).toBe(401)
  })
})

describe('账号管理', () => {
  let bobToken = ''

  it('管理员查看 / 创建 / 修改成员', async () => {
    const mine = await api<{ userId: string; displayName: string; role: string }>(platform.baseUrl, '/auth/me', {
      token: admin,
    })
    expect(mine.body.data).toMatchObject({ userId: 'admin', role: 'admin' })

    const created = await api<{ member: { id: string; role: string; mustChangePassword: boolean }; initialPassword?: string }>(
      platform.baseUrl,
      '/admin/users',
      {
        method: 'POST',
        token: admin,
        body: { username: 'alice', displayName: '爱丽丝', password: 'alice-password-123', role: 'member' },
      },
    )
    expect(created.status).toBe(201)
    expect(created.body.data.member).toMatchObject({
      id: 'alice',
      displayName: '爱丽丝',
      role: 'member',
      mustChangePassword: true,
    })
    // 管理员指定了初始口令就不再回传；成员首次登录要自己改。
    expect(created.body.data.initialPassword).toBeUndefined()

    const list = await api<Array<{ id: string }>>(platform.baseUrl, '/admin/users', { token: admin })
    expect(list.body.data.map((member) => member.id)).toContain('alice')

    const patched = await api(platform.baseUrl, '/admin/users/alice', {
      method: 'PATCH',
      token: admin,
      body: { displayName: 'Alice', role: 'admin' },
    })
    expect(patched.status).toBe(200)

    const alice = await login(platform.baseUrl, 'alice', 'alice-password-123')
    const me = await api<{ displayName: string; role: string }>(platform.baseUrl, '/auth/me', { token: alice })
    expect(me.body.data).toMatchObject({ displayName: 'Alice', role: 'admin' })
  })

  it('普通成员访问管理接口 403', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token: admin,
      body: { username: 'bob', password: 'bob-password-1234' },
    })
    bobToken = await login(platform.baseUrl, 'bob', 'bob-password-1234')
    const response = await api(platform.baseUrl, '/admin/users', { token: bobToken })
    expect(response.status).toBe(403)
  })

  it('重复用户名 409、口令过短 422、非法角色/状态 422', async () => {
    const duplicate = await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token: admin,
      body: { username: 'alice', password: 'alice-password-123' },
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.msg).toBe('username-taken')

    const short = await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token: admin,
      body: { username: 'carol', password: 'short' },
    })
    expect(short.status).toBe(422)

    const badRole = await api(platform.baseUrl, '/admin/users/bob', {
      method: 'PATCH',
      token: admin,
      body: { role: 'superuser' },
    })
    expect(badRole.status).toBe(422)
    expect(badRole.body.msg).toBe('invalid-role')

    const badStatus = await api(platform.baseUrl, '/admin/users/bob', {
      method: 'PATCH',
      token: admin,
      body: { status: 'deleted' },
    })
    expect(badStatus.status).toBe(422)
    expect(badStatus.body.msg).toBe('invalid-status')
  })

  it('不能停用最后一个管理员（先被自我保护挡住）', async () => {
    // alice 也被提升成管理员了，先降回成员，只剩 admin。
    await api(platform.baseUrl, '/admin/users/alice', { method: 'PATCH', token: admin, body: { role: 'member' } })
    const response = await api(platform.baseUrl, '/admin/users/admin', {
      method: 'PATCH',
      token: admin,
      body: { status: 'disabled' },
    })
    // 自己是当前操作者：先命中「不能停用自己」；last-admin 由服务层单测覆盖。
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('cannot-disable-self')
  })

  it('停用后旧令牌失效', async () => {
    // bob 已在上一用例拿到令牌；管理员停用它。
    await api(platform.baseUrl, '/admin/users/bob', { method: 'PATCH', token: admin, body: { status: 'disabled' } })
    const response = await api(platform.baseUrl, '/auth/me', { token: bobToken })
    expect(response.status).toBe(401)
  })
})
