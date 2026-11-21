/**
 * 「集成」整页：成员自己的飞书机器人 + 群与工作区绑定 + GitHub 仓库。
 *
 * 从头像菜单打开，和设置页同一套钉法：`fixed` 铺在侧栏右侧，不盖住左侧
 * 会话 / Skills / MCP。密钥只进不出——列表里只有 App ID 和连接状态。
 */

export function integrationsPage(): string {
  return `<div id="dsh-integrations" hidden data-open="false">
<style>
#dsh-integrations{--i-bg:#fff;--i-fg:#111827;--i-muted:#6e7781;--i-border:#e5e7eb;--i-border-strong:#d0d7de;--i-hover:#eef1f5;--i-primary:#111827;--i-primary-fg:#fff;--i-accent:#0969da;--i-error:#d1242f;--i-success:#1a7f37;position:fixed;inset:0 0 0 var(--dsh-platform-sidebar-width,280px);z-index:900;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,var(--i-bg));color:var(--i-fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;text-align:left}
#dsh-integrations[hidden]{display:none!important}
#dsh-integrations *{box-sizing:border-box}
#dsh-integrations button,#dsh-integrations input,#dsh-integrations select,#dsh-integrations textarea{font:inherit}
#dsh-int-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:calc(20px + var(--dsh-frame-top-clearance,0px)) clamp(20px,4vw,40px) 12px;border-bottom:1px solid var(--i-border)}
#dsh-int-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
#dsh-int-head p{margin:5px 0 0;color:var(--i-muted);font-size:12.5px}
/* 每个渠道一个标签页：飞书、GitHub……各自只展示自己的配置。 */
#dsh-int-tabs{display:flex;gap:2px;flex:none;padding:0 clamp(20px,4vw,40px);border-bottom:1px solid var(--i-border)}
#dsh-int-tabs button{position:relative;height:38px;padding:0 12px;border:0;border-radius:8px 8px 0 0;background:transparent;color:var(--i-muted);font-size:13px;cursor:pointer}
#dsh-int-tabs button:hover{background:var(--i-hover);color:var(--i-fg)}
#dsh-int-tabs button[aria-selected="true"]{color:var(--i-fg);font-weight:600}
#dsh-int-tabs button[aria-selected="true"]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--i-primary)}
#dsh-int-body{flex:1;min-height:0;overflow:auto;padding:18px clamp(20px,4vw,40px) 40px}
#dsh-int-inner{display:flex;flex-direction:column;gap:22px;width:100%;max-width:1040px;margin:0 auto}
#dsh-int-inner section{display:flex;flex-direction:column;gap:12px}
#dsh-int-inner h2{margin:0;font-size:15px;font-weight:600;display:flex;align-items:center;gap:10px}
#dsh-int-inner h2 .dsh-int-count{color:var(--i-muted);font-size:12px;font-weight:400}
#dsh-int-inner .dsh-int-actions{margin-left:auto;display:flex;gap:8px}
.dsh-int-hint{margin:0;color:var(--i-muted);font-size:12px;line-height:1.6}
.dsh-int-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--i-border-strong);background:var(--i-bg);color:var(--i-fg);font-size:13px;cursor:pointer;white-space:nowrap}
.dsh-int-btn:hover:not(:disabled){background:var(--i-hover)}
.dsh-int-btn:disabled{opacity:.45;cursor:not-allowed}
.dsh-int-btn.primary{background:var(--i-primary);border-color:var(--i-primary);color:var(--i-primary-fg)}
.dsh-int-btn.primary:hover:not(:disabled){opacity:.9;background:var(--i-primary)}
.dsh-int-btn.small{height:28px;padding:0 9px;font-size:12px}
.dsh-int-btn.danger{color:var(--i-error)}
.dsh-int-list{display:flex;flex-direction:column;gap:10px}
.dsh-int-card{display:flex;align-items:flex-start;gap:14px;padding:14px 16px;border:1px solid var(--i-border);border-radius:12px;background:var(--i-bg)}
.dsh-int-card.off{opacity:.7}
.dsh-int-card-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}
.dsh-int-card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:600}
.dsh-int-card-meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--i-muted);font-size:12px;word-break:break-all}
.dsh-int-card-note{margin:0;color:var(--i-muted);font-size:12px;line-height:1.55;word-break:break-word}
.dsh-int-card-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsh-int-chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:400;color:var(--i-muted);background:var(--i-hover)}
.dsh-int-chip.ok{color:var(--i-success);background:color-mix(in srgb,var(--i-success) 10%,transparent)}
.dsh-int-chip.bad{color:var(--i-error);background:color-mix(in srgb,var(--i-error) 10%,transparent)}
.dsh-int-chip.accent{color:var(--i-accent);background:color-mix(in srgb,var(--i-accent) 10%,transparent)}
.dsh-int-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:110px;padding:22px;text-align:center;color:var(--i-muted);font-size:12.5px;border:1px dashed var(--i-border);border-radius:12px}
.dsh-int-notice{padding:9px 13px;border-radius:10px;font-size:12.5px;word-break:break-word}
.dsh-int-notice.error{color:var(--i-error);border:1px solid color-mix(in srgb,var(--i-error) 35%,transparent);background:color-mix(in srgb,var(--i-error) 7%,transparent)}
.dsh-int-notice.ok{color:var(--i-success);border:1px solid color-mix(in srgb,var(--i-success) 35%,transparent);background:color-mix(in srgb,var(--i-success) 7%,transparent)}
.dsh-int-form{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border:1px solid var(--i-border);border-radius:12px;background:var(--i-bg)}
.dsh-int-form h3{margin:0;font-size:14px;font-weight:600}
.dsh-int-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.dsh-int-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--i-muted);min-width:0}
.dsh-int-field input,.dsh-int-field select,.dsh-int-field textarea{width:100%;min-width:0;border:1px solid var(--i-border-strong);border-radius:8px;background:var(--i-bg);color:var(--i-fg);padding:7px 10px}
.dsh-int-field input,.dsh-int-field select{height:34px}
.dsh-int-field textarea{min-height:104px;line-height:1.55;resize:vertical}
.dsh-int-field input:focus,.dsh-int-field select:focus,.dsh-int-field textarea:focus{outline:2px solid color-mix(in srgb,var(--i-accent) 25%,transparent);border-color:var(--i-accent)}
.dsh-int-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--i-fg)}
.dsh-int-check input{width:15px;height:15px;margin:0}
.dsh-int-chatpick{display:flex;flex-direction:column;gap:8px;grid-column:1/-1;padding:10px 12px;border:1px dashed var(--i-border);border-radius:10px}
.dsh-int-chatpick-head{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--i-muted);font-size:12px}
.dsh-int-chatlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 12px;max-height:220px;overflow:auto}
.dsh-int-chat{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12.5px;min-width:0}
.dsh-int-chat input{width:15px;height:15px;margin:0;flex:none}
.dsh-int-chat.off{opacity:.65}
.dsh-int-chat-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsh-int-chatfoot{display:flex;justify-content:flex-end}
.dsh-int-form-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
@media (prefers-color-scheme: dark){
#dsh-integrations{--i-bg:#161719;--i-fg:#f3f4f6;--i-muted:#9aa0a6;--i-border:rgba(255,255,255,.1);--i-border-strong:rgba(255,255,255,.18);--i-hover:rgba(255,255,255,.08);--i-primary:#f3f4f6;--i-primary-fg:#0f1115;--i-accent:#6cb6ff;--i-error:#ff8a80;--i-success:#5fd18b}
}
</style>
<div id="dsh-int-head">
<div><h1>集成</h1><p>按渠道分开配置：飞书的机器人与群绑定、GitHub 的仓库，都是你自己的，不影响别人。</p></div>
<button class="dsh-int-btn" type="button" id="dsh-int-close">关闭</button>
</div>
<div id="dsh-int-tabs" role="tablist"></div>
<div id="dsh-int-body"><div id="dsh-int-inner"></div></div>
<script>
(function () {
  var root = document.getElementById('dsh-integrations')
  var inner = document.getElementById('dsh-int-inner')
  var tabs = document.getElementById('dsh-int-tabs')
  var API = '/dsh-api/platform/v1'
  var TABS = [
    { id: 'feishu', label: '飞书' },
    { id: 'github', label: 'GitHub' },
  ]
  var state = { channels: [], bindings: [], workspaces: [], chats: [], chatsChannel: '', chatsError: '', presetChannel: '', tab: 'feishu', form: '', editing: '', notice: '', error: '', busy: false }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  async function api(path, options) {
    var init = options || {}
    init.credentials = 'same-origin'
    var response = await fetch(API + path, init)
    var payload = null
    try { payload = await response.json() } catch (cause) { payload = null }
    if (!response.ok) throw new Error(payload && payload.msg ? payload.msg : 'HTTP ' + response.status)
    return payload && payload.data !== undefined ? payload.data : payload
  }

  function when(value) {
    if (!value) return ''
    var date = new Date(value)
    if (isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  /** 机器人只处理点名和私聊；这句话在表单和列表里都出现，先说清楚。 */
  var ADDRESS_HINT = '只有在群里 @ 机器人或私聊时才会处理；没有 @ 的群消息只记录，不判断也不回复。'

  function channelOf(id) {
    for (var i = 0; i < state.channels.length; i += 1) if (state.channels[i].id === id) return state.channels[i]
    return null
  }

  function bindingOf(id) {
    for (var i = 0; i < state.bindings.length; i += 1) if (state.bindings[i].id === id) return state.bindings[i]
    return null
  }

  function enabledRules(binding) {
    var rules = binding && binding.policy && Array.isArray(binding.policy.rules) ? binding.policy.rules : []
    return rules.filter(function (rule) { return rule && rule.enabled !== false && typeof rule.instruction === 'string' })
  }

  async function load() {
    state.busy = true
    state.error = ''
    render()
    try {
      var loaded = await Promise.all([api('/superagent/channels'), api('/superagent/bindings'), api('/workspaces')])
      state.channels = loaded[0] && Array.isArray(loaded[0].items) ? loaded[0].items : []
      state.bindings = loaded[1] && Array.isArray(loaded[1].items) ? loaded[1].items : []
      state.workspaces = Array.isArray(loaded[2]) ? loaded[2] : []
    } catch (cause) {
      state.error = messageOf(cause)
    }
    state.busy = false
    render()
  }

  function render() {
    renderTabs()
    var html = ''
    if (state.error) html += '<div class="dsh-int-notice error">' + esc(state.error) + '</div>'
    if (state.notice) html += '<div class="dsh-int-notice ok">' + esc(state.notice) + '</div>'
    if (state.tab === 'github') {
      html += githubSection()
    } else {
      // 表单不放页面顶部：新增进它所属区块的顶部，修改就在那张卡片原位展开。
      html += channelSection()
      html += bindingSection()
    }
    inner.innerHTML = html
    if (state.form === 'binding' && !state.editing) {
      refreshBindingHints()
      // 选好机器人就自动列出它所在的群，不用再点一次按钮。
      syncChats()
    }
  }

  function renderTabs() {
    var html = ''
    for (var i = 0; i < TABS.length; i += 1) {
      var tab = TABS[i]
      html += '<button type="button" role="tab" data-tab="' + esc(tab.id) + '" aria-selected="' + (state.tab === tab.id ? 'true' : 'false') + '">' + esc(tab.label) + '</button>'
    }
    tabs.innerHTML = html
  }

  /** GitHub 渠道页：将来填 Token → 自动拉仓库 → 选仓库绑到群。 */
  function githubSection() {
    var html = '<section><h2>GitHub 仓库<span class="dsh-int-chip accent">即将支持</span></h2>'
    html += '<p class="dsh-int-hint">下一步在这里填自己的 GitHub Token，自动列出你有权限的仓库，再挑仓库绑到群上。</p>'
    html += '<div class="dsh-int-empty">这个渠道还没开放。现在需要指定仓库时，去「飞书」里绑定群时手动填 owner/name。</div>'
    return html + '</section>'
  }

  function channelSection() {
    var html = '<section><h2>飞书机器人<span class="dsh-int-count">' + state.channels.length + ' 个</span>'
    html += '<span class="dsh-int-actions"><button class="dsh-int-btn primary small" type="button" data-act="channel-new">添加机器人</button></span></h2>'
    html += '<p class="dsh-int-hint">在飞书开放平台创建企业自建应用，开启机器人能力，把「接收消息」设成长连接并发布。App Secret 只保存密文，页面上不会再显示。</p>'
    var addingChannel = state.form === 'channel' && !state.editing
    if (addingChannel) html += channelFormBody(null)
    if (state.channels.length === 0) {
      if (!addingChannel) html += '<div class="dsh-int-empty">还没有接入机器人。添加一个之后，把它拉进群就能开始接活。</div>'
    } else {
      html += '<div class="dsh-int-list">'
      for (var i = 0; i < state.channels.length; i += 1) {
        var channel = state.channels[i]
        // 修改这个机器人时，表单就长在它的卡片位置，保存或取消后再还原成卡片。
        if (state.form === 'channel' && state.editing === channel.id) {
          html += channelFormBody(channel)
          continue
        }
        var off = channel.status !== 'active'
        var chip = channel.lastError
          ? '<span class="dsh-int-chip bad">连接异常</span>'
          : off ? '<span class="dsh-int-chip">已停用</span>' : '<span class="dsh-int-chip ok">已接入</span>'
        html += '<div class="dsh-int-card' + (off ? ' off' : '') + '">'
        html += '<div class="dsh-int-card-main"><div class="dsh-int-card-title">' + esc(channel.name || channel.appId) + chip + '</div>'
        html += '<div class="dsh-int-card-meta"><span>App ID：' + esc(channel.appId) + '</span>'
        var channelRules = Array.isArray(channel.defaultRules) ? channel.defaultRules : []
        html += '<span>默认接活规则：' + (channelRules.length > 0 ? channelRules.length + ' 条' : '未设（用部署默认）') + '</span>'
        if (channel.lastEventAt) html += '<span>最近收到消息：' + esc(when(channel.lastEventAt)) + '</span>'
        html += '</div>'
        if (channelRules.length > 0) {
          html += '<p class="dsh-int-card-note">' + channelRules.map(function (rule) { return '· ' + esc(rule) }).join('<br>') + '</p>'
        }
        if (channel.lastError) html += '<p class="dsh-int-card-note">连接失败：' + esc(channel.lastError) + '</p>'
        html += '</div><div class="dsh-int-card-actions">'
        html += '<button class="dsh-int-btn small" type="button" data-act="channel-bind" data-id="' + esc(channel.id) + '">绑定群</button>'
        html += '<button class="dsh-int-btn small" type="button" data-act="channel-edit" data-id="' + esc(channel.id) + '">修改</button>'
        html += '<button class="dsh-int-btn small" type="button" data-act="channel-toggle" data-id="' + esc(channel.id) + '">' + (off ? '启用' : '停用') + '</button>'
        html += '<button class="dsh-int-btn small danger" type="button" data-act="channel-remove" data-id="' + esc(channel.id) + '">删除</button>'
        html += '</div></div>'
      }
      html += '</div>'
    }
    return html + '</section>'
  }

  /** 机器人表单本体；editing 有值就长在那张卡片原位，为空就放在区块顶部。 */
  function channelFormBody(editing) {
    var html = '<div class="dsh-int-form"><h3>' + (editing ? '修改机器人' : '添加机器人') + '</h3>'
    html += '<div class="dsh-int-grid">'
    html += '<label class="dsh-int-field">名称<input name="name" value="' + esc(editing ? editing.name : '') + '" placeholder="例如：前端小助手"></label>'
    if (editing) {
      html += '<label class="dsh-int-field">App ID<input name="appId" value="' + esc(editing.appId) + '" disabled></label>'
      html += '<label class="dsh-int-field">新的 App Secret<input name="appSecret" type="password" placeholder="留空表示不改"></label>'
    } else {
      html += '<label class="dsh-int-field">App ID<input name="appId" placeholder="cli_ 开头" autocomplete="off"></label>'
      html += '<label class="dsh-int-field">App Secret<input name="appSecret" type="password" autocomplete="off"></label>'
    }
    html += '</div><p class="dsh-int-hint">' + ADDRESS_HINT + '新建群绑定时会继承下面的默认规则，单个群还能再改。</p>'
    var channelRuleText = editing && Array.isArray(editing.defaultRules) ? editing.defaultRules.join('\\n') : ''
    html += '<label class="dsh-int-field">默认接活规则（每行一条，新建群绑定自动继承）'
    html += '<textarea name="defaultRules" placeholder="例如：&#10;前端页面的改动可以接&#10;数据库迁移和线上配置不要动">' + esc(channelRuleText) + '</textarea></label>'
    html += '<p class="dsh-int-hint">留空就用部署配置里的默认规则；单个群绑定后还能再改。写清楚「接什么、不接什么」，模型判断会更准。</p>'
    html += '<div class="dsh-int-form-foot">'
    html += '<button class="dsh-int-btn" type="button" data-act="form-cancel">取消</button>'
    html += '<button class="dsh-int-btn primary" type="button" data-act="channel-save">' + (editing ? '保存修改' : '添加') + '</button>'
    html += '</div></div>'
    return html
  }

  function bindingSection() {
    var html = '<section><h2>群与工作区<span class="dsh-int-count">' + state.bindings.length + ' 个</span>'
    html += '<span class="dsh-int-actions"><button class="dsh-int-btn primary small" type="button" data-act="binding-new">新增绑定</button></span></h2>'
    html += '<p class="dsh-int-hint">群要绑定工作区才会响应；私聊不用绑，机器人直接用你的默认工作区回话。一个群绑一块工作区，这个群里接的活只在这块工作区的沙箱里做。群 ID 是飞书群设置里的会话 ID（oc_ 开头），也可以选好机器人后一键拉取它所在的群来勾选。GitHub 仓库填成 owner/name，留空表示不指定。</p>'
    var addingBinding = state.form === 'binding' && !state.editing
    if (addingBinding) html += bindingFormBody(null)
    if (state.bindings.length === 0) {
      if (!addingBinding) html += '<div class="dsh-int-empty">还没有绑定群。绑定后，在群里 @ 机器人说清楚要做什么，它就会判断接不接。</div>'
    } else {
      html += '<div class="dsh-int-list">'
      for (var i = 0; i < state.bindings.length; i += 1) {
        var binding = state.bindings[i]
        // 修改这个绑定时，表单就在它的卡片原位展开。
        if (state.form === 'binding' && state.editing === binding.id) {
          html += bindingFormBody(binding)
          continue
        }
        var policy = binding.policy || {}
        var rules = enabledRules(binding)
        var paused = binding.status !== 'active'
        html += '<div class="dsh-int-card' + (paused ? ' off' : '') + '">'
        html += '<div class="dsh-int-card-main"><div class="dsh-int-card-title">' + esc(binding.chatName || binding.externalChatId)
        if (policy.autoMerge === true) html += '<span class="dsh-int-chip accent">做完自动合并</span>'
        if (paused) html += '<span class="dsh-int-chip">已暂停</span>'
        html += '</div>'
        html += '<div class="dsh-int-card-meta"><span>群：' + esc(binding.externalChatId) + '</span>'
        html += '<span>机器人：' + esc(binding.channelName) + '</span>'
        html += '<span>工作区：' + esc(binding.workspaceName) + '</span>'
        html += '<span>仓库：' + esc(typeof policy.repo === 'string' && policy.repo ? policy.repo : '未指定') + '</span>'
        html += '<span>规则：' + rules.length + ' 条</span></div>'
        if (rules.length > 0) {
          html += '<p class="dsh-int-card-note">' + rules.map(function (rule) { return '· ' + esc(rule.instruction) }).join('<br>') + '</p>'
        }
        html += '</div><div class="dsh-int-card-actions">'
        html += '<button class="dsh-int-btn small" type="button" data-act="binding-edit" data-id="' + esc(binding.id) + '">修改</button>'
        html += '<button class="dsh-int-btn small danger" type="button" data-act="binding-remove" data-id="' + esc(binding.id) + '">解绑</button>'
        html += '</div></div>'
      }
      html += '</div>'
    }
    return html + '</section>'
  }

  function option(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>'
  }

  /** 绑定表单本体；editing 有值就长在那张卡片原位，为空就放在区块顶部。 */
  function bindingFormBody(editing) {
    var policy = editing && editing.policy ? editing.policy : {}
    var html = '<div class="dsh-int-form"><h3>' + (editing ? '修改绑定' : '新增绑定') + '</h3>'
    html += '<div class="dsh-int-grid">'
    if (editing) {
      html += '<label class="dsh-int-field">机器人<input value="' + esc(editing.channelName) + '" disabled></label>'
      html += '<label class="dsh-int-field">群 ID<input value="' + esc(editing.externalChatId) + '" disabled></label>'
    } else {
      var channelOptions = '<option value="">选择机器人</option>'
      for (var i = 0; i < state.channels.length; i += 1) {
        // 指定了机器人（从卡片上的「绑定群」进来）或只有一个机器人时，直接选中。
        var chosen = state.presetChannel !== ''
          ? state.presetChannel === state.channels[i].id
          : state.channels.length === 1
        channelOptions += option(state.channels[i].id, state.channels[i].name || state.channels[i].appId, chosen)
      }
      html += '<label class="dsh-int-field">机器人<select name="channelId">' + channelOptions + '</select></label>'
      html += '<label class="dsh-int-field">群 ID（手填，或从下面勾选）<input name="externalChatId" placeholder="oc_ 开头" autocomplete="off"></label>'
      // 选好机器人就自动把它的群列出来选，不用手抄群 ID。
      html += '<div class="dsh-int-chatpick"><div class="dsh-int-chatpick-head"><span>机器人已经在的群</span>'
      html += '<button class="dsh-int-btn small" type="button" data-act="chats-load">重新拉取</button></div>'
      html += '<div id="dsh-int-chats"><p class="dsh-int-hint">选好机器人后会自动列出它已经在的群，勾选后一起绑；也可以在上面手填群 ID。</p></div></div>'
    }
    var workspaceOptions = '<option value="">选择工作区</option>'
    for (var j = 0; j < state.workspaces.length; j += 1) {
      workspaceOptions += option(state.workspaces[j].id, state.workspaces[j].name, editing ? editing.workspaceId === state.workspaces[j].id : false)
    }
    html += '<label class="dsh-int-field">工作区<select name="workspaceId">' + workspaceOptions + '</select></label>'
    html += '<label class="dsh-int-field">群名称（可选）<input name="chatName" value="' + esc(editing ? editing.chatName : '') + '" placeholder="只给自己看的备注"></label>'
    html += '<label class="dsh-int-field">GitHub 仓库<input name="repo" value="' + esc(typeof policy.repo === 'string' ? policy.repo : '') + '" placeholder="owner/name，留空表示不指定"></label>'
    html += '</div>'
    html += '<p class="dsh-int-hint">' + ADDRESS_HINT + '</p>'
    html += '<label class="dsh-int-check"><input name="autoMerge" type="checkbox"' + (policy.autoMerge === true ? ' checked' : '') + '>做完直接合并到主干（默认关闭，留给人看一眼）</label>'
    var ruleText = enabledRules(editing ? { policy: policy } : null).map(function (rule) { return rule.instruction }).join('\\n')
    html += '<label class="dsh-int-field">接活规则（每行一条，用大白话写；留空就跟随机器人默认）<textarea name="rules" placeholder="例如：&#10;前端页面的改动可以接&#10;数据库迁移不要动，先问我">' + esc(ruleText) + '</textarea></label>'
    if (!editing) html += '<p class="dsh-int-hint" data-role="binding-rules-hint">留空就用机器人或部署的默认规则。</p>'
    html += '<div class="dsh-int-form-foot"><button class="dsh-int-btn" type="button" data-act="form-cancel">取消</button>'
    html += '<button class="dsh-int-btn primary" type="button" data-act="binding-save">' + (editing ? '保存修改' : '绑定') + '</button></div>'
    html += '</div>'
    return html
  }

  function field(name) {
    var node = inner.querySelector('[name="' + name + '"]')
    return node ? String(node.value || '').trim() : ''
  }

  function checked(name) {
    var node = inner.querySelector('[name="' + name + '"]')
    return node ? node.checked === true : false
  }

  function ruleList(name) {
    return field(name || 'rules').split('\\n').map(function (line) { return line.trim() }).filter(function (line) { return line !== '' })
  }

  /** 选好机器人后，把它的默认规则条数直接写出来，免得人去猜。 */
  function refreshBindingHints() {
    var channel = channelOf(field('channelId'))
    var rulesHost = inner.querySelector('[data-role="binding-rules-hint"]')
    if (rulesHost) {
      var count = channel && Array.isArray(channel.defaultRules) ? channel.defaultRules.length : 0
      rulesHost.textContent = count > 0
        ? '留空就沿用这个机器人的 ' + count + ' 条默认规则；想只对这个群生效，直接写在这里。'
        : '这个机器人没设默认规则，留空就用部署默认的开发范围。'
    }
  }

  async function saveChannel() {
    var editing = state.editing ? channelOf(state.editing) : null
    var body = { name: field('name'), defaultRules: ruleList('defaultRules') }
    if (editing) {
      var secret = field('appSecret')
      if (secret !== '') body.appSecret = secret
    } else {
      body.appId = field('appId')
      body.appSecret = field('appSecret')
    }
    if (!editing && !body.appId) { state.error = '请填写 App ID。'; state.notice = ''; render(); return }
    if (!editing && !body.appSecret) { state.error = '请填写 App Secret。'; state.notice = ''; render(); return }
    try {
      var saved = await api(editing ? '/superagent/channels/' + encodeURIComponent(editing.id) : '/superagent/channels', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      state.error = ''
      if (editing) {
        state.form = ''
        state.editing = ''
        state.notice = '机器人已更新，连接会自动重连。'
      } else {
        // 新机器人先别让人再点一次：直接进「新增绑定」，自动列出它所在的群。
        state.form = 'binding'
        state.editing = ''
        state.presetChannel = saved && saved.id ? saved.id : ''
        state.notice = '机器人已添加，连接会在几秒内建立；下面勾选它已经在的群就能开始接活。'
      }
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      state.notice = ''
      render()
    }
  }

  async function saveBinding() {
    var editing = state.editing ? bindingOf(state.editing) : null
    var body = {
      workspaceId: field('workspaceId'),
      chatName: field('chatName'),
      repo: field('repo'),
      autoMerge: checked('autoMerge'),
      rules: ruleList(),
    }
    if (!editing) {
      body.channelId = field('channelId')
      body.externalChatId = field('externalChatId')
      if (!body.channelId) { state.error = '先选一个机器人。'; state.notice = ''; render(); return }
      if (!body.externalChatId) { state.error = '请填写群 ID（oc_ 开头）。'; state.notice = ''; render(); return }
    }
    if (!body.workspaceId) { state.error = '请选择一块工作区。'; state.notice = ''; render(); return }
    try {
      await api(editing ? '/superagent/bindings/' + encodeURIComponent(editing.id) : '/superagent/bindings', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      state.form = ''
      state.editing = ''
      state.presetChannel = ''
      resetChats()
      state.error = ''
      state.notice = editing ? '绑定已更新。' : '绑定好了：在群里 @ 机器人说清楚要做什么就能开工。'
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      state.notice = ''
      render()
    }
  }

  /** 换机器人、关表单或绑定完成后清掉上一次的群列表和错误，免得串到下一个。 */
  function resetChats() {
    state.chats = []
    state.chatsChannel = ''
    state.chatsError = ''
  }

  /**
   * 进入「新增绑定」或换机器人时自动拉群；已经有这个机器人的结果就直接复用，
   * 重画表单后也不会把列表弄丢，更不会每渲染一次就请求一次飞书。
   */
  function syncChats() {
    if (state.form !== 'binding' || state.editing) return
    var channelId = field('channelId')
    if (!channelId) return
    if (state.chatsChannel === channelId) { renderChatList(); return }
    void loadChats()
  }

  /** 用机器人自己的凭证向飞书要群列表；结果填进表单里的占位块，不重画整个表单。 */
  async function loadChats() {
    var host = document.getElementById('dsh-int-chats')
    var channelId = field('channelId')
    if (!host) return
    if (!channelId) {
      host.innerHTML = '<p class="dsh-int-hint">先选一个机器人。</p>'
      return
    }
    host.innerHTML = '<p class="dsh-int-hint">正在向飞书拉取群列表…</p>'
    try {
      var data = await api('/superagent/channels/' + encodeURIComponent(channelId) + '/chats')
      // 等待期间可能换了机器人或关了表单；旧结果不覆盖新界面。
      if (field('channelId') !== channelId) return
      state.chats = data && Array.isArray(data.items) ? data.items : []
      state.chatsChannel = channelId
      state.chatsError = ''
    } catch (cause) {
      if (field('channelId') !== channelId) return
      state.chats = []
      state.chatsChannel = channelId
      state.chatsError = chatsError(cause)
    }
    renderChatList()
  }

  /** 拉群失败的提示要能让成员照着做：多半是权限没开。 */
  function chatsError(cause) {
    var text = messageOf(cause)
    if (text.indexOf('feishu-chats-failed') === 0) {
      return '飞书没让拉群列表。确认 App ID / Secret 正确，并给应用开通「获取群组信息」权限（im:chat:readonly）后重试。'
    }
    return text
  }

  function renderChatList() {
    var host = document.getElementById('dsh-int-chats')
    if (!host) return
    if (state.chatsError) {
      host.innerHTML = '<div class="dsh-int-notice error">' + esc(state.chatsError) + '</div>'
      return
    }
    if (state.chats.length === 0) {
      host.innerHTML = '<p class="dsh-int-hint">这个机器人还没被拉进任何群。先在飞书里把它加进群，再回来拉一次；也可以在上面手填群 ID。</p>'
      return
    }
    // 已经绑过的群只标出来，不再重复勾选。
    var bound = {}
    for (var b = 0; b < state.bindings.length; b += 1) {
      if (state.bindings[b].channelId === state.chatsChannel) bound[state.bindings[b].externalChatId] = true
    }
    var html = '<div class="dsh-int-chatlist">'
    for (var i = 0; i < state.chats.length; i += 1) {
      var chat = state.chats[i]
      var isBound = bound[chat.id] === true
      html += '<label class="dsh-int-chat' + (isBound ? ' off' : '') + '">'
      html += '<input type="checkbox" name="chatPick" value="' + esc(chat.id) + '" data-chat-name="' + esc(chat.name) + '"' + (isBound ? ' disabled' : '') + '>'
      html += '<span class="dsh-int-chat-name" title="' + esc(chat.id) + '">' + esc(chat.name) + '</span>'
      html += '<span class="dsh-int-chip">' + (isBound ? '已绑定' : chat.mode === 'topic' ? '话题群' : '群') + '</span></label>'
    }
    html += '</div><div class="dsh-int-chatfoot"><button class="dsh-int-btn primary small" type="button" data-act="chats-bind">绑定选中的群</button></div>'
    host.innerHTML = html
  }

  /** 勾中的群共用表单里的工作区、仓库和规则，一次绑完。 */
  async function bindPicked() {
    var workspaceId = field('workspaceId')
    if (!workspaceId) { state.error = '请选择一块工作区。'; state.notice = ''; render(); return }
    var boxes = inner.querySelectorAll('input[name="chatPick"]')
    var picked = []
    for (var i = 0; i < boxes.length; i += 1) {
      if (boxes[i].disabled !== true && boxes[i].checked === true) {
        picked.push({ id: boxes[i].value, name: boxes[i].getAttribute('data-chat-name') || '' })
      }
    }
    if (picked.length === 0) { state.error = '先勾选要绑定的群。'; state.notice = ''; render(); return }
    var base = {
      channelId: field('channelId'),
      workspaceId: workspaceId,
      repo: field('repo'),
      autoMerge: checked('autoMerge'),
      rules: ruleList(),
    }
    var done = 0
    var failed = []
    for (var j = 0; j < picked.length; j += 1) {
      try {
        await api('/superagent/bindings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({}, base, { externalChatId: picked[j].id, chatName: picked[j].name })),
        })
        done += 1
      } catch (cause) {
        failed.push(picked[j].name + '：' + messageOf(cause))
      }
    }
    if (failed.length > 0) {
      state.error = '绑好了 ' + done + ' 个群；这些没成功——' + failed.join('；')
      state.notice = ''
      render()
      return
    }
    state.form = ''
    state.editing = ''
    state.presetChannel = ''
    resetChats()
    state.error = ''
    state.notice = '绑好了 ' + done + ' 个群：在群里 @ 机器人就能开工。'
    await load()
  }

  tabs.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-tab]') : null
    if (!target) return
    var tab = target.getAttribute('data-tab') || ''
    if (state.tab === tab) return
    state.tab = tab
    state.form = ''
    state.editing = ''
    state.presetChannel = ''
    resetChats()
    state.notice = ''
    state.error = ''
    render()
  })

  inner.addEventListener('change', function (event) {
    var target = event.target
    if (!(target instanceof Element) || target.getAttribute('name') !== 'channelId') return
    refreshBindingHints()
    // 换机器人就重拉群：旧列表不能留在新表单上误导人。
    resetChats()
    syncChats()
  })

  inner.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    var act = target.getAttribute('data-act') || ''
    var id = target.getAttribute('data-id') || ''
    if (act === 'form-cancel') {
      state.form = ''
      state.editing = ''
      state.presetChannel = ''
      resetChats()
      render()
      return
    }
    if (act === 'channel-new') {
      state.form = 'channel'
      state.editing = ''
      state.presetChannel = ''
      resetChats()
      state.notice = ''
      render()
      return
    }
    if (act === 'channel-edit') {
      state.form = 'channel'
      state.editing = id
      state.presetChannel = ''
      resetChats()
      state.notice = ''
      render()
      return
    }
    if (act === 'channel-bind') {
      // 从机器人卡片直接进「新增绑定」，选中这个机器人并自动列出它的群。
      state.form = 'binding'
      state.editing = ''
      state.presetChannel = id
      resetChats()
      state.notice = ''
      state.error = ''
      render()
      return
    }
    if (act === 'binding-new') {
      if (state.channels.length === 0) {
        state.error = '先添加一个飞书机器人，再绑定群。'
        state.notice = ''
        render()
        return
      }
      state.form = 'binding'
      state.editing = ''
      state.presetChannel = ''
      resetChats()
      state.notice = ''
      render()
      return
    }
    if (act === 'binding-edit') {
      state.form = 'binding'
      state.editing = id
      state.presetChannel = ''
      resetChats()
      state.notice = ''
      render()
      return
    }
    if (act === 'channel-save') { void saveChannel(); return }
    if (act === 'binding-save') { void saveBinding(); return }
    if (act === 'chats-load') { void loadChats(); return }
    if (act === 'chats-bind') { void bindPicked(); return }
    if (act === 'channel-toggle') {
      var channel = channelOf(id)
      if (!channel) return
      void api('/superagent/channels/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: channel.status === 'active' ? 'disabled' : 'active' }),
      }).then(function () { return load() }).catch(function (cause) {
        state.error = messageOf(cause)
        render()
      })
      return
    }
    if (act === 'channel-remove') {
      if (!window.confirm('删除这个机器人后，群里就不再响应，绑定的工单也会一起删除。确定吗？')) return
      void api('/superagent/channels/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        state.notice = '机器人已删除。'
        return load()
      }).catch(function (cause) {
        state.error = messageOf(cause)
        render()
      })
      return
    }
    if (act === 'binding-remove') {
      if (!window.confirm('解绑后这个群不再响应，已产生的工单也会一起删除。确定吗？')) return
      void api('/superagent/bindings/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        state.notice = '已解绑。'
        return load()
      }).catch(function (cause) {
        state.error = messageOf(cause)
        render()
      })
    }
  })

  function mount() {
    if (root.parentElement !== document.body) document.body.appendChild(root)
  }

  function open() {
    mount()
    root.hidden = false
    root.dataset.open = 'true'
    root.setAttribute('aria-hidden', 'false')
    state.form = ''
    state.editing = ''
    state.presetChannel = ''
    resetChats()
    state.notice = ''
    render()
    void load()
  }

  function close() {
    root.hidden = true
    root.dataset.open = 'false'
    root.setAttribute('aria-hidden', 'true')
  }

  document.getElementById('dsh-int-close').addEventListener('click', close)
  document.addEventListener('click', function (event) {
    if (root.dataset.open !== 'true') return
    var target = event.target
    if (!(target instanceof Element)) return
    if (root.contains(target)) return
    close()
  }, true)
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || root.dataset.open !== 'true') return
    if (state.form) { state.form = ''; state.editing = ''; state.presetChannel = ''; resetChats(); render(); return }
    close()
  })
  new MutationObserver(function () {
    if (root.dataset.open === 'true' && !root.isConnected) mount()
  }).observe(document.body, { childList: true, subtree: true })

  window.__dshIntegrationsOpen = open
  window.__dshIntegrationsClose = close
})()
</script>
</div>`
}
