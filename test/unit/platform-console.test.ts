import { describe, expect, it } from 'vitest'
import { platformConsole } from '../../src/client/console.js'

/**
 * 注入客户端的 Skills / MCP 配置页。
 *
 * 需求只保留公开 / 私有两种可见性，不引入合集（分组）；
 * 入口是左侧菜单的 Skills / MCP 两行；页面挂进中间栏替换对话，不用浮层。
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

  it('入口只在左侧菜单，页面挂进中间栏而不是 fixed 浮层', () => {
    expect(html).toContain("'dsh-console-menu'")
    expect(html).toContain('[class*="sidebarCol"]')
    expect(html).toContain('nav.prepend(menu)')
    expect(html).toContain('dsh-rail')
    expect(html).toContain("view: 'skills'")
    expect(html).toContain("view: 'mcp'")
    // 菜单只留 Skills / MCP：文件和反馈不在这里各占一行。
    expect(html).not.toContain("view: 'files'")
    expect(html).not.toContain("view: 'feedback'")
    expect(html).not.toContain('openFilesPane')
    expect(html).not.toContain('admin-page-side')
    expect(html).not.toContain('admin-page-nav')
    expect(html).not.toContain('返回对话')
    expect(html).not.toContain('dsh-account-skills')
    expect(html).not.toContain('dsh-account-mcp')
    expect(html).toContain('data-dsh-console-host')
    expect(html).toContain('mountIntoMain')
    expect(html).toContain('[class*="mainPanel"]')
    expect(html).not.toContain('position:fixed')
    expect(html).not.toContain('z-index:10001')
  })

  it('左侧菜单的入口高亮跟随当前页面', () => {
    expect(html).toContain('syncMenuActive')
    expect(html).toContain('data-console-view')
    expect(html).toContain('aria-current')
  })

  it('点侧栏聊天入口会关掉配置页，退回对话', () => {
    expect(html).toContain("root.dataset.open !== 'true'")
    expect(html).toContain("target.closest('#dsh-console-menu')")
    expect(html).toContain('window.__dshConsoleClose')
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

  it('Skills / MCP 列表用卡片网格展示，不再用表格行', () => {
    expect(html).toContain('dsh-card-grid')
    expect(html).toContain('dsh-card-avatar')
    expect(html).toContain('dsh-card-visibility')
    expect(html).toContain('dsh-card-desc')
    expect(html).toContain('avatarLetter')
    expect(html).toContain('avatarColor')
    expect(html).toContain('renderGrid')
    expect(html).not.toContain('admin-table')
    expect(html).not.toContain('skillRow')
    expect(html).not.toContain('mcpRow')
  })

  it('卡片点开编辑，停用和删除在卡片底部', () => {
    expect(html).toContain("card.addEventListener('click', () => void editItem(item))")
    expect(html).toContain("cardAction(item.enabled ? '停用' : '启用'")
    expect(html).toContain('dsh-card-delete')
    expect(html).toContain('只读')
  })

  it('新建 / 编辑是独立表单页，打开时列表让位', () => {
    const renderBody = html.slice(html.indexOf('function render()'), html.indexOf('function emptyState()'))
    // 表单存在时直接返回，不再往页面上叠卡片网格。
    expect(renderBody).toMatch(/if \(state\.form\) \{\s*bodyEl\.append\(renderForm\(\)\)\s*return/)
    expect(html).toContain('function syncHeader()')
    expect(html).toContain('returnButton.hidden = !form')
    expect(html).toContain('refreshButton.hidden = Boolean(form)')
    expect(html).toContain('createButton.hidden = Boolean(form)')
    expect(html).toContain('id="dsh-console-return"')
    expect(html).toContain('id="dsh-console-save"')
    expect(html).toContain("'新建 Skill'")
    expect(html).toContain('编辑 Skill · ')
    expect(html).not.toContain('admin-form-actions')
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
