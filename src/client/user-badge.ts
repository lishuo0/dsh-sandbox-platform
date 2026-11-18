/**
 * 客户端左下角的登录身份条。
 *
 * DSH 客户端没有账号入口，平台从 `/auth/me` 取姓名和角色。
 * 点头像弹出账号菜单：设置打开官方设置右侧页，再在设置里进「通用设置 / 模型」；
 * 退出登录也在菜单里。Skills / MCP 是左侧菜单的一级入口，不放在这里。
 */

const ME = '/dsh-api/platform/v1/auth/me'

const SETTINGS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>`

const LOGOUT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h3.5A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 16l4-4-4-4"/><path d="M14 12H3"/></svg>`

export function userBadge(): string {
  return `<div id="dsh-account" style="display:none" data-fixed="false" data-rail="false">
<style>
#dsh-account{position:relative;box-sizing:border-box;width:100%;padding:6px 4px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#0f1115;text-align:left}
#dsh-account[data-fixed="true"]{position:fixed;left:0;bottom:0;z-index:2147483646;width:280px;padding:10px 12px 14px}
#dsh-account[data-rail="true"]{padding:6px 0}
#dsh-account[data-rail="true"] #dsh-account-trigger{width:36px;height:36px;padding:0;margin:0 auto;justify-content:center}
#dsh-account[data-rail="true"] .dsh-acct-ident{display:none}
#dsh-account button{font:inherit;color:inherit;margin:0}
#dsh-account-trigger{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px 6px 6px;border:0;border-radius:12px;background:transparent;cursor:pointer;text-align:left}
#dsh-account-trigger:hover,#dsh-account-trigger[aria-expanded="true"]{background:rgba(15,17,21,.06)}
#dsh-account .dsh-acct-avatar{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0f1115;color:#fff;font-size:13px;font-weight:600;flex:none;overflow:hidden;user-select:none}
#dsh-account .dsh-acct-ident{display:flex;flex-direction:column;min-width:0;line-height:1.2;gap:1px}
#dsh-account .dsh-acct-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-account .dsh-acct-role{font-size:11px;color:#8a8f98;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-account-menu{display:none;position:absolute;left:0;right:0;bottom:calc(100% + 6px);width:auto;box-sizing:border-box;padding:8px;border-radius:12px;border:1px solid rgba(15,17,21,.07);background:#fff;box-shadow:0 10px 28px rgba(15,17,21,.16),0 2px 6px rgba(15,17,21,.06)}
#dsh-account[data-rail="true"] #dsh-account-menu{left:0;right:auto;width:220px}
#dsh-account-menu[data-open="true"]{display:block}
#dsh-account .dsh-acct-row{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:#0f1115;font-size:13px;line-height:1.3;cursor:pointer;text-align:left}
#dsh-account .dsh-acct-row:hover{background:rgba(15,17,21,.06)}
#dsh-account .dsh-acct-row svg{width:16px;height:16px;flex:none;opacity:.78}
#dsh-account .dsh-acct-row-danger{color:#c0392b}
@media (prefers-color-scheme: dark){
#dsh-account{color:#f3f4f6}
#dsh-account-trigger:hover,#dsh-account-trigger[aria-expanded="true"],#dsh-account .dsh-acct-row:hover{background:rgba(255,255,255,.08)}
#dsh-account .dsh-acct-avatar{background:#f3f4f6;color:#0f1115}
#dsh-account .dsh-acct-role{color:#9aa0a6}
#dsh-account-menu{background:#1c1d21;border-color:rgba(255,255,255,.08);box-shadow:0 10px 28px rgba(0,0,0,.45)}
#dsh-account .dsh-acct-row{color:#f3f4f6}
#dsh-account .dsh-acct-row-danger{color:#ff8a80}
}
</style>
<button id="dsh-account-trigger" type="button" aria-expanded="false" aria-haspopup="menu" title="账号">
<span id="dsh-account-avatar" class="dsh-acct-avatar" aria-hidden="true"></span>
<span class="dsh-acct-ident"><span id="dsh-account-name" class="dsh-acct-name"></span><span id="dsh-account-role" class="dsh-acct-role"></span></span>
</button>
<div id="dsh-account-menu" role="menu" data-open="false">
<button id="dsh-account-settings" class="dsh-acct-row" type="button" role="menuitem">${SETTINGS_ICON}<span>设置</span></button>
<button id="dsh-account-logout" class="dsh-acct-row dsh-acct-row-danger" type="button" role="menuitem">${LOGOUT_ICON}<span>退出登录</span></button>
</div>
</div>
<script>
(async () => {
  const root = document.getElementById('dsh-account')
  const trigger = document.getElementById('dsh-account-trigger')
  const menu = document.getElementById('dsh-account-menu')
  const DEFAULT_SIDEBAR = 280

  const sidebarEl = () => document.querySelector('[class*="sidebarCol"]')
  const footArea = () => document.querySelector('[class*="footArea"]')

  const visibleSidebarWidth = () => {
    const col = sidebarEl()
    if (!col) return DEFAULT_SIDEBAR
    const box = col.getBoundingClientRect()
    if (box.width <= 0 || box.right <= 0) return 0
    return Math.round(box.right)
  }

  // 侧栏的 footArea 在会话滚动区之外。挂进去后列表只滚自己的区域，会话再多也
  // 不会卷到头像底下；没有这个槽位时才退回 fixed 浮层。
  const mountIntoFootArea = () => {
    const foot = footArea()
    if (foot) {
      if (root.parentElement !== foot) foot.prepend(root)
      root.dataset.fixed = 'false'
      return
    }
    if (root.parentElement !== document.body) document.body.append(root)
    root.dataset.fixed = 'true'
  }

  const syncSidebarWidth = () => {
    const width = visibleSidebarWidth()
    mountIntoFootArea()
    document.documentElement.style.setProperty('--dsh-platform-sidebar-width', width + 'px')
    if (root.dataset.fixed === 'true') root.style.width = Math.max(width, DEFAULT_SIDEBAR) + 'px'
    root.dataset.rail = width > 0 && width <= 120 ? 'true' : 'false'
  }

  const setMenuOpen = (open) => {
    menu.dataset.open = open ? 'true' : 'false'
    trigger.setAttribute('aria-expanded', String(open))
  }

  const settingsPanel = () => document.querySelector('[data-shortcut-modal="settings"]')

  const openSettings = () => {
    const opener = document.querySelector('[class*="_settingsArea"] button')
    if (!opener) return
    if (!settingsPanel()) opener.click()
    syncSidebarWidth()
  }

  const closeSettings = () => {
    const panel = settingsPanel()
    if (!panel) return
    const closeBtn = [...panel.querySelectorAll('button')].find((button) =>
      String(button.className).includes('close') || (button.textContent || '').includes('关闭'))
    closeBtn?.click()
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    setMenuOpen(menu.dataset.open !== 'true')
  })
  document.getElementById('dsh-account-settings').addEventListener('click', (event) => {
    event.stopPropagation()
    setMenuOpen(false)
    openSettings()
  })
  document.getElementById('dsh-account-logout').addEventListener('click', async (event) => {
    event.stopPropagation()
    setMenuOpen(false)
    try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    location.href = '/'
  })
  document.addEventListener('click', (event) => {
    setMenuOpen(false)
    // 设置是右侧页而不是全屏遮罩：左侧菜单点完后关掉设置，否则主区仍被盖住像没反应。
    // 用冒泡阶段，等侧栏自己的 click 先处理完再关。
    const panel = settingsPanel()
    if (!panel) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (panel.contains(target) || root.contains(target)) return
    closeSettings()
  })
  // 聊天流式输出会持续改 DOM；按帧合并，避免每次变更都量一次侧栏。
  let syncFrame = 0
  const scheduleSync = () => {
    if (syncFrame) return
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0
      syncSidebarWidth()
    })
  }
  window.addEventListener('resize', scheduleSync)
  const watch = new MutationObserver(scheduleSync)
  watch.observe(document.body, { childList: true, subtree: true })

  const watchSidebar = () => {
    const col = sidebarEl()
    if (!col || typeof ResizeObserver === 'undefined') return
    new ResizeObserver(scheduleSync).observe(col)
  }

  try {
    const response = await fetch(${JSON.stringify(ME)}, { credentials: 'same-origin' })
    if (!response.ok) return
    const body = await response.json()
    const data = body && body.data
    const userId = data && typeof data.userId === 'string' ? data.userId : ''
    let name = data && typeof data.displayName === 'string' ? data.displayName.trim() : ''
    if (!name) name = userId
    if (!name) return
    const role = data && data.role === 'admin' ? '管理员' : data && data.role === 'member' ? '成员' : ''
    const initial = Array.from(name)[0] || '?'
    document.getElementById('dsh-account-name').textContent = name
    document.getElementById('dsh-account-avatar').textContent = initial
    document.getElementById('dsh-account-role').textContent = role
    if (!role) document.getElementById('dsh-account-role').style.display = 'none'
    syncSidebarWidth()
    watchSidebar()
    root.style.display = 'block'
  } catch {}
})()
</script>`
}
