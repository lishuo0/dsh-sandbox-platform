import { describe, expect, it } from 'vitest'
import { accountDialog } from '../../src/client/account.js'
import { userBadge } from '../../src/client/user-badge.js'

/**
 * 密码弹窗：管理员开户 / 重置密码后首次登录强制改密，账号菜单也能随时打开。
 * 口令只发给平台 `PATCH /me/password`，不经过脑，也不落本地存储。
 */
describe('账号密码弹窗', () => {
  const html = accountDialog()

  it('有完整的三个口令输入和提交按钮', () => {
    expect(html).toContain('id="dsh-account-password"')
    expect(html).toContain('id="dsh-pwd-current"')
    expect(html).toContain('id="dsh-pwd-new"')
    expect(html).toContain('id="dsh-pwd-confirm"')
    expect(html).toContain('id="dsh-pwd-submit"')
    expect(html).toContain('id="dsh-pwd-cancel"')
  })

  it('只走平台接口，不经过脑', () => {
    expect(html).toContain('/dsh-api/platform/v1/me/password')
    expect(html).toContain('/dsh-api/platform/v1/auth/me')
    expect(html).not.toContain('/brain/')
    expect(html).not.toContain('localStorage')
    expect(html).not.toContain('sessionStorage')
  })

  it('首次登录强制弹窗：不能关，改完刷新页面', () => {
    expect(html).toContain('mustChangePassword === true')
    expect(html).toContain("open('forced')")
    expect(html).toContain('if (forced) return')
    expect(html).toContain('cancelButton.hidden = forced')
    expect(html).toContain('location.reload()')
  })

  it('账号菜单按需打开同一个弹窗', () => {
    expect(html).toContain('window.__dshAccountChangePassword')
    expect(html).toContain("open('optional')")
    expect(userBadge()).toContain('id="dsh-account-change-password"')
    expect(userBadge()).toContain('修改密码')
    expect(userBadge()).toContain('window.__dshAccountChangePassword')
  })

  it('头像菜单的「管理」入口只给管理员，打开设置页同款面板', () => {
    const badge = userBadge()
    expect(badge).toContain('id="dsh-account-admin"')
    expect(badge).toContain('管理')
    expect(badge).toContain("window.__dshConsoleOpen('users')")
    expect(badge).toContain("adminRow.hidden = roleKey !== 'admin'")
    expect(badge).not.toContain('id="dsh-account-admin-menu"')
  })

  it('前端先做长度和确认校验，错误文案可控', () => {
    expect(html).toContain('新密码至少 6 位')
    expect(html).toContain('两次输入的新密码不一致')
    expect(html).toContain('当前密码不正确')
  })
})
