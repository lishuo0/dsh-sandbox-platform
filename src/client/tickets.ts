/**
 * 「工单任务」整页：左侧菜单一级入口，钉在侧栏右侧。
 *
 * 这里只看自己的工单：从群里接的活、现在跑到哪一步、结论是什么。
 * 「完成 / 停止」把话题从占用状态里放出来，群里能接着接新活。
 * 和定时任务（自动化任务）不是一回事，所以单开一个菜单。
 */

export function ticketsPage(): string {
  return `<div id="dsh-tickets" hidden data-open="false">
<style>
/* 左侧菜单入口，插进客户端自带的面板导航；rail 时只留图标。 */
#dsh-tickets-menu{display:flex;flex-direction:column;gap:2px;margin-bottom:2px}
#dsh-tickets-menu button{display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,8px);min-height:32px;margin:0;padding:5px calc(var(--dsh-sidebar-row-padding,10px) - var(--dsh-sidebar-paint-inset,3px));box-sizing:border-box;border:0;border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;border-radius:var(--dsw-radius-md,10px);background:transparent;background-clip:padding-box;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;line-height:22px;text-align:left;cursor:pointer}
#dsh-tickets-menu button:hover,#dsh-tickets-menu button.active{background-color:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}
#dsh-tickets-menu button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#0969da);outline-offset:-2px}
#dsh-tickets-menu svg{flex:none;width:16px;height:16px}
#dsh-tickets-menu .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-tickets-menu.dsh-rail{gap:12px;margin-bottom:12px}
#dsh-tickets-menu.dsh-rail button{width:36px;height:36px;min-height:0;justify-content:center;padding:0;border-inline:0}
#dsh-tickets-menu.dsh-rail .label{display:none}
/* 和设置页同一套钉法：fixed 铺满侧栏右侧，不盖左侧菜单。 */
#dsh-tickets{--t-bg:#fff;--t-fg:#111827;--t-muted:#6e7781;--t-border:#e5e7eb;--t-border-strong:#d0d7de;--t-hover:#eef1f5;--t-primary:#111827;--t-primary-fg:#fff;--t-accent:#0969da;--t-error:#d1242f;--t-success:#1a7f37;--t-warn:#9a6700;position:fixed;inset:0 0 0 var(--dsh-platform-sidebar-width,280px);z-index:900;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,var(--t-bg));color:var(--t-fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;text-align:left}
#dsh-tickets[hidden]{display:none!important}
#dsh-tickets *{box-sizing:border-box}
#dsh-tickets button,#dsh-tickets input{font:inherit}
#dsh-tickets-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:calc(20px + var(--dsh-frame-top-clearance,0px)) clamp(20px,4vw,40px) 12px;border-bottom:1px solid var(--t-border)}
#dsh-tickets-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
#dsh-tickets-head p{margin:5px 0 0;color:var(--t-muted);font-size:12.5px}
#dsh-tickets-head .dsh-tickets-tools{display:flex;gap:8px;flex:none}
#dsh-tickets-filters{display:flex;flex-wrap:wrap;gap:6px;padding:12px clamp(20px,4vw,40px) 0}
#dsh-tickets-filters button{height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--t-border);background:var(--t-bg);color:var(--t-muted);font-size:12px;cursor:pointer}
#dsh-tickets-filters button:hover{background:var(--t-hover)}
#dsh-tickets-filters button.active{background:var(--t-primary);border-color:var(--t-primary);color:var(--t-primary-fg)}
#dsh-tickets-body{flex:1;min-height:0;overflow:auto;padding:14px clamp(20px,4vw,40px) 40px}
#dsh-tickets-inner{display:flex;flex-direction:column;gap:10px;width:100%;max-width:1040px;margin:0 auto}
.dsh-t-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--t-border-strong);background:var(--t-bg);color:var(--t-fg);font-size:13px;cursor:pointer;white-space:nowrap}
.dsh-t-btn:hover:not(:disabled){background:var(--t-hover)}
.dsh-t-btn:disabled{opacity:.45;cursor:not-allowed}
.dsh-t-btn.small{height:28px;padding:0 9px;font-size:12px}
.dsh-t-btn.danger{color:var(--t-error)}
.dsh-t-btn.primary{background:var(--t-primary);border-color:var(--t-primary);color:var(--t-primary-fg)}
.dsh-ticket{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border:1px solid var(--t-border);border-radius:12px;background:var(--t-bg)}
.dsh-ticket-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}
.dsh-ticket-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:600}
.dsh-ticket-meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--t-muted);font-size:12px;word-break:break-all}
.dsh-ticket-note{margin:0;color:var(--t-fg);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dsh-ticket-note.muted{color:var(--t-muted)}
/* 列表只露出两行正文；长回复折叠，点「展开全文」再看完整内容。 */
.dsh-ticket-note.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-ticket-note.clamp.expanded{display:block;-webkit-line-clamp:unset;overflow:visible}
.dsh-t-note-toggle{align-self:flex-start;margin-top:-1px;padding:0;border:0;background:transparent;color:var(--t-accent);font-size:12px;line-height:1.5;cursor:pointer}
.dsh-t-note-toggle:hover{text-decoration:underline}
.dsh-ticket-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsh-t-stage{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:400;color:var(--t-muted);background:var(--t-hover)}
.dsh-t-stage[data-stage="accepted"]{color:var(--t-accent);background:color-mix(in srgb,var(--t-accent) 10%,transparent)}
.dsh-t-stage[data-stage="working"]{color:var(--t-accent);background:color-mix(in srgb,var(--t-accent) 10%,transparent)}
.dsh-t-stage[data-stage="review"]{color:var(--t-warn);background:color-mix(in srgb,var(--t-warn) 12%,transparent)}
.dsh-t-stage[data-stage="done"]{color:var(--t-success);background:color-mix(in srgb,var(--t-success) 10%,transparent)}
.dsh-t-stage[data-stage="failed"]{color:var(--t-error);background:color-mix(in srgb,var(--t-error) 10%,transparent)}
.dsh-t-empty,#dsh-tickets-error{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:150px;padding:24px;text-align:center;color:var(--t-muted);font-size:12.5px;border:1px dashed var(--t-border);border-radius:12px}
#dsh-tickets-error{align-items:flex-start;text-align:left;color:var(--t-error);border-color:color-mix(in srgb,var(--t-error) 35%,transparent);min-height:0;padding:12px 16px}
@media (prefers-color-scheme: dark){
#dsh-tickets{--t-bg:#161719;--t-fg:#f3f4f6;--t-muted:#9aa0a6;--t-border:rgba(255,255,255,.1);--t-border-strong:rgba(255,255,255,.18);--t-hover:rgba(255,255,255,.08);--t-primary:#f3f4f6;--t-primary-fg:#0f1115;--t-accent:#6cb6ff;--t-error:#ff8a80;--t-success:#5fd18b;--t-warn:#e3b341}
}
</style>
<div id="dsh-tickets-head">
<div><h1>工单任务</h1><p>群里接的活都在这里：做到哪一步、结论是什么。结束或停止后，话题就能继续接新活。</p></div>
<div class="dsh-tickets-tools">
<button class="dsh-t-btn" type="button" id="dsh-tickets-refresh">刷新</button>
<button class="dsh-t-btn" type="button" id="dsh-tickets-close">关闭</button>
</div>
</div>
<div id="dsh-tickets-filters"></div>
<div id="dsh-tickets-body"><div id="dsh-tickets-inner"></div></div>
<script>
(function () {
  var root = document.getElementById('dsh-tickets')
  var inner = document.getElementById('dsh-tickets-inner')
  var filters = document.getElementById('dsh-tickets-filters')
  var menuNode = null
  var railObserver = null
  var API = '/dsh-api/platform/v1'
  var STAGES = [
    { value: '', label: '全部' },
    { value: 'accepted', label: '待开工' },
    { value: 'working', label: '进行中' },
    { value: 'review', label: '已完成待确认' },
    { value: 'done', label: '已完成' },
    { value: 'failed', label: '失败' },
    { value: 'stopped', label: '已停止' }
  ]
  var LABELS = { accepted: '待开工', working: '进行中', review: '已完成待确认', done: '已完成', failed: '失败', stopped: '已停止' }
  var state = { items: [], stage: '', error: '', loading: false }

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

  function chatOf(threadKey) {
    var at = String(threadKey || '').indexOf(':')
    return at < 0 ? String(threadKey || '') : String(threadKey).slice(0, at)
  }

  function summaryOf(ticket) {
    var result = ticket.outcome && ticket.outcome.result ? ticket.outcome.result : null
    if (result && typeof result.summary === 'string' && result.summary !== '') return result.summary
    if (result && result.reason === 'error') return '执行失败'
    return ''
  }

  async function load() {
    state.loading = true
    state.error = ''
    render()
    try {
      var query = state.stage === '' ? '' : '?stage=' + encodeURIComponent(state.stage)
      var data = await api('/superagent/tickets' + query)
      state.items = data && Array.isArray(data.items) ? data.items : []
    } catch (cause) {
      state.error = messageOf(cause)
      state.items = []
    }
    state.loading = false
    render()
  }

  function renderFilters() {
    var html = ''
    for (var i = 0; i < STAGES.length; i += 1) {
      var entry = STAGES[i]
      html += '<button type="button" data-stage="' + esc(entry.value) + '"' + (state.stage === entry.value ? ' class="active"' : '') + '>' + esc(entry.label) + '</button>'
    }
    filters.innerHTML = html
  }

  function render() {
    renderFilters()
    if (state.error) {
      inner.innerHTML = '<div id="dsh-tickets-error">' + esc(state.error) + '</div>'
      return
    }
    if (state.loading && state.items.length === 0) {
      inner.innerHTML = '<div class="dsh-t-empty">正在加载…</div>'
      return
    }
    if (state.items.length === 0) {
      inner.innerHTML = '<div class="dsh-t-empty">' + (state.stage === '' ? '还没有工单。在群里 @ 机器人说清楚要做什么，它判断接活后就会出现在这里。' : '这个状态下没有工单。') + '</div>'
      return
    }
    var html = ''
    for (var i = 0; i < state.items.length; i += 1) {
      var ticket = state.items[i]
      var stage = LABELS[ticket.stage] ? ticket.stage : 'accepted'
      var open = ticket.stage === 'accepted' || ticket.stage === 'working' || ticket.stage === 'review'
      var summary = summaryOf(ticket)
      html += '<article class="dsh-ticket">'
      html += '<div class="dsh-ticket-main">'
      html += '<div class="dsh-ticket-title">' + esc(ticket.title) + '<span class="dsh-t-stage" data-stage="' + esc(stage) + '">' + esc(LABELS[stage]) + '</span>'
      if (ticket.autoMerge === true) html += '<span class="dsh-t-stage">自动合并</span>'
      html += '</div>'
      html += '<div class="dsh-ticket-meta">'
      html += '<span>群：' + esc(ticket.chatName || chatOf(ticket.threadKey)) + '</span>'
      html += '<span>机器人：' + esc(ticket.channelName || '') + '</span>'
      html += '<span>工作区：' + esc(ticket.workspaceName || '') + '</span>'
      html += '<span>创建：' + esc(when(ticket.createdAt)) + '</span>'
      if (open && ticket.updatedAt) html += '<span>更新：' + esc(when(ticket.updatedAt)) + '</span>'
      html += '</div>'
      if (summary !== '') {
        // 列表只给两行预览，长回复折起来；点「展开全文」看完整内容，避免一屏塞满正文。
        html += '<p class="dsh-ticket-note clamp" id="dsh-note-' + esc(ticket.id) + '">' + esc(summary) + '</p>'
        if (summary.length > 120 || summary.indexOf('\\n') >= 0) {
          html += '<button class="dsh-t-note-toggle" type="button" data-act="expand" data-id="' + esc(ticket.id) + '">展开全文</button>'
        }
      } else {
        html += '<p class="dsh-ticket-note muted">' + esc(ticket.scope || '') + '</p>'
      }
      // 已经做完、只等人确认：说明为什么还要点一下，避免以为它没结束。
      if (ticket.stage === 'review') html += '<p class="dsh-ticket-note muted">做完了，等你确认。确认后归档，这个话题才能继续接新活。</p>'
      html += '</div>'
      html += '<div class="dsh-ticket-actions">'
      if (open) {
        var doneLabel = ticket.stage === 'review' ? '确认完成' : '标记完成'
        html += '<button class="dsh-t-btn small primary" type="button" data-act="done" data-id="' + esc(ticket.id) + '">' + doneLabel + '</button>'
        // 待确认的单已经跑完了，没有可停的东西，别给一个会丢掉结果的按钮。
        if (ticket.stage !== 'review') {
          html += '<button class="dsh-t-btn small danger" type="button" data-act="stop" data-id="' + esc(ticket.id) + '" data-stage="' + esc(ticket.stage) + '">停止</button>'
        }
      }
      html += '</div></article>'
    }
    inner.innerHTML = html
  }

  async function closeTicket(id, stage) {
    try {
      await api('/superagent/tickets/' + encodeURIComponent(id) + '/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: stage }),
      })
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      render()
    }
  }

  inner.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!target) return
    var act = target.getAttribute('data-act') || ''
    var id = target.getAttribute('data-id') || ''
    if (act === 'expand') {
      var note = document.getElementById('dsh-note-' + id)
      if (!note) return
      var expanded = note.classList.toggle('expanded')
      target.textContent = expanded ? '收起' : '展开全文'
      return
    }
    if (act === 'done') {
      void closeTicket(id, 'done')
      return
    }
    if (act === 'stop') {
      var hint = target.getAttribute('data-stage') === 'working'
        ? '停止这张工单？正在跑的会话会被中止，群里会收到一句说明。'
        : '停止这张工单？群里会收到一句说明，这个话题随后可以继续接新活。'
      if (!window.confirm(hint)) return
      void closeTicket(id, 'stopped')
    }
  })

  filters.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-stage]') : null
    if (!target) return
    state.stage = target.getAttribute('data-stage') || ''
    void load()
  })

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>'

  // 定时任务（自动化任务）那一行：官方面板行是 div.panelEntry > button[aria-label=…]。
  function anchorOf(nav) {
    var rows = nav.querySelectorAll('button')
    for (var i = 0; i < rows.length; i += 1) {
      var label = (rows[i].getAttribute('aria-label') || rows[i].textContent || '').trim()
      if (label.indexOf('自动化') >= 0 || label.indexOf('定时任务') >= 0) {
        return rows[i].closest('[class*="panelEntry"]') || rows[i]
      }
    }
    return null
  }

  // 排在定时任务下面。它还没渲染出来时先放最前，等它出现再挪到后面。
  function placeMenu(nav) {
    var anchor = anchorOf(nav)
    if (!anchor) {
      if (menuNode.parentElement !== nav || nav.firstElementChild !== menuNode) nav.prepend(menuNode)
      return
    }
    var parent = anchor.parentElement || nav
    if (menuNode.parentElement === parent && menuNode.previousElementSibling === anchor) return
    parent.insertBefore(menuNode, anchor.nextSibling)
  }

  function installMenu() {
    var sidebar = document.querySelector('[class*="sidebarCol"]')
    var nav = sidebar && (sidebar.querySelector('[class*="panelList"]') || sidebar.querySelector('nav'))
    if (!nav) return false
    if (menuNode && menuNode.isConnected) {
      placeMenu(nav)
      syncRail()
      return true
    }
    if (menuNode) menuNode.remove()
    menuNode = document.createElement('div')
    menuNode.id = 'dsh-tickets-menu'
    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', '工单任务')
    button.innerHTML = ICON + '<span class="label">工单任务</span>'
    button.addEventListener('click', function () { open() })
    menuNode.append(button)
    placeMenu(nav)
    syncRail()
    if (railObserver === null && typeof ResizeObserver !== 'undefined') {
      railObserver = new ResizeObserver(syncRail)
      railObserver.observe(sidebar)
    }
    return true
  }

  function syncRail() {
    if (!menuNode) return
    var sidebar = document.querySelector('[class*="sidebarCol"]')
    var width = sidebar ? sidebar.getBoundingClientRect().width : 0
    menuNode.classList.toggle('dsh-rail', width > 0 && width < 120)
    var button = menuNode.querySelector('button')
    if (button) button.classList.toggle('active', root.dataset.open === 'true')
  }

  function mount() {
    if (root.parentElement !== document.body) document.body.appendChild(root)
  }

  function open() {
    mount()
    root.hidden = false
    root.dataset.open = 'true'
    root.setAttribute('aria-hidden', 'false')
    syncRail()
    render()
    void load()
  }

  function close() {
    root.hidden = true
    root.dataset.open = 'false'
    root.setAttribute('aria-hidden', 'true')
    syncRail()
  }

  document.getElementById('dsh-tickets-close').addEventListener('click', close)
  document.getElementById('dsh-tickets-refresh').addEventListener('click', function () { void load() })
  document.addEventListener('click', function (event) {
    if (root.dataset.open !== 'true') return
    var target = event.target
    if (!(target instanceof Element)) return
    if (root.contains(target)) return
    if (menuNode && menuNode.contains(target)) return
    close()
  }, true)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && root.dataset.open === 'true') close()
  })
  window.addEventListener('resize', syncRail)

  // React 会重画侧栏；入口丢了自己补回去。
  var checking = false
  new MutationObserver(function () {
    if (checking) return
    checking = true
    requestAnimationFrame(function () {
      checking = false
      if (!document.getElementById('dsh-tickets-menu')) installMenu()
      if (root.dataset.open === 'true' && !root.isConnected) mount()
    })
  }).observe(document.body, { childList: true, subtree: true })

  installMenu()
  window.__dshTicketsOpen = open
  window.__dshTicketsClose = close
})()
</script>
</div>`
}
