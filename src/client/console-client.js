/* 平台配置页的浏览器端逻辑。由 console.ts 内联进外壳页面。 */
(() => {
  const root = document.getElementById('dsh-console')
  if (!root || root.dataset.ready === '1') return
  root.dataset.ready = '1'

  const API = '/dsh-api/platform/v1'
  const ME = `${API}/auth/me`

  const MESSAGES = {
    'skill-required': '请填写描述和 SKILL.md',
    'invalid-skill-name': '名称只能用小写字母、数字和连字符',
    'invalid-name': '名称只能用小写字母、数字和连字符',
    'invalid-url': 'MCP 地址必须以 https:// 开头',
    'invalid-header': '请求头名称只能包含字母、数字和连字符',
    'invalid-path': '文件路径不合法',
    'name-taken': '这个名字已被占用',
    'admin-only': '只有管理员可以管理公开内容',
    'invalid-password': '当前密码不正确',
    'password-too-short': '密码至少 6 位',
    'username-taken': '登录名已被占用',
    'invalid-username': '登录名只允许字母、数字和 . _ -',
    'cannot-disable-self': '不能停用自己',
    'cannot-demote-self': '不能取消自己的管理员角色',
    'last-admin': '至少要保留一个启用状态的管理员',
    'missing-secret': '保留密钥时找不到原密钥，请重新填写',
    'file-too-large': '单个文件不能超过 32 MiB',
    'skill-too-large': '技能文件总量不能超过 64 MiB',
    'object-store-unconfigured': '对象存储尚未配置',
    'not-found': '找不到这条记录',
    'unauthorized': '登录已失效，请重新登录',
  }

  const state = {
    view: 'skills',
    items: [],
    loading: false,
    busy: false,
    error: '',
    form: null,
    pending: [],
    existing: [],
    removed: [],
    fileListEl: null,
    saveButton: null,
    listScroll: 0,
    /** 开户 / 重置密码后的一次性提示（含初始密码，只显示这一次）。 */
    notice: '',
    page: 1,
    pageSize: 20,
    total: 0,
    sandboxUser: '',
    sandboxState: '',
    userQuery: '',
    userRole: '',
    userStatus: '',
  }

  let me = { id: '', role: 'member' }
  let mePromise = null

  const bodyEl = document.getElementById('dsh-console-body')
  const errorEl = document.getElementById('dsh-console-error')
  const noticeEl = document.getElementById('dsh-console-notice')
  const titleEl = document.getElementById('dsh-console-title')
  const subtitleEl = document.getElementById('dsh-console-subtitle')
  const createButton = document.getElementById('dsh-console-create')
  const refreshButton = document.getElementById('dsh-console-refresh')
  const saveButton = document.getElementById('dsh-console-save')
  const returnButton = document.getElementById('dsh-console-return')
  const backButton = document.getElementById('dsh-console-back')
  const navEl = document.getElementById('dsh-console-nav')
  const mainEl = document.querySelector('#dsh-console .admin-page-main')
  state.saveButton = saveButton

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else if (key === 'dataset') Object.assign(node.dataset, value)
        else if (key === 'hidden') node.hidden = Boolean(value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  function field(label, control) {
    return el('label', null, el('span', { text: label }), control)
  }

  // 左侧菜单入口：插进 DSH 自带的面板导航，和「新建会话」下面的面板行同级。
  // 清单由服务端注入（console-views.ts），adminOnly 的项只在管理员身份下出现。
  const SIDEBAR_MENU = __CONSOLE_VIEWS__
  let railObserver = null

  function iconNode(kind) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      svg.append(node)
    }
    if (kind === 'skills') {
      add('path', { d: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z' })
      add('path', { d: 'M8 3v18M11 8h5M11 12h4' })
    } else if (kind === 'users') {
      add('circle', { cx: '9', cy: '8', r: '3.2' })
      add('path', { d: 'M3.5 19.5c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2' })
      add('path', { d: 'M16 5.2a3 3 0 0 1 0 5.6M17.5 14.6c2.2.6 3.5 2.3 3.5 4.9' })
    } else if (kind === 'sandbox') {
      add('path', { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z' })
      add('path', { d: 'M12 12l8-4.5M12 12v9M12 12L4 7.5' })
    } else {
      add('rect', { x: '3', y: '4', width: '18', height: '6', rx: '1.5' })
      add('rect', { x: '3', y: '14', width: '18', height: '6', rx: '1.5' })
      add('path', { d: 'M7 7h.01M7 17h.01' })
    }
    return svg
  }

  function syncMenuActive() {
    for (const button of document.querySelectorAll('#dsh-console-menu [data-console-view], #dsh-console-nav [data-console-view]')) {
      const active = root.dataset.open === 'true' && button.dataset.consoleView === state.view
      button.classList.toggle('active', active)
      if (active) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }

  function syncSidebarRail() {
    const menu = document.getElementById('dsh-console-menu')
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    if (!menu || !sidebar) return
    const width = sidebar.getBoundingClientRect().width
    // 侧栏收成图标栏时只留图标，和自带面板行一致。
    menu.classList.toggle('dsh-rail', width > 0 && width < 120)
    syncMenuActive()
  }

  /** 当前身份能打开的视图（含头像菜单里的「管理」子菜单）。 */
  function visibleEntries() {
    return SIDEBAR_MENU.filter((entry) => entry.adminOnly !== true || me.role === 'admin')
  }

  /** 侧栏一级菜单只放 Skills / MCP，管理员视图在头像菜单的「管理」里。 */
  function menuEntries() {
    return visibleEntries().filter((entry) => entry.menu === 'sidebar')
  }

  /** 「管理」页左栏只列头像菜单里的管理视图（用户 / 沙箱），Skills / MCP 不在里面。 */
  function panelEntries() {
    return visibleEntries().filter((entry) => entry.menu === 'account')
  }

  function installSidebarMenu(rebuild) {
    const existing = document.getElementById('dsh-console-menu')
    if (existing && rebuild !== true) {
      syncSidebarRail()
      return true
    }
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    const nav = sidebar && (sidebar.querySelector('[class*="panelList"]') || sidebar.querySelector('nav'))
    if (!nav) return false
    if (existing) existing.remove()
    const menu = el('div', { id: 'dsh-console-menu' })
    for (const entry of menuEntries()) {
      const button = el('button', {
        type: 'button',
        'data-console-view': entry.view,
        'aria-label': entry.label,
      }, iconNode(entry.icon), el('span', { class: 'label', text: entry.label }))
      button.addEventListener('click', () => {
        if (!state.busy) void open(entry.view)
      })
      menu.append(button)
    }
    nav.prepend(menu)
    syncSidebarRail()
    if (railObserver === null && typeof ResizeObserver !== 'undefined') {
      railObserver = new ResizeObserver(syncSidebarRail)
      railObserver.observe(sidebar)
    }
    return true
  }

  /** 设置页同款左栏导航：只列用户 / 沙箱，点一行切一页。 */
  function renderPanelNav() {
    if (!navEl) return
    navEl.textContent = ''
    for (const entry of panelEntries()) {
      const button = el('button', {
        type: 'button',
        role: 'tab',
        'data-console-view': entry.view,
        'aria-label': entry.label,
      }, iconNode(entry.icon), el('span', { class: 'label', text: entry.label }))
      button.addEventListener('click', () => {
        if (!state.busy) void setView(entry.view)
      })
      navEl.append(button)
    }
    syncMenuActive()
  }

  // 先按当前身份画一版；拿到 /auth/me 之后再补管理员入口。
  void loadMe().then(() => installSidebarMenu(true))
  // React 会重画侧栏；入口丢了自己补回去，其余时间不做任何事。
  let menuCheck = false
  const menuObserver = new MutationObserver(() => {
    if (menuCheck) return
    menuCheck = true
    requestAnimationFrame(() => {
      menuCheck = false
      if (!document.getElementById('dsh-console-menu')) installSidebarMenu()
      // 客户端重画 DOM 时把节点丢掉了：还开着就挂回 body。
      if (root.dataset.open === 'true' && !root.isConnected) mountConsole()
    })
  })
  menuObserver.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', syncSidebarRail)

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function ownerName(item) {
    return item.ownerDisplayName || item.owner_display_name || ''
  }

  function canEdit(item) {
    return item.mine === true || (item.scope === 'public' && me.role === 'admin')
  }

  async function loadMe() {
    if (me.id) return me
    if (!mePromise) {
      mePromise = fetch(ME, { credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) return me
          const body = await response.json()
          const data = body && body.data
          if (data && typeof data.userId === 'string') {
            me = { id: data.userId, role: data.role === 'admin' ? 'admin' : 'member' }
          }
          return me
        })
        .catch(() => me)
        .finally(() => { mePromise = null })
    }
    return mePromise
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {})
    if (typeof options.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const response = await fetch(API + path, { ...options, headers, credentials: 'same-origin' })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch {}
    if (!response.ok || (body && body.code !== 0)) {
      const code = body && typeof body.msg === 'string' ? body.msg : ''
      throw new Error(MESSAGES[code] || code || `请求失败（${response.status}）`)
    }
    return body ? body.data : null
  }

  async function apiText(path) {
    const response = await fetch(API + path, { credentials: 'same-origin' })
    const text = await response.text()
    if (!response.ok) {
      let code = ''
      try { code = JSON.parse(text).msg || '' } catch {}
      throw new Error(MESSAGES[code] || code || `请求失败（${response.status}）`)
    }
    return text
  }

  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function renderError() {
    if (state.error) {
      errorEl.hidden = false
      errorEl.textContent = state.error
    } else {
      errorEl.hidden = true
      errorEl.textContent = ''
    }
  }

  // 列表页和新建 / 编辑页共用同一块中间栏：表单打开时列表整个让位，
  // 页头也跟着换成表单标题和「返回 / 保存」，不再在网格上方叠一张卡片。
  const VIEW_HEAD = {
    skills: {
      title: 'Skills 管理',
      subtitle: '创建自己的技能，或把技能公开给所有成员。公开人人可用，私有只有自己可用。',
      create: '＋ 新建 Skill',
    },
    mcp: {
      title: 'MCP 管理',
      subtitle: '接入 HTTP MCP server；密钥由平台加密保存，脑侧按需解密。',
      create: '＋ 新建 MCP',
    },
    users: {
      title: '用户管理',
      subtitle: '添加成员账号、重置密码、停用或调整角色。新账号首次登录必须修改初始密码。',
      create: '＋ 新建用户',
    },
    sandboxes: {
      title: '沙箱',
      subtitle: '只读排障：显示共享库里最后一次已知状态，平台不直连 E2B，也不读会话内容。',
      create: '',
    },
  }

  function syncHeader() {
    const form = state.form
    returnButton.hidden = !form
    refreshButton.hidden = Boolean(form)
    refreshButton.disabled = state.loading
    if (form) {
      createButton.hidden = true
      // 用户新建 / 编辑 / 重置密码：主按钮放在表单底部，顶栏不再放「创建」。
      const userForm = form.kind === 'user' || form.kind === 'user-reset'
      saveButton.hidden = userForm
      if (form.kind === 'user-reset') {
        titleEl.textContent = `重置密码 · ${form.id}`
        subtitleEl.textContent = '为该成员设置新登录密码；不是修改你自己的账号密码。'
      } else if (form.kind === 'user') {
        titleEl.textContent = form.mode === 'create' ? '新建用户' : `编辑用户 · ${form.id}`
        subtitleEl.textContent = form.mode === 'create'
          ? '初始密码留空会自动生成；填写时至少 6 位。成员首次登录必须修改。'
          : '登录名不可修改；可以调整显示名、角色和启用状态。'
      } else {
        const skills = state.view === 'skills'
        titleEl.textContent = form.mode === 'create'
          ? (skills ? '新建 Skill' : '新建 MCP')
          : (skills ? `编辑 Skill · ${form.name}` : `编辑 MCP · ${form.name}`)
        subtitleEl.textContent = skills
          ? '保存后连同附加文件一起发布到沙箱，下一步会话即可使用。'
          : '只支持 streamable-http；保存后下一步会话会挂上它的工具。'
        saveButton.textContent = form.mode === 'create' ? '＋ 创建' : '保存'
        saveButton.disabled = state.busy
      }
      return
    }
    saveButton.hidden = true
    const head = VIEW_HEAD[state.view] || VIEW_HEAD.skills
    titleEl.textContent = head.title
    subtitleEl.textContent = head.subtitle
    createButton.hidden = head.create === ''
    createButton.textContent = head.create
  }

  function renderNotice() {
    if (state.notice) {
      noticeEl.hidden = false
      noticeEl.textContent = state.notice
    } else {
      noticeEl.hidden = true
      noticeEl.textContent = ''
    }
  }

  function render() {
    renderError()
    renderNotice()
    syncHeader()
    bodyEl.replaceChildren()
    if (state.form) {
      if (state.form.kind === 'user-reset') bodyEl.append(renderResetPasswordForm())
      else if (state.form.kind === 'user') bodyEl.append(renderUserForm())
      else bodyEl.append(renderForm())
      return
    }
    if (state.view === 'users') {
      if (!state.loading && state.items.length === 0) {
        bodyEl.append(emptyState())
        return
      }
      bodyEl.append(renderUserToolbar())
      bodyEl.append(state.loading && state.items.length === 0
        ? el('div', { class: 'admin-state', text: '加载中…' })
        : renderUserTable())
      return
    }
    if (state.view === 'sandboxes') {
      // 筛选条始终保留：空结果 / 加载中也不能把上面的操作栏弄没。
      bodyEl.append(renderSandboxToolbar())
      if (state.loading && state.items.length === 0) {
        bodyEl.append(el('div', { class: 'admin-state', text: '加载中…' }))
      } else if (!state.loading && state.items.length === 0) {
        bodyEl.append(emptyState())
      } else {
        bodyEl.append(renderSandboxTable(), renderPager())
      }
      return
    }
    if (state.loading && state.items.length === 0) {
      bodyEl.append(el('div', { class: 'admin-state', text: '加载中…' }))
      return
    }
    if (!state.loading && state.items.length === 0) {
      bodyEl.append(emptyState())
      return
    }
    bodyEl.append(renderGrid())
  }

  function emptyState() {
    if (state.view === 'users') {
      return el('div', { class: 'admin-state empty' },
        el('h2', { text: '还没有成员' }),
        el('p', { text: '新建一个成员账号，把初始密码转交给他；首次登录会要求改密。' }),
        el('button', {
          class: 'admin-button primary',
          type: 'button',
          onclick: () => openUserForm('create'),
        }, '＋ 新建用户'))
    }
    if (state.view === 'sandboxes') {
      return el('div', { class: 'admin-state empty' },
        el('h2', { text: '没有匹配的沙箱' }),
        el('p', { text: '沙箱注册表还没有写入，或当前过滤条件没有结果。' }))
    }
    const skills = state.view === 'skills'
    return el('div', { class: 'admin-state empty' },
      el('h2', { text: skills ? '还没有 Skills' : '还没有 MCP' }),
      el('p', {
        text: skills
          ? '创建自己的技能，或由管理员公开给所有成员。'
          : '接入一个 HTTP MCP server，会话下一步就会挂上它的工具。',
      }),
      el('button', {
        class: 'admin-button primary',
        type: 'button',
        onclick: () => openForm('create'),
      }, skills ? '＋ 新建 Skill' : '＋ 新建 MCP'),
    )
  }

  const AVATAR_COLORS = ['#8b5cf6', '#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4']

  function avatarLetter(name) {
    return (String(name).trim().charAt(0) || 'S').toUpperCase()
  }

  function avatarColor(name) {
    let hash = 0
    for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return AVATAR_COLORS[hash % AVATAR_COLORS.length]
  }

  function formatDate(value) {
    if (typeof value !== 'string' || value === '') return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value.slice(0, 10)
    const pad = (part) => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  function visibilityIcon(kind) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '13')
    svg.setAttribute('height', '13')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('aria-hidden', 'true')
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      svg.append(node)
    }
    if (kind === 'public') {
      add('circle', { cx: '12', cy: '12', r: '9' })
      add('path', { d: 'M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18' })
    } else {
      add('rect', { x: '5', y: '10', width: '14', height: '10', rx: '2' })
      add('path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' })
    }
    return svg
  }

  function cardAction(label, className, onclick) {
    const node = el('span', {
      class: className,
      role: 'button',
      tabindex: '0',
      text: label,
    })
    const run = (event) => {
      event.stopPropagation()
      onclick()
    }
    node.addEventListener('click', run)
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        run(event)
      }
    })
    return node
  }

  function cardOf(item) {
    const skills = state.view === 'skills'
    const editable = canEdit(item)
    const owner = ownerName(item)
    const avatar = el('span', { class: 'dsh-card-avatar', text: avatarLetter(item.name) })
    avatar.style.background = avatarColor(item.name)
    const secondary = skills
      ? `修订 r${item.revision}`
      : (item.timeoutMs ? `超时 ${item.timeoutMs} ms` : '默认超时')
    const meta = el('div', { class: 'dsh-card-meta' },
      el('span', { text: owner ? `由 ${owner} 创建` : '创建者未知' }),
      el('span', { text: item.enabled ? `更新于 ${formatDate(skills ? item.updated_at : item.updatedAt)}` : '已停用' }))
    const foot = el('div', { class: 'dsh-card-foot' }, meta)
    if (editable) {
      const actions = el('div', { class: 'dsh-card-actions' },
        cardAction(item.enabled ? '停用' : '启用', 'dsh-card-toggle', () => void toggleItem(item)),
        cardAction('删除', 'dsh-card-delete', () => void removeItem(item)))
      foot.append(actions)
    } else {
      foot.append(el('span', { class: 'admin-hint', text: '只读' }))
    }

    const card = el('button', {
      class: `dsh-card${editable ? '' : ' readonly'}${item.enabled === false ? ' off' : ''}`,
      type: 'button',
    },
    el('div', { class: 'dsh-card-top' },
      avatar,
      el('div', { class: 'dsh-card-identity' },
        el('strong', { text: item.name }),
        el('span', { text: secondary })),
      el('span', {
        class: `dsh-card-visibility${item.scope === 'public' ? '' : ' private'}`,
      }, visibilityIcon(item.scope === 'public' ? 'public' : 'private'),
      item.scope === 'public' ? '公开' : '仅自己')),
    el('p', {
      class: 'dsh-card-desc',
      text: (skills ? item.description : item.url) || '暂无说明',
    }),
    foot)
    if (editable) card.addEventListener('click', () => void editItem(item))
    return card
  }

  function renderGrid() {
    const grid = el('div', { class: 'dsh-card-grid' })
    for (const item of state.items) grid.append(cardOf(item))
    return grid
  }

  // ── 用户管理 ──────────────────────────────────────────────────────────

  function badge(text, extra) {
    return el('span', { class: `admin-badge${extra ? ` ${extra}` : ''}`, text })
  }

  function filteredUsers() {
    const q = state.userQuery.trim().toLowerCase()
    return state.items.filter((member) => {
      if (state.userRole && member.role !== state.userRole) return false
      if (state.userStatus && member.status !== state.userStatus) return false
      if (q === '') return true
      return String(member.id).toLowerCase().includes(q)
        || String(member.displayName || '').toLowerCase().includes(q)
    })
  }

  function renderUserToolbar() {
    const wrap = el('div', { class: 'admin-toolbar' })
    const query = el('input', {
      type: 'search',
      placeholder: '搜索登录名 / 显示名',
      value: state.userQuery,
      oninput: (event) => { state.userQuery = event.target.value; render() },
    })
    const role = el('select', {
      onchange: (event) => { state.userRole = event.target.value; render() },
    })
    for (const [value, label] of [['', '全部角色'], ['admin', '管理员'], ['member', '成员']]) {
      role.append(el('option', { value }, label))
    }
    role.value = state.userRole
    const status = el('select', {
      onchange: (event) => { state.userStatus = event.target.value; render() },
    })
    for (const [value, label] of [['', '全部状态'], ['active', '启用'], ['disabled', '停用']]) {
      status.append(el('option', { value }, label))
    }
    status.value = state.userStatus
    wrap.append(
      query,
      role,
      status,
      el('button', {
        class: 'admin-button small',
        type: 'button',
        onclick: () => {
          state.userQuery = ''
          state.userRole = ''
          state.userStatus = ''
          render()
        },
      }, '清除'),
    )
    return wrap
  }

  function renderUserTable() {
    const rows = filteredUsers()
    if (rows.length === 0) {
      return el('div', { class: 'admin-state empty' },
        el('h2', { text: state.items.length === 0 ? '还没有成员' : '没有匹配的成员' }),
        el('p', { text: state.items.length === 0
          ? '新建一个成员账号，把初始密码转交给他；首次登录会要求改密。'
          : '试试清空筛选条件，或换个关键字。' }))
    }
    const table = el('table', { class: 'admin-table' })
    const head = el('tr')
    for (const label of ['登录名', '显示名', '角色', '状态', '创建时间', '操作']) head.append(el('th', { text: label }))
    table.append(el('thead', null, head))
    const body = el('tbody')
    for (const member of rows) body.append(userRow(member))
    table.append(body)
    return el('div', { class: 'admin-table-wrap' }, table)
  }

  function userRow(member) {
    const self = member.id === me.id
    const actions = el('div', { class: 'row-actions' },
      cardAction('编辑', '', () => openUserForm('edit', member)))
    // 重置密码是管理员给「该成员」设新口令，不是改自己的；自己走头像菜单「修改密码」。
    if (!self) {
      actions.append(cardAction('重置密码', '', () => openResetPasswordForm(member)))
      actions.append(cardAction(
        member.role === 'admin' ? '设为成员' : '设为管理员',
        '',
        () => void changeRole(member, member.role === 'admin' ? 'member' : 'admin'),
      ))
      actions.append(cardAction(
        member.status === 'active' ? '停用' : '启用',
        member.status === 'active' ? 'danger' : '',
        () => void toggleStatus(member),
      ))
    } else {
      actions.append(el('span', { class: 'admin-hint', text: '当前账号' }))
    }
    return el('tr', null,
      el('td', { class: 'mono', text: member.id }),
      el('td', { text: member.displayName }),
      el('td', null, badge(member.role === 'admin' ? '管理员' : '成员', member.role === 'admin' ? 'admin' : '')),
      el('td', null, badge(member.status === 'active' ? '启用' : '停用', member.status === 'active' ? '' : 'off')),
      el('td', { text: formatDate(member.createdAt) }),
      el('td', null, actions))
  }

  function openResetPasswordForm(member) {
    state.error = ''
    state.notice = ''
    state.listScroll = mainEl ? mainEl.scrollTop : 0
    state.form = {
      kind: 'user-reset',
      id: member.id,
      displayName: member.displayName,
      password: '',
    }
    render()
    const first = bodyEl.querySelector('input:not([disabled])')
    if (first) first.focus()
  }

  function renderResetPasswordForm() {
    const form = state.form
    const section = el('section', { class: 'admin-card' })
    const grid = el('div', { class: 'admin-grid' })
    grid.append(field('成员登录名', el('input', { value: form.id, disabled: true })))
    grid.append(field('显示名', el('input', { value: form.displayName, disabled: true })))
    grid.append(field('新密码', el('input', {
      type: 'text',
      value: form.password,
      placeholder: '留空自动生成；至少 6 位',
      autocomplete: 'new-password',
      oninput: (event) => { form.password = event.target.value },
    })))
    section.append(grid)
    section.append(el('p', {
      class: 'admin-hint',
      text: `这是重置成员「${form.displayName}」的登录密码，不是改你自己的账号。旧密码立即失效；对方下次登录必须先改密。`,
    }))
    section.append(el('div', { class: 'admin-form-actions' },
      el('button', {
        class: 'admin-button primary',
        type: 'button',
        disabled: state.busy,
        onclick: () => void save(),
      }, state.busy ? '处理中…' : '确认重置')))
    return section
  }

  async function saveResetPassword() {
    const form = state.form
    const password = form.password.trim()
    if (password !== '' && password.length < 6) throw new Error('密码至少 6 位')
    const result = await api(`/admin/users/${encodeURIComponent(form.id)}/password`, {
      method: 'POST',
      body: JSON.stringify(password === '' ? {} : { password }),
    })
    state.notice = `已重置成员 ${form.id} 的密码。新密码：${result.initialPassword}（只显示这一次，请转交本人）`
    state.form = null
    await load()
  }

  async function toggleStatus(member) {
    if (state.busy) return
    const next = member.status === 'active' ? 'disabled' : 'active'
    if (next === 'disabled' && !window.confirm(`停用「${member.displayName}」？该账号会立即下线且不能再登录。`)) return
    state.busy = true
    state.error = ''
    try {
      await api(`/admin/users/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      state.notice = next === 'disabled' ? `已停用 ${member.id}。` : `已启用 ${member.id}。`
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      render()
    } finally {
      state.busy = false
    }
  }

  async function changeRole(member, role) {
    if (state.busy) return
    const label = role === 'admin' ? '管理员' : '成员'
    if (!window.confirm(`把「${member.displayName}」的角色改为${label}？`)) return
    state.busy = true
    state.error = ''
    try {
      await api(`/admin/users/${encodeURIComponent(member.id)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      })
      state.notice = `已把 ${member.id} 的角色改为${label}。`
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      render()
    } finally {
      state.busy = false
    }
  }

  function openUserForm(mode, member) {
    state.error = ''
    state.notice = ''
    state.listScroll = mainEl ? mainEl.scrollTop : 0
    state.form = {
      kind: 'user',
      mode,
      id: member ? member.id : '',
      displayName: member ? member.displayName : '',
      role: member ? member.role : 'member',
      status: member ? member.status : 'active',
      password: '',
    }
    render()
    const first = bodyEl.querySelector('input:not([disabled])')
    if (first) first.focus()
  }

  function renderUserForm() {
    const form = state.form
    const section = el('section', { class: 'admin-card' })
    const grid = el('div', { class: 'admin-grid' })
    grid.append(field('登录名', el('input', {
      value: form.id,
      placeholder: 'ivy',
      disabled: form.mode === 'edit',
      oninput: (event) => { form.id = event.target.value },
    })))
    grid.append(field('显示名', el('input', {
      value: form.displayName,
      placeholder: '不填就用登录名',
      oninput: (event) => { form.displayName = event.target.value },
    })))
    const role = el('select', { onchange: (event) => { form.role = event.target.value === 'admin' ? 'admin' : 'member' } })
    role.append(el('option', { value: 'member' }, '成员'), el('option', { value: 'admin' }, '管理员'))
    role.value = form.role
    grid.append(field('角色', role))
    if (form.mode === 'create') {
      grid.append(field('初始密码', el('input', {
        type: 'text',
        value: form.password,
        placeholder: '留空自动生成；至少 6 位',
        autocomplete: 'new-password',
        oninput: (event) => { form.password = event.target.value },
      })))
    } else {
      const status = el('select', { onchange: (event) => { form.status = event.target.value === 'disabled' ? 'disabled' : 'active' } })
      status.append(el('option', { value: 'active' }, '启用'), el('option', { value: 'disabled' }, '停用'))
      status.value = form.status
      status.disabled = form.id === me.id
      grid.append(field('状态', status))
    }
    section.append(grid)
    section.append(el('p', {
      class: 'admin-hint',
      text: '密码至少 6 位。开户或重置成员密码后，该成员首次登录必须修改密码。',
    }))
    section.append(el('div', { class: 'admin-form-actions' },
      el('button', {
        class: 'admin-button primary',
        type: 'button',
        disabled: state.busy,
        onclick: () => void save(),
      }, state.busy ? '处理中…' : (form.mode === 'create' ? '＋ 创建用户' : '保存'))))
    return section
  }

  async function saveUser() {
    const form = state.form
    const displayName = form.displayName.trim()
    if (form.mode === 'create') {
      const username = form.id.trim()
      if (username === '') throw new Error('请填写登录名')
      const payload = { username, role: form.role }
      if (displayName !== '') payload.displayName = displayName
      const password = form.password.trim()
      if (password !== '') {
        if (password.length < 6) throw new Error('密码至少 6 位')
        payload.password = password
      }
      const created = await api('/admin/users', { method: 'POST', body: JSON.stringify(payload) })
      state.notice = created.initialPassword
        ? `已创建 ${created.member.id}。初始密码：${created.initialPassword}（只显示这一次，请转交本人）`
        : `已创建 ${created.member.id}。请提醒本人首次登录后修改密码。`
      state.form = null
    } else {
      await api(`/admin/users/${encodeURIComponent(form.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName, role: form.role, status: form.status }),
      })
      state.notice = `已保存 ${form.id} 的资料。`
      state.form = null
    }
    await load()
  }

  // ── 沙箱（只读） ──────────────────────────────────────────────────────

  function renderSandboxToolbar() {
    const wrap = el('div', { class: 'admin-toolbar' })
    const user = el('input', {
      type: 'search',
      placeholder: '按成员登录名筛选',
      value: state.sandboxUser,
      oninput: (event) => { state.sandboxUser = event.target.value },
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          state.page = 1
          void load()
        }
      },
    })
    const picker = el('select', {
      onchange: (event) => {
        state.sandboxState = event.target.value
        state.page = 1
        void load()
      },
    })
    for (const [value, label] of [
      ['', '全部状态'],
      ['creating', '创建中'],
      ['ready', '就绪'],
      ['paused', '已暂停'],
      ['killed', '已销毁'],
    ]) picker.append(el('option', { value }, label))
    picker.value = state.sandboxState
    wrap.append(
      user,
      picker,
      el('button', {
        class: 'admin-button small',
        type: 'button',
        onclick: () => { state.page = 1; void load() },
      }, '查询'),
      el('button', {
        class: 'admin-button small',
        type: 'button',
        onclick: () => {
          state.sandboxUser = ''
          state.sandboxState = ''
          state.page = 1
          void load()
        },
      }, '清除'),
    )
    return wrap
  }

  function renderSandboxTable() {
    const table = el('table', { class: 'admin-table' })
    const head = el('tr')
    for (const label of ['沙箱 ID', '归属', '工作区', '会话', '范围', '平台', '状态', 'Endpoint', '最近使用', '过期']) {
      head.append(el('th', { text: label }))
    }
    table.append(el('thead', null, head))
    const body = el('tbody')
    for (const item of state.items) {
      const owner = item.user_display_name
        ? `${item.user_display_name}（${item.user_id}）`
        : item.user_id
      body.append(el('tr', null,
        el('td', { class: 'mono', text: item.sandbox_id }),
        el('td', { text: owner }),
        el('td', { text: item.workspace_name || item.workspace_id || '—' }),
        el('td', { class: 'mono', text: item.session_id || '—' }),
        el('td', { text: item.scope }),
        el('td', { text: item.platform }),
        el('td', null, badge(item.state, item.state === 'ready' ? '' : 'off')),
        el('td', { class: 'mono wrap', text: item.endpoint || '—' }),
        el('td', { text: formatDate(item.last_used_at) }),
        el('td', { text: formatDate(item.expires_at) })))
    }
    table.append(body)
    return el('div', { class: 'admin-table-wrap' }, table)
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize))
    const prev = el('button', {
      class: 'admin-button small',
      type: 'button',
      disabled: state.page <= 1,
      onclick: () => { if (state.page > 1) { state.page -= 1; void load() } },
    }, '上一页')
    const next = el('button', {
      class: 'admin-button small',
      type: 'button',
      disabled: state.page >= pages,
      onclick: () => { if (state.page < pages) { state.page += 1; void load() } },
    }, '下一页')
    return el('div', { class: 'admin-pager' },
      el('span', { text: `共 ${state.total} 条 · 第 ${state.page} / ${pages} 页` }),
      prev,
      next)
  }

  function clearFiles() {
    state.pending = []
    state.existing = []
    state.removed = []
    state.fileListEl = null
  }

  function relativeSkillPath(file) {
    const relative = file.webkitRelativePath || ''
    const parts = (relative !== '' ? relative : file.name).split('/').filter((part) => part !== '' && part !== '.')
    if (relative !== '' && parts.length > 1) parts.shift()
    return parts.join('/')
  }

  function addFiles(list) {
    if (list === null) return
    const entries = []
    for (const file of Array.from(list)) {
      const path = relativeSkillPath(file)
      if (path === '' || path === 'SKILL.md') continue
      entries.push({ path, size: file.size, file })
    }
    if (entries.length === 0) return
    for (const entry of entries) {
      const index = state.pending.findIndex((item) => item.path === entry.path)
      if (index >= 0) state.pending[index] = entry
      else state.pending.push(entry)
    }
    state.pending.sort((left, right) => left.path.localeCompare(right.path))
    state.removed = state.removed.filter((path) => !entries.some((entry) => entry.path === path))
  }

  function renderFiles() {
    const list = state.fileListEl
    if (!list) return
    list.replaceChildren()
    if (state.existing.length === 0 && state.pending.length === 0) {
      list.append(el('p', { class: 'skill-files-empty', text: '还没有附加文件。只含 SKILL.md 的技能可以直接保存。' }))
      return
    }
    for (const entry of state.existing) {
      const removed = state.removed.includes(entry.path)
      list.append(el('div', { class: removed ? 'skill-file-row removed' : 'skill-file-row' },
        el('code', { text: entry.path }),
        el('span', { text: formatBytes(entry.bytes) }),
        removed
          ? el('button', {
            class: 'admin-button small',
            type: 'button',
            onclick: () => {
              state.removed = state.removed.filter((path) => path !== entry.path)
              renderFiles()
            },
          }, '撤销删除')
          : el('button', {
            class: 'admin-button small danger',
            type: 'button',
            onclick: () => {
              state.removed = [...state.removed, entry.path]
              renderFiles()
            },
          }, '移除')))
    }
    for (const entry of state.pending) {
      list.append(el('div', { class: 'skill-file-row' },
        el('code', { text: entry.path }),
        el('span', { text: formatBytes(entry.size) }),
        el('button', {
          class: 'admin-button small danger',
          type: 'button',
          onclick: () => {
            state.pending = state.pending.filter((item) => item.path !== entry.path)
            renderFiles()
          },
        }, '移除')))
    }
  }

  function filesField() {
    const picker = el('input', { type: 'file', multiple: true, hidden: true })
    picker.addEventListener('change', () => {
      addFiles(picker.files)
      picker.value = ''
      renderFiles()
    })
    const folder = el('input', { type: 'file', multiple: true, hidden: true })
    folder.setAttribute('webkitdirectory', '')
    folder.setAttribute('directory', '')
    folder.addEventListener('change', () => {
      addFiles(folder.files)
      folder.value = ''
      renderFiles()
    })
    const list = el('div', { class: 'skill-file-list' })
    state.fileListEl = list
    renderFiles()
    return el('div', { class: 'skill-files' },
      el('div', { class: 'skill-files-head' },
        el('span', { text: '技能文件' }),
        el('span', { class: 'admin-hint', text: '脚本、引用等会随 SKILL.md 发布到沙箱；单文件 ≤32 MiB，总量 ≤64 MiB。' }),
        el('div', { class: 'skill-files-actions' },
          el('button', { class: 'admin-button small', type: 'button', onclick: () => picker.click() }, '＋ 选择文件'),
          el('button', { class: 'admin-button small', type: 'button', onclick: () => folder.click() }, '＋ 选择文件夹'))),
      picker,
      folder,
      list)
  }

  function renderForm() {
    const skills = state.view === 'skills'
    const form = state.form
    const section = el('section', { class: 'admin-card' })

    const grid = el('div', { class: 'admin-grid' })
    grid.append(field('名称', el('input', {
      value: form.name,
      placeholder: skills ? 'my-skill' : 'github',
      disabled: form.mode === 'edit',
      oninput: (event) => { form.name = event.target.value },
    })))
    if (skills) {
      grid.append(field('描述', el('input', {
        value: form.description,
        placeholder: '帮助模型判断何时使用',
        oninput: (event) => { form.description = event.target.value },
      })))
    } else {
      grid.append(field('URL', el('input', {
        value: form.url,
        placeholder: 'https://mcp.example.com/mcp',
        oninput: (event) => { form.url = event.target.value },
      })))
      grid.append(field('工具调用超时（毫秒）', el('input', {
        type: 'number',
        min: '1000',
        step: '1000',
        value: String(form.timeoutMs),
        oninput: (event) => { form.timeoutMs = Number(event.target.value) || 60000 },
      })))
    }
    const visibility = el('select', {
      onchange: (event) => { form.scope = event.target.value === 'public' ? 'public' : 'private' },
    })
    visibility.append(el('option', { value: 'private' }, '仅自己可见'))
    if (me.role === 'admin') visibility.append(el('option', { value: 'public' }, '全员可见'))
    visibility.value = form.scope
    visibility.disabled = form.mode === 'edit'
    grid.append(field('可见性', visibility))
    section.append(grid)

    if (skills) {
      section.append(el('label', { class: 'admin-field' },
        el('span', { text: 'SKILL.md' }),
        el('textarea', {
          class: 'skill-md',
          oninput: (event) => { form.content = event.target.value },
        }, form.content)))
      section.append(filesField())
    } else {
      section.append(el('label', { class: 'admin-field' },
        el('span', { text: 'Headers（JSON；密钥用 secret 字段，保留原密钥用 keepSecret）' }),
        el('textarea', {
          placeholder: '{\n  "Authorization": { "secret": "" }\n}',
          oninput: (event) => { form.headersText = event.target.value },
        }, form.headersText)))
    }

    return section
  }

  function openForm(mode) {
    state.error = ''
    clearFiles()
    state.listScroll = mainEl ? mainEl.scrollTop : 0
    state.form = state.view === 'skills'
      ? {
        mode,
        name: '',
        description: '',
        content: '---\nname: my-skill\ndescription: \n---\n\n',
        scope: 'private',
      }
      : {
        mode,
        name: '',
        url: '',
        timeoutMs: 60000,
        headersText: '{\n  "Authorization": { "secret": "" }\n}',
        scope: 'private',
      }
    render()
    const first = bodyEl.querySelector('input')
    if (first) first.focus()
  }

  function closeForm() {
    state.form = null
    state.error = ''
    clearFiles()
    render()
    // 回到列表时停在离开前的位置，避免滚动条跳回顶部。
    if (mainEl) mainEl.scrollTop = state.listScroll
  }

  async function editItem(item) {
    state.error = ''
    state.listScroll = mainEl ? mainEl.scrollTop : 0
    try {
      const query = `?scope=${encodeURIComponent(item.scope)}`
      if (state.view === 'skills') {
        const detail = await api(`/skills/${encodeURIComponent(item.name)}${query}`)
        const content = await apiText(`/skills/${encodeURIComponent(item.name)}/file?path=SKILL.md&scope=${encodeURIComponent(item.scope)}`)
        state.existing = (detail.files || [])
          .filter((file) => file.path !== 'SKILL.md')
          .map((file) => ({ path: file.path, bytes: file.bytes }))
        state.removed = []
        state.pending = []
        state.form = {
          mode: 'edit',
          name: detail.name,
          description: detail.description,
          content,
          scope: detail.scope,
        }
      } else {
        const detail = await api(`/mcp-servers/${encodeURIComponent(item.name)}${query}`)
        const headers = {}
        for (const header of detail.headers || []) {
          headers[header.name] = header.secret ? { keepSecret: true } : { value: header.value || '' }
        }
        clearFiles()
        state.form = {
          mode: 'edit',
          name: detail.name,
          url: detail.url,
          timeoutMs: detail.timeoutMs || 60000,
          headersText: Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '',
          scope: detail.scope,
        }
      }
      render()
    } catch (cause) {
      state.error = messageOf(cause)
      renderError()
    }
  }

  function parseHeaders(text) {
    const trimmed = text.trim()
    if (trimmed === '') return {}
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('Headers 必须是合法 JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Headers 必须是 JSON 对象')
    }
    const headers = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Header ${name} 必须是 { secret } / { value } / { keepSecret }`)
      }
      headers[name] = value
    }
    return headers
  }

  async function saveSkill() {
    const form = state.form
    const name = form.name.trim()
    if (name === '') throw new Error('请填写名称')
    if (form.description.trim() === '') throw new Error('请填写描述')
    if (form.content.trim() === '') throw new Error('请填写 SKILL.md')
    if (form.mode === 'create') {
      await api('/skills', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: form.description.trim(),
          skillMd: form.content,
          scope: form.scope,
        }),
      })
    } else {
      await api(`/skills/${encodeURIComponent(form.name)}?scope=${encodeURIComponent(form.scope)}`, {
        method: 'PUT',
        body: JSON.stringify({ description: form.description.trim(), skillMd: form.content }),
      })
    }
    for (const entry of state.pending) {
      await api(`/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(entry.path)}&scope=${encodeURIComponent(form.scope)}`, {
        method: 'POST',
        body: entry.file,
        headers: { 'content-type': entry.file.type || 'application/octet-stream' },
      })
    }
    for (const path of state.removed) {
      await api(`/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(form.scope)}`, {
        method: 'DELETE',
      })
    }
  }

  async function saveMcp() {
    const form = state.form
    const name = form.name.trim()
    if (name === '') throw new Error('请填写名称')
    const url = form.url.trim()
    if (!url.startsWith('https://')) throw new Error('MCP 地址必须以 https:// 开头')
    const headers = parseHeaders(form.headersText)
    const timeoutMs = Number.isFinite(form.timeoutMs) && form.timeoutMs > 0 ? Math.round(form.timeoutMs) : undefined
    const payload = { url, headers, timeoutMs }
    if (form.mode === 'create') {
      await api('/mcp-servers', {
        method: 'POST',
        body: JSON.stringify({ name, scope: form.scope, ...payload }),
      })
    } else {
      await api(`/mcp-servers/${encodeURIComponent(form.name)}?scope=${encodeURIComponent(form.scope)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
    }
  }

  async function save() {
    if (state.busy) return
    state.busy = true
    state.error = ''
    state.notice = ''
    if (state.saveButton) {
      state.saveButton.disabled = true
      state.saveButton.textContent = '保存中…'
    }
    try {
      // 用户相关表单自己会关表单并重新拉列表，别在这里再走 skills/mcp 收尾。
      if (state.form && state.form.kind === 'user') {
        await saveUser()
        return
      }
      if (state.form && state.form.kind === 'user-reset') {
        await saveResetPassword()
        return
      }
      if (state.view === 'skills') await saveSkill()
      else await saveMcp()
      closeForm()
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      renderError()
    } finally {
      state.busy = false
      if (state.saveButton && state.saveButton.isConnected) {
        state.saveButton.disabled = false
        syncHeader()
      }
    }
  }

  async function toggleItem(item) {
    state.error = ''
    try {
      const base = state.view === 'skills' ? '/skills/' : '/mcp-servers/'
      await api(`${base}${encodeURIComponent(item.name)}/${item.enabled ? 'disable' : 'enable'}?scope=${encodeURIComponent(item.scope)}`, {
        method: 'POST',
      })
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      renderError()
    }
  }

  async function removeItem(item) {
    const label = state.view === 'skills' ? `技能「${item.name}」` : `MCP「${item.name}」`
    if (!window.confirm(`删除${label}？`)) return
    state.error = ''
    try {
      const base = state.view === 'skills' ? '/skills/' : '/mcp-servers/'
      await api(`${base}${encodeURIComponent(item.name)}?scope=${encodeURIComponent(item.scope)}`, { method: 'DELETE' })
      state.form = null
      clearFiles()
      await load()
    } catch (cause) {
      state.error = messageOf(cause)
      renderError()
    }
  }

  async function load() {
    state.loading = true
    render()
    try {
      if (state.view === 'users') {
        const members = await api('/admin/users')
        state.items = Array.isArray(members) ? members : []
      } else if (state.view === 'sandboxes') {
        const params = new URLSearchParams()
        params.set('page', String(state.page))
        params.set('page_size', String(state.pageSize))
        const userId = state.sandboxUser.trim()
        if (userId !== '') params.set('user_id', userId)
        if (state.sandboxState !== '') params.set('state', state.sandboxState)
        const page = await api(`/admin/sandboxes?${params.toString()}`)
        state.items = Array.isArray(page?.items) ? page.items : []
        state.total = Number(page?.total) || 0
        state.page = Number(page?.page) || 1
        state.pageSize = Number(page?.page_size) || state.pageSize
      } else {
        const items = await api(state.view === 'skills' ? '/skills' : '/mcp-servers')
        state.items = Array.isArray(items) ? items : []
      }
      state.error = ''
    } catch (cause) {
      state.error = messageOf(cause)
      state.items = []
    } finally {
      state.loading = false
      render()
    }
  }

  /** 未知视图或当前身份看不到的视图一律退回 Skills，和服务端 resolveConsoleView 对齐。 */
  function resolveView(raw) {
    // 头像菜单的「管理」入口不走侧栏，所以按全部可见视图解析，别只看 menuEntries。
    const match = visibleEntries().find((entry) => entry.view === raw)
    return match ? match.view : 'skills'
  }

  async function setView(view) {
    state.view = resolveView(view)
    state.form = null
    state.page = 1
    state.notice = ''
    // 先清掉上一页的行，别在加载期间把成员对象塞进沙箱表格或反之。
    state.items = []
    state.total = 0
    clearFiles()
    syncMenuActive()
    await load()
  }

  /** 用户 / 沙箱是「管理」页；Skills / MCP 是各自独立的整页。 */
  function scopeOf(view) {
    return view === 'users' || view === 'sandboxes' ? 'admin' : 'tool'
  }

  // 和设置页一样挂在 body 上，靠 CSS 的 sidebar-width inset 留出左侧菜单。
  function mountConsole() {
    if (root.parentElement !== document.body) document.body.appendChild(root)
  }

  async function open(view) {
    await loadMe()
    const target = resolveView(view)
    root.dataset.scope = scopeOf(target)
    mountConsole()
    root.hidden = false
    root.dataset.open = 'true'
    root.setAttribute('aria-hidden', 'false')
    renderPanelNav()
    await setView(target)
  }

  function close() {
    root.hidden = true
    root.dataset.open = 'false'
    root.setAttribute('aria-hidden', 'true')
    syncMenuActive()
  }

  backButton.addEventListener('click', close)
  // 和设置页一样：点到整页之外（左侧会话列表、菜单、头像等）就返回对话，
  // 但这次点击本身照常交给客户端处理，别把左侧菜单吞掉。
  // 自己的侧栏入口（Skills / MCP）例外，它们要在页内切换视图。
  document.addEventListener('click', (event) => {
    if (root.dataset.open !== 'true') return
    const target = event.target
    if (!(target instanceof Element)) return
    if (root.contains(target)) return
    if (target.closest('#dsh-console-menu')) return
    close()
  }, true)
  refreshButton.addEventListener('click', () => {
    if (!state.busy) void load()
  })
  createButton.addEventListener('click', () => {
    if (state.view === 'users') openUserForm('create')
    else void openForm('create')
  })
  saveButton.addEventListener('click', () => void save())
  returnButton.addEventListener('click', closeForm)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || root.dataset.open !== 'true') return
    // 表单页的 Esc 只退回列表，和「返回列表」一致；列表页才关整个面板。
    if (state.form) {
      event.preventDefault()
      closeForm()
      return
    }
    close()
  })
  window.__dshConsoleOpen = (view) => {
    void open(view)
  }
  window.__dshConsoleClose = close
})()
