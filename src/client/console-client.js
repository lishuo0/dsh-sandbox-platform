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
  }

  let me = { id: '', role: 'member' }
  let mePromise = null

  const bodyEl = document.getElementById('dsh-console-body')
  const errorEl = document.getElementById('dsh-console-error')
  const titleEl = document.getElementById('dsh-console-title')
  const subtitleEl = document.getElementById('dsh-console-subtitle')
  const createButton = document.getElementById('dsh-console-create')
  const refreshButton = document.getElementById('dsh-console-refresh')
  const saveButton = document.getElementById('dsh-console-save')
  const returnButton = document.getElementById('dsh-console-return')
  const backButton = document.getElementById('dsh-console-back')
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
  const SIDEBAR_MENU = [
    { view: 'skills', label: 'Skills', icon: 'skills' },
    { view: 'mcp', label: 'MCP', icon: 'mcp' },
  ]
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
    } else {
      add('rect', { x: '3', y: '4', width: '18', height: '6', rx: '1.5' })
      add('rect', { x: '3', y: '14', width: '18', height: '6', rx: '1.5' })
      add('path', { d: 'M7 7h.01M7 17h.01' })
    }
    return svg
  }

  function syncMenuActive() {
    for (const button of document.querySelectorAll('#dsh-console-menu [data-console-view]')) {
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

  function installSidebarMenu() {
    if (document.getElementById('dsh-console-menu')) {
      syncSidebarRail()
      return true
    }
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    const nav = sidebar && (sidebar.querySelector('[class*="panelList"]') || sidebar.querySelector('nav'))
    if (!nav) return false
    const menu = el('div', { id: 'dsh-console-menu' })
    for (const entry of SIDEBAR_MENU) {
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

  // React 会重画侧栏；入口丢了自己补回去，其余时间不做任何事。
  installSidebarMenu()
  let menuCheck = false
  const menuObserver = new MutationObserver(() => {
    if (menuCheck) return
    menuCheck = true
    requestAnimationFrame(() => {
      menuCheck = false
      if (!document.getElementById('dsh-console-menu')) installSidebarMenu()
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
  function syncHeader() {
    const form = state.form
    const skills = state.view === 'skills'
    returnButton.hidden = !form
    saveButton.hidden = !form
    refreshButton.hidden = Boolean(form)
    createButton.hidden = Boolean(form)
    refreshButton.disabled = state.loading
    if (form) {
      titleEl.textContent = form.mode === 'create'
        ? (skills ? '新建 Skill' : '新建 MCP')
        : (skills ? `编辑 Skill · ${form.name}` : `编辑 MCP · ${form.name}`)
      subtitleEl.textContent = skills
        ? '保存后连同附加文件一起发布到沙箱，下一步会话即可使用。'
        : '只支持 streamable-http；保存后下一步会话会挂上它的工具。'
      saveButton.textContent = form.mode === 'create' ? '＋ 创建' : '保存'
      saveButton.disabled = state.busy
      return
    }
    titleEl.textContent = skills ? 'Skills 管理' : 'MCP 管理'
    subtitleEl.textContent = skills
      ? '创建自己的技能，或把技能公开给所有成员。公开人人可用，私有只有自己可用。'
      : '接入 HTTP MCP server；密钥由平台加密保存，脑侧按需解密。'
    createButton.textContent = skills ? '＋ 新建 Skill' : '＋ 新建 MCP'
  }

  function render() {
    renderError()
    syncHeader()
    bodyEl.replaceChildren()
    if (state.form) {
      bodyEl.append(renderForm())
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
    if (state.saveButton) {
      state.saveButton.disabled = true
      state.saveButton.textContent = '保存中…'
    }
    try {
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
        state.saveButton.textContent = state.form && state.form.mode === 'edit' ? '保存' : '＋ 创建'
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
      const items = await api(state.view === 'skills' ? '/skills' : '/mcp-servers')
      state.items = Array.isArray(items) ? items : []
      state.error = ''
    } catch (cause) {
      state.error = messageOf(cause)
    } finally {
      state.loading = false
      render()
    }
  }

  async function setView(view) {
    state.view = view === 'mcp' ? 'mcp' : 'skills'
    state.form = null
    clearFiles()
    syncMenuActive()
    await load()
  }

  function mainHost() {
    return document.querySelector('[class*="mainPanel"]')
      || document.querySelector('[class*="centerCol"]')
  }

  function mountIntoMain() {
    const host = mainHost()
    if (!host) {
      if (root.parentElement !== document.body) document.body.appendChild(root)
      return
    }
    if (root.parentElement !== host) host.appendChild(root)
    host.setAttribute('data-dsh-console-host', '')
    for (const child of host.children) {
      if (child === root) continue
      if (!child.hasAttribute('data-dsh-console-prev-display')) {
        child.setAttribute('data-dsh-console-prev-display', child.style.display)
      }
      child.style.display = 'none'
    }
  }

  function unmountFromMain() {
    const host = root.parentElement
    if (host && host.hasAttribute('data-dsh-console-host')) {
      for (const child of host.children) {
        if (child === root) continue
        if (!child.hasAttribute('data-dsh-console-prev-display')) continue
        child.style.display = child.getAttribute('data-dsh-console-prev-display') || ''
        child.removeAttribute('data-dsh-console-prev-display')
      }
      host.removeAttribute('data-dsh-console-host')
    }
    if (root.parentElement !== document.body) document.body.appendChild(root)
  }

  async function open(view) {
    await loadMe()
    mountIntoMain()
    root.hidden = false
    root.dataset.open = 'true'
    root.setAttribute('aria-hidden', 'false')
    await setView(view === 'mcp' ? 'mcp' : 'skills')
  }

  function close() {
    root.hidden = true
    root.dataset.open = 'false'
    root.setAttribute('aria-hidden', 'true')
    unmountFromMain()
    syncMenuActive()
  }

  backButton.addEventListener('click', close)
  refreshButton.addEventListener('click', () => {
    if (!state.busy) void load()
  })
  createButton.addEventListener('click', () => openForm('create'))
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
  // 点「新建会话 / 会话树 / 工作区」等侧栏聊天入口时退回对话主区。
  document.addEventListener('click', (event) => {
    if (root.dataset.open !== 'true') return
    const target = event.target
    if (!(target instanceof Element)) return
    if (root.contains(target)) return
    if (target.closest('#dsh-console-menu')) return
    if (target.closest('#dsh-account')) return
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    if (!sidebar || !sidebar.contains(target)) return
    close()
  })

  window.__dshConsoleOpen = (view) => {
    void open(view)
  }
  window.__dshConsoleClose = close
})()
