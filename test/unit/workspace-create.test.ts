import { describe, expect, it } from 'vitest'
import { workspaceCreate } from '../../src/client/workspace-create.js'

/**
 * 侧边栏「新增工作区」入口。
 *
 * 官方客户端的「+」要求注册 `sidebar.workspaces.directoryFlow` 槽位，平台没有
 * 自定义客户端插件，所以按钮由注入脚本挂在工作区标题右侧；弹窗里选 Skills / MCP，
 * 提交走平台收口的 `P/remote/workspace/create`。
 */
describe('新增工作区入口', () => {
  const html = workspaceCreate()

  it('挂到侧边栏工作区标题行本身，React 重画后会补回来', () => {
    expect(html).toContain('dsh-workspace-add')
    expect(html).toContain('[data-sidebar-workspace-header]')
    // headerActions 限宽且 overflow:hidden，入口直接挂在标题行上。
    expect(html).toContain('header.append(button)')
    expect(html).not.toContain('.headerActions.append')
    expect(html).toContain('MutationObserver')
  })

  it('按钮只留图标，不再显示「新建工作区」文字', () => {
    expect(html).toContain("'aria-label': '新建工作区'")
    expect(html).toContain("title: '新建工作区'")
    expect(html).not.toContain('dsh-ws-add-label')
    expect(html).not.toContain('data-compact')
    // 侧栏收成 rail 时跟官方一样是 36px。
    expect(html).toContain('data-rail')
    expect(html).toContain('width:36px;height:36px')
  })

  it('用 DSH 官方工作区头部的图标和变量，不自造图形', () => {
    expect(html).toContain('--dsw-radius-sm')
    expect(html).toContain('--dsw-alias-label-secondary')
    expect(html).toContain('--dsw-alias-interactive-bg-hover')
    expect(html).toContain('--dsw-focus-ring-width')
    // project-add-outline 的官方图形，不是自己画的加号。
    expect(html).toContain('M5.54492 2.06738')
    expect(html).toContain('M9.75977 4.50208H14.5509')
  })

  it('主页输入区上方不挂新建工作区入口', () => {
    expect(html).not.toContain('dsh-workspace-hero-add')
    expect(html).not.toContain('dsh-ws-hero-add')
    expect(html).not.toContain('__dshWorkspaceCreateOpen')
  })

  it('弹窗有名称、Skills、MCP 三块，默认不勾选', () => {
    expect(html).toContain('id="dsh-workspace-create"')
    expect(html).toContain('id="dsh-ws-name"')
    expect(html).toContain('id="dsh-ws-skills"')
    expect(html).toContain('id="dsh-ws-mcp"')
    expect(html).toContain('id="dsh-ws-skills-search"')
    expect(html).toContain('id="dsh-ws-mcp-search"')
    expect(html).toContain('不选表示都不接入')
  })

  it('选项来自平台自己的接口，只列启用中的条目', () => {
    expect(html).toContain('/dsh-api/platform/v1')
    expect(html).toContain("api('/skills')")
    expect(html).toContain("api('/mcp-servers')")
    expect(html).toContain("item.enabled !== false")
  })

  it('选择交互和参考项目一致：搜索框下拉候选，已选项用卡片网格', () => {
    expect(html).toContain('id="dsh-ws-skills-panel"')
    expect(html).toContain('id="dsh-ws-mcp-panel"')
    expect(html).toContain('dsh-ws-picker')
    expect(html).toContain('dsh-ws-searchbox')
    expect(html).toContain('dsh-ws-candidate')
    expect(html).toContain('dsh-ws-selected')
    expect(html).toContain('dsh-ws-pick')
    expect(html).toContain('dsh-ws-avatar')
    expect(html).toContain('dsh-ws-remove')
    expect(html).toContain('尚未选择')
    expect(html).toContain('avatarColor')
    expect(html).not.toContain('dsh-ws-option')
  })

  it('候选里排除已选，选中后清空搜索并收起面板', () => {
    expect(html).toContain('if (selected.has(keyOf(item))) return false')
    expect(html).toContain('state.skillsOpen = false')
    expect(html).toContain('state.mcpOpen = false')
    expect(html).toContain("target.closest('#dsh-ws-skills-panel')")
  })

  it('提交走平台收口的工作区 RPC，带上选中的名字和作用域', () => {
    expect(html).toContain("'/dsh-api/platform/v1'")
    expect(html).toContain('/remote/workspace/create')
    expect(html).toContain('rpcId')
    expect(html).toContain('mcpServers')
    expect(html).toContain("scope: key.slice(0, at)")
    expect(html).toContain('result.ok')
  })

  it('选项加载失败时不允许提交，避免静默建出空选择的工作区', () => {
    expect(html).toContain('loadFailed')
    expect(html).toContain('state.busy || state.loading || state.loadFailed')
  })

  it('能关掉：遮罩、取消、Esc，并恢复页面滚动', () => {
    expect(html).toContain('data-dsh-ws-close')
    expect(html).toContain("event.key === 'Escape'")
    expect(html).toContain('bodyOverflow')
  })

  it('选项和错误都用 DOM 构建，不拼 innerHTML', () => {
    expect(html).not.toContain('innerHTML')
    expect(html).not.toContain('outerHTML')
    expect(html).toContain('createElement')
    expect(html).toContain('textContent')
  })
})
