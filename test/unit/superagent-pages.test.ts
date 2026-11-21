import { describe, expect, it } from 'vitest'
import { integrationsPage } from '../../src/client/integrations.js'
import { ticketsPage } from '../../src/client/tickets.js'

/**
 * 两个新注入页：都钉在侧栏右侧、只走平台成员接口；
 * 「集成」从头像菜单进，「工单任务」是左侧菜单的一级入口。
 */

describe('集成页', () => {
  const html = integrationsPage()

  it('钉在侧栏右侧，不盖住左侧菜单', () => {
    expect(html).toContain('id="dsh-integrations"')
    expect(html).toContain('position:fixed;inset:0 0 0 var(--dsh-platform-sidebar-width,280px)')
  })

  it('只走平台自己的成员接口', () => {
    expect(html).toContain('/dsh-api/platform/v1')
    expect(html).toContain("api('/superagent/channels')")
    expect(html).toContain("api('/superagent/bindings')")
    expect(html).toContain("api('/workspaces')")
    expect(html).toContain("init.credentials = 'same-origin'")
  })

  it('每个渠道一个标签页，配置互不混在一起', () => {
    expect(html).toContain('id="dsh-int-tabs"')
    expect(html).toContain('role="tab"')
    expect(html).toContain("data-tab=\"' + esc(tab.id) + '\"")
    expect(html).toContain("{ id: 'feishu', label: '飞书' }")
    expect(html).toContain("{ id: 'github', label: 'GitHub' }")
    expect(html).toContain('state.tab === \'github\'')
    // GitHub 渠道先把位置留出来：将来填 Token 自动拉仓库再绑群。
    expect(html).toContain('GitHub Token')
    expect(html).toContain('即将支持')
  })

  it('主按钮的字色不会被基础样式压掉', () => {
    // `#id button{color:inherit}` 的优先级高于 `.dsh-int-btn.primary`，
    // 会让黑底按钮变成黑字；基础样式只继承字体，颜色交给按钮类。
    expect(html).toContain('textarea{font:inherit}')
    expect(html).not.toContain('textarea{font:inherit;color:inherit}')
    expect(html).toContain('.dsh-int-btn.primary{background:var(--i-primary);border-color:var(--i-primary);color:var(--i-primary-fg)}')
  })

  it('飞书机器人：能加、改、停用、删除，但看不到密钥', () => {
    expect(html).toContain('App ID')
    expect(html).toContain('App Secret')
    expect(html).toContain("data-act=\"channel-new\"")
    expect(html).toContain("data-act=\"channel-edit\"")
    expect(html).toContain("data-act=\"channel-toggle\"")
    expect(html).toContain("data-act=\"channel-remove\"")
    // 列表只渲染 appId / 状态，绝不把密钥读回页面。
    expect(html).toContain('channel.appId')
    expect(html).not.toContain('channel.appSecret')
    expect(html).not.toContain('secret_ciphertext')
  })

  it('群绑定：工作区、GitHub 仓库、自动合并、规则都在表单里', () => {
    expect(html).toContain('工作区')
    // 处理范围写清楚：只有点名和私聊会处理，没 @ 的群消息只记录。
    expect(html).toContain('只有在群里 @ 机器人或私聊时才会处理；没有 @ 的群消息只记录，不判断也不回复。')
    expect(html).toContain('GitHub 仓库')
    expect(html).toContain('owner/name')
    expect(html).toContain('autoMerge')
    expect(html).toContain('接活规则')
  })

  it('修改卡片在原地展开表单，不再跳到页面顶部', () => {
    // 列表循环里按被编辑的 id 就地渲染表单；新增表单放在各自区块顶部。
    expect(html).toContain("state.form === 'channel' && state.editing === channel.id")
    expect(html).toContain('channelFormBody(channel)')
    expect(html).toContain("state.form === 'binding' && state.editing === binding.id")
    expect(html).toContain('bindingFormBody(binding)')
    expect(html).toContain('if (addingChannel) html += channelFormBody(null)')
    expect(html).toContain('if (addingBinding) html += bindingFormBody(null)')
    // 旧的「渲染时把表单塞在列表上方」要彻底去掉。
    expect(html).not.toContain("if (state.form === 'channel') html += channelForm()")
    expect(html).not.toContain("else if (state.form === 'binding') html += bindingForm()")
  })

  it('机器人有默认规则：新建绑定默认继承，单个绑定仍可覆盖', () => {
    expect(html).toContain('默认接活规则')
    expect(html).toContain('name="defaultRules"')
    expect(html).toContain('saveChannel')
    expect(html).toContain("defaultRules: ruleList('defaultRules')")
  })

  it('绑定表单会直接写出机器人默认规则条数，不用人猜', () => {
    expect(html).toContain('refreshBindingHints')
    expect(html).toContain('data-role="binding-rules-hint"')
    expect(html).toContain('留空就沿用这个机器人的 ')
  })

  it('有机器人凭证就能拉群列表，勾选后一起绑；也可以手填群 ID', () => {
    expect(html).toContain("'/superagent/channels/' + encodeURIComponent(channelId) + '/chats'")
    expect(html).toContain("data-act=\"chats-load\"")
    expect(html).toContain("data-act=\"chats-bind\"")
    expect(html).toContain('name="chatPick"')
    expect(html).toContain('id="dsh-int-chats"')
    // 已绑过的群标出来但不再勾；权限没开时给出照做就行的提示。
    expect(html).toContain('已绑定')
    expect(html).toContain('im:chat:readonly')
    // 私聊不用绑，说明里直接告诉成员。
    expect(html).toContain('私聊不用绑')
  })

  it('选好机器人就自动拉群，不用再点按钮；机器人卡片也能直达绑定', () => {
    // 进入新增绑定 / 换机器人时自动同步群列表；已有结果复用，不重复请求。
    expect(html).toContain('syncChats()')
    expect(html).toContain('if (state.chatsChannel === channelId) { renderChatList(); return }')
    expect(html).toContain('void loadChats()')
    // 只有一个机器人时直接选中，省掉一步选择。
    expect(html).toContain('state.channels.length === 1')
    // 卡片上的「绑定群」带着机器人进表单。
    expect(html).toContain("data-act=\"channel-bind\"")
    expect(html).toContain('state.presetChannel = id')
    // 新机器人保存后直接进「新增绑定」，自动列出它的群。
    expect(html).toContain("state.presetChannel = saved && saved.id ? saved.id : ''")
  })

  it('由头像菜单的「集成」打开', () => {
    expect(html).toContain('window.__dshIntegrationsOpen = open')
  })
})

describe('工单任务页', () => {
  const html = ticketsPage()

  it('钉在侧栏右侧，并插进左侧菜单', () => {
    expect(html).toContain('id="dsh-tickets"')
    expect(html).toContain('position:fixed;inset:0 0 0 var(--dsh-platform-sidebar-width,280px)')
    expect(html).toContain("'dsh-tickets-menu'")
    expect(html).toContain('[class*="sidebarCol"]')
    expect(html).toContain('dsh-rail')
    expect(html).toContain('工单任务')
  })

  it('菜单排在「自动化任务」下面', () => {
    expect(html).toContain('anchorOf')
    expect(html).toContain('placeMenu')
    expect(html).toContain("label.indexOf('自动化')")
    expect(html).toContain('insertBefore(menuNode, anchor.nextSibling)')
    // 定时任务还没渲染出来时先放最前，等它出现再挪过去。
    expect(html).toContain('nav.prepend(menuNode)')
  })

  it('按钮字色由按钮类决定，不被基础样式压成黑底黑字', () => {
    expect(html).toContain('#dsh-tickets button,#dsh-tickets input{font:inherit}')
    expect(html).not.toContain('input{font:inherit;color:inherit}')
    expect(html).toContain('.dsh-t-btn.danger{color:var(--t-error)}')
  })

  it('列自己的工单并按阶段过滤', () => {
    expect(html).toContain("api('/superagent/tickets'")
    expect(html).toContain('待开工')
    expect(html).toContain('进行中')
    expect(html).toContain('已完成待确认')
    expect(html).toContain('已完成')
    expect(html).toContain('已停止')
    expect(html).toContain('data-stage')
  })

  it('待确认的单只给「确认完成」，不再给会丢结果的「停止」', () => {
    expect(html).toContain("ticket.stage === 'review' ? '确认完成' : '标记完成'")
    expect(html).toContain("ticket.stage !== 'review'")
    expect(html).toContain('做完了，等你确认')
  })

  it('正文默认折成两行，长回复给「展开全文」按钮，点开可收起', () => {
    // 列表只露出两行预览，避免一屏塞满完整结论。
    expect(html).toContain('.dsh-ticket-note.clamp{display:-webkit-box;-webkit-line-clamp:2')
    expect(html).toContain('.dsh-ticket-note.clamp.expanded')
    expect(html).toContain('class="dsh-ticket-note clamp" id="dsh-note-')
    expect(html).toContain("summary.length > 120 || summary.indexOf('\\n') >= 0")
    expect(html).toContain('data-act="expand"')
    expect(html).toContain('展开全文')
    // 点开后在原地切换，按钮文案改成「收起」。
    expect(html).toContain("if (act === 'expand')")
    expect(html).toContain("target.textContent = expanded ? '收起' : '展开全文'")
  })

  it('完成 / 停止走同一个结束接口，停止前会确认，进行中的停止提示会说明会话被中止', () => {
    expect(html).toContain("'/superagent/tickets/' + encodeURIComponent(id) + '/close'")
    expect(html).toContain("closeTicket(id, 'done')")
    expect(html).toContain("closeTicket(id, 'stopped')")
    expect(html).toContain('window.confirm')
    expect(html).toContain('正在跑的会话会被中止')
    expect(html).toContain("target.getAttribute('data-stage') === 'working'")
  })
})
