import { describe, expect, it } from 'vitest'
import { platformConsole } from '../../src/client/console.js'

/**
 * 注入客户端的 Skills / MCP 配置页。
 *
 * 需求只保留公开 / 私有两种可见性，不引入合集（分组）；
 * 入口是左侧菜单的 Skills / MCP 两行和管理员的「管理」；页面像设置页一样
 * 左栏导航 + 右栏内容，并用同样的侧栏右侧 inset 定位，不盖住左侧菜单。
 */
describe('平台配置页', () => {
  const html = platformConsole()

  it('注入内容区和关闭按钮', () => {
    expect(html).toContain('id="dsh-console"')
    expect(html).toContain('id="dsh-console-body"')
    expect(html).toContain('id="dsh-console-create"')
    expect(html).toContain('id="dsh-console-refresh"')
    expect(html).toContain('id="dsh-console-back"')
    expect(html).toContain('window.__dshConsoleOpen')
  })

  it('只走平台自己的 API', () => {
    expect(html).toContain("'/skills'")
    expect(html).toContain("'/mcp-servers'")
    expect(html).toContain('/dsh-api/platform/v1')
  })

  it('只有公开和私有，没有合集入口', () => {
    expect(html).toContain('仅自己可见')
    expect(html).toContain('全员可见')
    expect(html).toContain('scope')
    expect(html).not.toContain('合集')
    expect(html).not.toContain('分组')
    expect(html).not.toContain('collection')
  })

  it('入口在左侧菜单和头像「管理」里，页面是设置页布局的整页，不是弹框', () => {
    expect(html).toContain("'dsh-console-menu'")
    expect(html).toContain('[class*="sidebarCol"]')
    expect(html).toContain('nav.prepend(menu)')
    expect(html).toContain('dsh-rail')
    // 视图清单由服务端注入：Skills / MCP 全员可见，用户 / 沙箱只给管理员且收在头像菜单。
    expect(html).toContain('"view":"skills"')
    expect(html).toContain('"view":"mcp"')
    expect(html).toContain('"view":"users"')
    expect(html).toContain('"view":"sandboxes"')
    expect(html).toContain('"adminOnly":true')
    expect(html).toContain('"menu":"sidebar"')
    expect(html).toContain('"menu":"account"')
    expect(html).toContain('SIDEBAR_MENU = ')
    expect(html).toContain('function visibleEntries()')
    expect(html).toContain("entry.menu === 'sidebar'")
    expect(html).toContain('function menuEntries()')
    expect(html).not.toContain('__CONSOLE_VIEWS__')
    // 菜单只有这四个视图：文件和反馈不在这里各占一行。
    expect(html).not.toContain('"view":"files"')
    expect(html).not.toContain('"view":"feedback"')
    expect(html).not.toContain('openFilesPane')
    expect(html).not.toContain('admin-page-side')
    expect(html).not.toContain('admin-page-nav')
    // 整页右上角的关闭按钮回到对话。
    expect(html).toContain('aria-label="返回对话"')
    expect(html).not.toContain('dsh-account-skills')
    expect(html).not.toContain('dsh-account-mcp')
    // 设置页同款布局与定位：188px 内左栏 + 内容栏；fixed 钉在侧栏右侧。
    expect(html).toContain('id="dsh-console-rail"')
    expect(html).toContain('id="dsh-console-nav"')
    expect(html).toContain('data-scope="admin"')
    expect(html).toContain('grid-template-columns')
    expect(html).toContain('--dsh-platform-sidebar-width')
    expect(html).toContain('position:fixed')
    expect(html).toContain('function mountConsole')
    expect(html).toContain('function scopeOf(view)')
    expect(html).not.toContain('function mountIntoMain')
    expect(html).not.toContain('data-dsh-console-host')
    expect(html).not.toContain('id="dsh-console-mask"')
    expect(html).not.toContain('id="dsh-console-panel"')
    expect(html).not.toContain('aria-modal')
  })

  it('管理页左栏只放用户 / 沙箱，Skills / MCP 不在里面', () => {
    expect(html).toContain('function panelEntries()')
    expect(html).toContain("visibleEntries().filter((entry) => entry.menu === 'account')")
    const nav = html.slice(html.indexOf('function renderPanelNav()'), html.indexOf('// 先按当前身份画一版'))
    expect(nav).toContain('panelEntries()')
    expect(nav).not.toContain('visibleEntries()')
  })

  it('左侧菜单的入口高亮跟随当前页面', () => {
    expect(html).toContain('syncMenuActive')
    expect(html).toContain('data-console-view')
    expect(html).toContain('#dsh-console-nav [data-console-view]')
    expect(html).toContain('aria-current')
  })

  it('关闭按钮或按 Esc 会返回对话，没有遮罩可点', () => {
    expect(html).not.toContain('dsh-console-mask')
    expect(html).toContain("backButton.addEventListener('click', close)")
    expect(html).toContain("event.key !== 'Escape'")
    expect(html).toContain('window.__dshConsoleClose')
    expect(html).toContain('function mountConsole')
  })

  it('点到页面之外先返回对话，左侧菜单照常可点', () => {
    // 和设置页一样：整页打开时点左侧会话列表/菜单/头像，先关页面再照常处理这次点击。
    const outside = html.slice(html.indexOf("// 和设置页一样：点到整页之外"), html.indexOf("refreshButton.addEventListener"))
    expect(outside).toContain("root.contains(target)")
    expect(outside).toContain("target.closest('#dsh-console-menu')")
    expect(outside).toContain('close()')
    expect(outside).toContain('}, true)')
    expect(outside).toContain("root.dataset.open !== 'true'")
  })

  it('隐藏元素真的不显示：错误框默认不占位', () => {
    expect(html).toContain('#dsh-console [hidden]{display:none!important}')
  })

  it('技能表单支持文本、文件和文件夹上传，MCP 表单支持 Headers JSON', () => {
    expect(html).toContain('webkitdirectory')
    expect(html).toContain('SKILL.md')
    expect(html).toContain('keepSecret')
    expect(html).toContain('/files?path=')
  })

  it('Skills / MCP 列表用卡片网格展示，用户和沙箱用管理员表格', () => {
    expect(html).toContain('dsh-card-grid')
    expect(html).toContain('dsh-card-avatar')
    expect(html).toContain('dsh-card-visibility')
    expect(html).toContain('dsh-card-desc')
    expect(html).toContain('avatarLetter')
    expect(html).toContain('avatarColor')
    expect(html).toContain('renderGrid')
    expect(html).not.toContain('skillRow')
    expect(html).not.toContain('mcpRow')
  })

  it('用户管理：新建 / 编辑、重置成员密码、停用、改角色都走平台接口', () => {
    expect(html).toContain('renderUserTable')
    expect(html).toContain('renderUserToolbar')
    expect(html).toContain('openUserForm')
    expect(html).toContain('openResetPasswordForm')
    expect(html).toContain('saveUser')
    expect(html).toContain('saveResetPassword')
    expect(html).toContain('/admin/users')
    expect(html).toContain('/admin/users/${encodeURIComponent(form.id)}/password')
    expect(html).toContain('/admin/users/${encodeURIComponent(member.id)}/role')
    expect(html).toContain('留空自动生成；至少 6 位')
    expect(html).toContain('不是改你自己的账号')
    expect(html).toContain('只显示这一次')
    // 当前账号不能顺手停用自己；自己也不走「重置密码」。
    expect(html).toContain('当前账号')
  })

  it('沙箱排障页：只读、带过滤和分页，不读会话内容', () => {
    expect(html).toContain('renderSandboxTable')
    expect(html).toContain('renderSandboxToolbar')
    expect(html).toContain('renderPager')
    expect(html).toContain('/admin/sandboxes')
    expect(html).toContain('user_id')
    expect(html).toContain('page_size')
    expect(html).toContain('只读排障')
    expect(html).toContain('按成员登录名筛选')
  })

  it('卡片点开编辑，停用和删除在卡片底部', () => {
    expect(html).toContain("card.addEventListener('click', () => void editItem(item))")
    expect(html).toContain("cardAction(item.enabled ? '停用' : '启用'")
    expect(html).toContain('dsh-card-delete')
    expect(html).toContain('只读')
  })

  it('新建 / 编辑是独立表单页，打开时列表让位', () => {
    const renderBody = html.slice(html.indexOf('function render()'), html.indexOf('function emptyState()'))
    // 表单存在时直接返回，不再往页面上叠卡片网格；用户 / 重置密码表单走各自渲染器。
    expect(renderBody).toContain("state.form.kind === 'user-reset'")
    expect(renderBody).toContain('renderResetPasswordForm()')
    expect(renderBody).toContain('renderUserForm()')
    expect(html).toContain('function syncHeader()')
    expect(html).toContain('returnButton.hidden = !form')
    expect(html).toContain('refreshButton.hidden = Boolean(form)')
    // 打开表单时新建按钮让位；沙箱页没有新建动作，靠 create 为空串隐藏。
    expect(html).toContain('createButton.hidden = true')
    expect(html).toContain("createButton.hidden = head.create === ''")
    expect(html).toContain('id="dsh-console-return"')
    expect(html).toContain('id="dsh-console-save"')
    expect(html).toContain("'新建 Skill'")
    expect(html).toContain('编辑 Skill · ')
    // 用户新建 / 重置密码的主按钮在表单底部，不占用顶栏。
    expect(html).toContain('admin-form-actions')
    expect(html).toContain('＋ 创建用户')
  })

  it('返回列表会恢复离开前的滚动位置', () => {
    expect(html).toContain('listScroll')
    expect(html).toContain('mainEl.scrollTop = state.listScroll')
    expect(html).toContain('function closeForm()')
    expect(html).toContain('returnButton.addEventListener')
  })

  it('表单页的 Esc 退回列表，列表页才关整个面板', () => {
    const esc = html.slice(html.indexOf("event.key !== 'Escape'"), html.indexOf('// 点「新建会话'))
    expect(esc).toContain('if (state.form)')
    expect(esc).toContain('closeForm()')
    expect(esc).toContain('close()')
  })

  it('动态内容用 DOM 构建，不拼 innerHTML', () => {
    expect(html).not.toContain('innerHTML')
    expect(html).not.toContain('outerHTML')
    expect(html).toContain('createElement')
  })
})
