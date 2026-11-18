import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 管理员控制台的账号生命周期，走真实 HTTP：
 *
 * 开户（服务端生成初始口令）→ 登录拿到临时口令 → 数据面被强制改密挡住 →
 * 改密后放行 → 管理员重置口令 / 改角色 / 停用，全部立即生效。
 */

let platform: TestPlatform
let adminToken = ''
let adminId = ''

interface MemberView {
  id: string
  displayName: string
  role: 'admin' | 'member'
  status: string
  mustChangePassword: boolean
  createdAt: string
}

interface LoginView {
  userId: string
  role: 'admin' | 'member'
  mustChangePassword: boolean
  accessToken: string
}

beforeAll(async () => {
  platform = await startTestPlatform()
  const response = await api<LoginView>(platform.baseUrl, '/auth/login', {
    method: 'POST',
    body: {
      username: platform.config.auth.adminUsername,
      password: platform.config.auth.adminPassword,
    },
  })
  adminToken = response.body.data.accessToken
  adminId = response.body.data.userId
})

afterAll(async () => {
  await platform.close()
})

/** 直接登录，不替用户改密（helper 的 login 会自动改，断言不到门禁）。 */
async function rawLogin(username: string, password: string): Promise<{ status: number; data: LoginView }> {
  const response = await api<LoginView>(platform.baseUrl, '/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  return { status: response.status, data: response.body.data }
}

describe('管理员开户', () => {
  let ivyId = ''
  let initialPassword = ''

  it('不填密码时服务端生成一次性初始口令，并要求首次改密', async () => {
    const response = await api<{ member: MemberView; initialPassword?: string }>(
      platform.baseUrl,
      '/admin/users',
      { method: 'POST', token: adminToken, body: { username: 'ivy', displayName: '常春藤' } },
    )
    expect(response.status).toBe(201)
    expect(response.body.data.member).toMatchObject({
      id: 'ivy',
      displayName: '常春藤',
      role: 'member',
      status: 'active',
      mustChangePassword: true,
    })
    expect(response.body.data.initialPassword).toMatch(/^[A-Za-z0-9_-]{16}$/)
    ivyId = response.body.data.member.id
    initialPassword = response.body.data.initialPassword!
  })

  it('成员列表只有管理员能看，且能看到强制改密标记', async () => {
    const response = await api<MemberView[]>(platform.baseUrl, '/admin/users', { token: adminToken })
    expect(response.status).toBe(200)
    expect(response.body.data.find((member) => member.id === 'ivy')).toMatchObject({
      displayName: '常春藤',
      mustChangePassword: true,
    })

    const denied = await api(platform.baseUrl, '/admin/users', {
      token: (await rawLogin('ivy', initialPassword)).data.accessToken,
    })
    expect(denied.status).toBe(403)
    expect(denied.body.msg).toBe('forbidden')
  })

  it('临时口令只能换密码：其他成员数据面一律 403', async () => {
    const signedIn = await rawLogin('ivy', initialPassword)
    expect(signedIn.status).toBe(200)
    expect(signedIn.data.mustChangePassword).toBe(true)
    expect(signedIn.data.userId).toBe(ivyId)

    const workspaces = await api(platform.baseUrl, '/workspaces', { token: signedIn.data.accessToken })
    expect(workspaces.status).toBe(403)
    expect(workspaces.body.msg).toBe('must-change-password')

    // 看自己和改密码必须放行，否则成员解不开。
    const me = await api<{ mustChangePassword: boolean }>(platform.baseUrl, '/auth/me', {
      token: signedIn.data.accessToken,
    })
    expect(me.status).toBe(200)
    expect(me.body.data.mustChangePassword).toBe(true)
  })

  it('改密要校验旧密码和长度，成功后数据面立即放行', async () => {
    const signedIn = await rawLogin('ivy', initialPassword)
    const token = signedIn.data.accessToken

    const wrong = await api(platform.baseUrl, '/me/password', {
      method: 'PATCH',
      token,
      body: { currentPassword: 'not-the-password', newPassword: 'ivy-password-5678' },
    })
    expect(wrong.status).toBe(401)
    expect(wrong.body.msg).toBe('invalid-password')

    const short = await api(platform.baseUrl, '/me/password', {
      method: 'PATCH',
      token,
      body: { currentPassword: initialPassword, newPassword: 'short' },
    })
    expect(short.status).toBe(422)
    expect(short.body.msg).toBe('password-too-short')

    const changed = await api(platform.baseUrl, '/me/password', {
      method: 'PATCH',
      token,
      body: { currentPassword: initialPassword, newPassword: 'ivy-password-5678' },
    })
    expect(changed.status).toBe(200)

    const workspaces = await api(platform.baseUrl, '/workspaces', { token })
    expect(workspaces.status).toBe(200)
    const me = await api<{ mustChangePassword: boolean }>(platform.baseUrl, '/auth/me', { token })
    expect(me.body.data.mustChangePassword).toBe(false)
    // 旧临时口令已经失效。
    expect((await rawLogin('ivy', initialPassword)).status).toBe(401)
  })

  it('管理员重置密码：新口令只回一次，旧密码立刻失效', async () => {
    const reset = await api<{ initialPassword: string }>(
      platform.baseUrl,
      `/admin/users/${ivyId}/password`,
      { method: 'POST', token: adminToken, body: {} },
    )
    expect(reset.status).toBe(200)
    expect(reset.body.data.initialPassword).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect((await rawLogin('ivy', 'ivy-password-5678')).status).toBe(401)

    const signedIn = await rawLogin('ivy', reset.body.data.initialPassword)
    expect(signedIn.status).toBe(200)
    expect(signedIn.data.mustChangePassword).toBe(true)
  })

  it('管理员改角色和显示名，改动立即反映到列表', async () => {
    const role = await api<MemberView>(platform.baseUrl, `/admin/users/${ivyId}/role`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'admin' },
    })
    expect(role.status).toBe(200)
    expect(role.body.data.role).toBe('admin')

    const patched = await api(platform.baseUrl, `/admin/users/${ivyId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { displayName: '常春藤（管理员）', role: 'member' },
    })
    expect(patched.status).toBe(200)
    const list = await api<MemberView[]>(platform.baseUrl, '/admin/users', { token: adminToken })
    expect(list.body.data.find((member) => member.id === 'ivy')).toMatchObject({
      displayName: '常春藤（管理员）',
      role: 'member',
      mustChangePassword: true,
    })
  })

  it('停用成员后其 token 立即失效，启用后恢复', async () => {
    const password = (await api<{ initialPassword: string }>(
      platform.baseUrl,
      `/admin/users/${ivyId}/password`,
      { method: 'POST', token: adminToken, body: { password: 'ivy-password-9999' } },
    )).body.data.initialPassword
    await api(platform.baseUrl, '/me/password', {
      method: 'PATCH',
      token: (await rawLogin('ivy', password)).data.accessToken,
      body: { currentPassword: password, newPassword: 'ivy-password-9998' },
    })
    const token = (await rawLogin('ivy', 'ivy-password-9998')).data.accessToken
    expect((await api(platform.baseUrl, '/auth/me', { token })).status).toBe(200)

    const disabled = await api(platform.baseUrl, `/admin/users/${ivyId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'disabled' },
    })
    expect(disabled.status).toBe(200)
    expect((await api(platform.baseUrl, '/auth/me', { token })).status).toBe(401)
    expect((await rawLogin('ivy', 'ivy-password-9998')).status).toBe(401)

    await api(platform.baseUrl, `/admin/users/${ivyId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'active' },
    })
    expect((await api(platform.baseUrl, '/auth/me', { token })).status).toBe(200)
  })

  it('管理员不能停用自己，也不能取消自己的管理员角色', async () => {
    const disable = await api(platform.baseUrl, `/admin/users/${adminId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'disabled' },
    })
    expect(disable.status).toBe(422)
    expect(disable.body.msg).toBe('cannot-disable-self')

    const demote = await api(platform.baseUrl, `/admin/users/${adminId}/role`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'member' },
    })
    expect(demote.status).toBe(422)
    expect(demote.body.msg).toBe('cannot-demote-self')
  })

  it('重复登录名 409，非法角色和状态 422', async () => {
    const duplicate = await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'ivy', password: 'another-password-1234' },
    })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.msg).toBe('username-taken')

    const badRole = await api(platform.baseUrl, `/admin/users/${ivyId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { role: 'superuser' },
    })
    expect(badRole.status).toBe(422)
    expect(badRole.body.msg).toBe('invalid-role')

    const badStatus = await api(platform.baseUrl, `/admin/users/${ivyId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'paused' },
    })
    expect(badStatus.status).toBe(422)
    expect(badStatus.body.msg).toBe('invalid-status')
  })

  it('普通成员无权开户', async () => {
    const password = 'ivy-password-9998'
    const token = (await rawLogin('ivy', password)).data.accessToken
    const response = await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'mallory', password: 'mallory-password-1234' },
    })
    expect(response.status).toBe(403)
  })
})
