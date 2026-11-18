import { describe, expect, it } from 'vitest'
import { userBadge } from '../../src/client/user-badge.js'

/** 左下角登录身份：点头像弹菜单，菜单里进设置。 */
describe('登录身份条', () => {
  it('指向平台的 auth/me，并带头像触发器', () => {
    const html = userBadge()
    expect(html).toContain('id="dsh-account"')
    expect(html).toContain('id="dsh-account-trigger"')
    expect(html).toContain('id="dsh-account-avatar"')
    expect(html).toContain('id="dsh-account-name"')
    expect(html).toContain('id="dsh-account-role"')
    expect(html).toContain('/dsh-api/platform/v1/auth/me')
    expect(html).toContain("credentials: 'same-origin'")
  })

  it('点头像弹出账号菜单，菜单里有设置入口', () => {
    const html = userBadge()
    expect(html).toContain('id="dsh-account-menu"')
    expect(html).toContain('id="dsh-account-settings"')
    expect(html).toContain('>设置</span>')
    expect(html).toContain('openSettings')
    expect(html).toContain('[class*="_settingsArea"] button')
    expect(html).not.toContain('id="dsh-account-general"')
    expect(html).not.toContain('id="dsh-account-models"')
    expect(html).not.toContain('openSettingsSection')
  })

  it('账号菜单只留设置和退出，Skills / MCP 不放左下角', () => {
    const html = userBadge()
    expect(html).not.toContain('id="dsh-account-skills"')
    expect(html).not.toContain('id="dsh-account-mcp"')
    expect(html).not.toContain('openConsole')
    expect(html).not.toContain('__dshConsoleOpen')
  })

  it('退出登录在账号菜单里', () => {
    const html = userBadge()
    expect(html).toContain('id="dsh-account-logout"')
    expect(html).toContain("fetch('/logout', { method: 'POST'")
  })

  it('把侧栏宽度同步给右侧设置页，避免盖住左侧菜单', () => {
    const html = userBadge()
    expect(html).toContain('--dsh-platform-sidebar-width')
    expect(html).toContain('[class*="sidebarCol"]')
    expect(html).toContain('syncSidebarWidth')
  })

  it('头像挂进侧栏底部的 footArea，会话再多也滚不到它下面', () => {
    const html = userBadge()
    // 官方底槽在会话滚动区之外，挂进去靠 flex 布局让出高度。
    expect(html).toContain('[class*="footArea"]')
    expect(html).toContain('foot.prepend(root)')
    expect(html).toContain('mountIntoFootArea')
    // 默认参与布局，只有找不到底槽时才退回 fixed 浮层。
    expect(html).toContain('data-fixed="false"')
    expect(html).toContain('#dsh-account[data-fixed="true"]')
    expect(html).not.toContain('style="display:none;position:fixed')
  })

  it('侧栏收成 rail 时只留圆形头像', () => {
    const html = userBadge()
    expect(html).toContain('data-rail="true"')
    expect(html).toContain('#dsh-account[data-rail="true"] .dsh-acct-ident{display:none}')
    expect(html).toContain("root.dataset.rail = width > 0 && width <= 120 ? 'true' : 'false'")
  })

  it('DOM 变更按帧合并，聊天流式输出时不反复量侧栏', () => {
    const html = userBadge()
    expect(html).toContain('requestAnimationFrame')
    expect(html).toContain('scheduleSync')
  })

  it('点设置面板外（含左侧菜单）会关掉设置', () => {
    const html = userBadge()
    expect(html).toContain('closeSettings')
    expect(html).toContain('panel.contains(target)')
    expect(html).toContain('root.contains(target)')
  })

  it('角色映射成中文，名字用 textContent 写入', () => {
    const html = userBadge()
    expect(html).toContain("data.role === 'admin' ? '管理员'")
    expect(html).toContain("data.role === 'member' ? '成员'")
    expect(html).toContain('.textContent = name')
    expect(html).toContain('display:none')
    expect(html).not.toContain('innerHTML')
  })
})
