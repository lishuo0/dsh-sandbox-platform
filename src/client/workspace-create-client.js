/* 侧边栏「新增工作区」按钮和弹窗。由 workspace-create.ts 内联进外壳页面。 */
(() => {
  const root = document.getElementById('dsh-workspace-create')
  if (!root || root.dataset.ready === '1') return
  root.dataset.ready = '1'

  const API = '/dsh-api/platform/v1'
  const CREATE = `${API}/remote/workspace/create`
  const BUTTON_ID = 'dsh-workspace-add'
  const MESSAGES = {
    'name-required': '请输入工作区名称',
    'invalid-selection': '选择里有已不存在的 Skill 或 MCP，请刷新后重试',
    'workspace/name-conflict': '这个工作区名称已经被占用了',
    'workspace/internal': '创建失败，请稍后重试',
    unauthorized: '登录已失效，请重新登录',
  }

  const nameInput = document.getElementById('dsh-ws-name')
  const submitButton = document.getElementById('dsh-ws-submit')
  const errorEl = document.getElementById('dsh-ws-error')
  const skillsList = document.getElementById('dsh-ws-skills')
  const mcpList = document.getElementById('dsh-ws-mcp')
  const skillsPanel = document.getElementById('dsh-ws-skills-panel')
  const mcpPanel = document.getElementById('dsh-ws-mcp-panel')
  const skillsSearch = document.getElementById('dsh-ws-skills-search')
  const mcpSearch = document.getElementById('dsh-ws-mcp-search')
  const skillsCount = document.getElementById('dsh-ws-skills-count')
  const mcpCount = document.getElementById('dsh-ws-mcp-count')

  const AVATAR_COLORS = ['#8b5cf6', '#3b82f6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4']

  function avatarLetter(name) {
    return (String(name).trim().charAt(0) || 'S').toUpperCase()
  }

  function avatarColor(name) {
    let hash = 0
    for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return AVATAR_COLORS[hash % AVATAR_COLORS.length]
  }

  function avatarNode(name, className) {
    const node = el('span', { class: className, text: avatarLetter(name) })
    node.style.background = avatarColor(name)
    return node
  }

  const state = {
    skills: [],
    mcpServers: [],
    skillQuery: '',
    mcpQuery: '',
    skillsOpen: false,
    mcpOpen: false,
    selectedSkills: new Set(),
    selectedMcp: new Set(),
    busy: false,
    loading: false,
    // 选项没加载成功就不让提交：否则会静默建出一个「什么都不接」的工作区。
    loadFailed: false,
    bodyOverflow: null,
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value)
        } else if (key === 'hidden') node.hidden = Boolean(value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  // 和 DSH 工作区浏览器自带的「添加工作区」图标一致（project-add-outline，1px 描边）。
  function plusIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke-width', '1')
    svg.setAttribute('aria-hidden', 'true')
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      svg.append(node)
    }
    add('path', {
      d: 'M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z',
      fill: 'currentColor',
    })
    add('path', { d: 'M9.75977 4.50208H14.5509', stroke: 'currentColor' })
    add('path', { d: 'M12.1492 6.89758L12.1492 2.10642', stroke: 'currentColor' })
    return svg
  }

  // 侧栏收成图标栏时，按钮跟官方 rail 一样是 36px；其余时候 28px。
  function syncRail(button) {
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    const width = sidebar ? sidebar.getBoundingClientRect().width : 0
    button.dataset.rail = width > 0 && width < 120 ? '1' : '0'
  }

  // React 重画侧栏时按钮会丢，跟着补回去；其余时间不做任何事。
  function installButton() {
    const existing = document.getElementById(BUTTON_ID)
    if (existing) {
      syncRail(existing)
      return true
    }
    const header = document.querySelector('[data-sidebar-workspace-header]')
    if (!header) return false
    // 只留图标：文字会把工作区标题行挤窄，名字靠 aria-label / title 悬浮提示。
    const button = el('button', {
      id: BUTTON_ID,
      type: 'button',
      'data-dsh-workspace-add': '',
      'aria-label': '新建工作区',
      title: '新建工作区',
    }, plusIcon())
    button.addEventListener('click', () => { void open() })
    header.append(button)
    syncRail(button)
    return true
  }

  installButton()
  let checkScheduled = false
  const observer = new MutationObserver(() => {
    if (checkScheduled) return
    checkScheduled = true
    requestAnimationFrame(() => {
      checkScheduled = false
      installButton()
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', () => {
    const button = document.getElementById(BUTTON_ID)
    if (button) syncRail(button)
  })

  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  async function api(path) {
    const response = await fetch(API + path, { credentials: 'same-origin' })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch {}
    if (!response.ok || (body && body.code !== 0)) {
      const code = body && typeof body.msg === 'string' ? body.msg : ''
      throw new Error(MESSAGES[code] || code || `请求失败（${response.status}）`)
    }
    return body ? body.data : null
  }

  function showError(message) {
    if (!message) {
      errorEl.hidden = true
      errorEl.textContent = ''
      return
    }
    errorEl.hidden = false
    errorEl.textContent = message
  }

  function syncSubmit() {
    submitButton.disabled = state.busy || state.loading || state.loadFailed
    submitButton.textContent = state.busy ? '创建中…' : '创建'
  }

  function renderCounts() {
    skillsCount.textContent = `已选 ${state.selectedSkills.size} 个`
    mcpCount.textContent = `已选 ${state.selectedMcp.size} 个`
  }

  function ownerOf(item) {
    return item.ownerDisplayName || item.owner_display_name || ''
  }

  function keyOf(item) {
    return `${item.scope}:${item.name}`
  }

  function visibilityOf(item) {
    return item.scope === 'public' ? '公开' : '私有'
  }

  function selectedCards(items, selected) {
    const cards = []
    for (const item of items) {
      if (!selected.has(keyOf(item))) continue
      cards.push(el('div', { class: 'dsh-ws-pick' },
        avatarNode(item.name, 'dsh-ws-avatar'),
        el('span', { class: 'dsh-ws-pick-text' },
          el('strong', { text: item.name }),
          el('span', { text: `${visibilityOf(item)} · ${item.scope === 'public' ? '所有成员可用' : '仅自己可用'}` })),
        el('button', {
          class: 'dsh-ws-remove',
          type: 'button',
          'aria-label': `移除 ${item.name}`,
          title: `移除 ${item.name}`,
          text: '×',
          onclick: () => toggle(item, selected),
        })))
    }
    return cards
  }

  function candidateButton(item, selected) {
    const text = el('span', { class: 'dsh-ws-candidate-text' },
      el('strong', { text: item.name }),
      el('span', { text: `${visibilityOf(item)}${ownerOf(item) ? ` · ${ownerOf(item)}` : ''}` }))
    const description = String(item.description || '')
    if (description !== '') text.append(el('span', { text: description }))
    return el('button', {
      class: 'dsh-ws-candidate',
      type: 'button',
      role: 'option',
      'aria-selected': 'false',
      onclick: () => toggle(item, selected),
    }, avatarNode(item.name, 'dsh-ws-avatar'), text)
  }

  function toggle(item, selected) {
    const key = keyOf(item)
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    if (selected === state.selectedSkills) {
      state.skillQuery = ''
      skillsSearch.value = ''
      state.skillsOpen = false
    } else {
      state.mcpQuery = ''
      mcpSearch.value = ''
      state.mcpOpen = false
    }
    renderOptions()
  }

  function renderSelected(container, items, selected) {
    container.replaceChildren()
    const cards = selectedCards(items, selected)
    if (cards.length > 0) {
      container.append(...cards)
      return
    }
    if (state.loading) container.append(el('p', { class: 'dsh-ws-empty', text: '加载中…' }))
    else if (state.loadFailed) container.append(el('p', { class: 'dsh-ws-empty', text: '选项加载失败。' }))
    else container.append(el('p', { class: 'dsh-ws-empty', text: '尚未选择' }))
  }

  function renderPanel(panel, items, selected, kind, open, query) {
    panel.replaceChildren()
    panel.hidden = !open
    if (!open) return
    const needle = query.trim().toLowerCase()
    const candidates = items.filter((item) => {
      if (selected.has(keyOf(item))) return false
      if (needle === '') return true
      return item.name.toLowerCase().includes(needle)
        || String(item.description || '').toLowerCase().includes(needle)
        || ownerOf(item).toLowerCase().includes(needle)
    })
    if (candidates.length === 0) {
      const emptyText = items.length === 0
        ? (kind === 'skills' ? '还没有启用的 Skill；先到左侧 Skills 页创建。' : '还没有启用的 MCP；先到左侧 MCP 页创建。')
        : (kind === 'skills' ? '没有匹配的 Skill。' : '没有匹配的 MCP。')
      panel.append(el('p', { class: 'dsh-ws-empty', text: emptyText }))
      return
    }
    for (const item of candidates) panel.append(candidateButton(item, selected))
  }

  function renderOptions() {
    renderSelected(skillsList, state.skills, state.selectedSkills)
    renderSelected(mcpList, state.mcpServers, state.selectedMcp)
    renderPanel(skillsPanel, state.skills, state.selectedSkills, 'skills', state.skillsOpen, state.skillQuery)
    renderPanel(mcpPanel, state.mcpServers, state.selectedMcp, 'mcp', state.mcpOpen, state.mcpQuery)
    renderCounts()
  }

  function refsOf(selected) {
    return [...selected].map((key) => {
      const at = key.indexOf(':')
      return { scope: key.slice(0, at), name: key.slice(at + 1) }
    })
  }

  async function submit() {
    if (state.busy) return
    if (state.loadFailed) {
      await loadOptions()
      return
    }
    const name = nameInput.value.trim()
    if (name === '') {
      showError(MESSAGES['name-required'])
      nameInput.focus()
      return
    }
    showError('')
    state.busy = true
    syncSubmit()
    try {
      const response = await fetch(CREATE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          method: 'workspace/create',
          rpcId: `platform-workspace-create-${Date.now()}`,
          payload: {
            args: {
              request: {
                title: name,
                skills: refsOf(state.selectedSkills),
                mcpServers: refsOf(state.selectedMcp),
              },
            },
          },
        }),
      })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch {}
      const result = body && body.result
      if (!response.ok || !result || result.ok !== true) {
        const error = result && result.error
        const code = error && typeof error.code === 'string' ? error.code : ''
        // 平台把 422 的语义码放在 message 里（例如 invalid-selection），一起拿来查表。
        const detail = error && typeof error.message === 'string' ? error.message : ''
        const message = MESSAGES[code] || MESSAGES[detail] || detail
        throw new Error(message || `请求失败（${response.status}）`)
      }
      close()
    } catch (cause) {
      showError(messageOf(cause))
    } finally {
      state.busy = false
      syncSubmit()
    }
  }

  async function loadOptions() {
    state.loading = true
    state.loadFailed = false
    state.skillsOpen = false
    state.mcpOpen = false
    showError('')
    renderOptions()
    syncSubmit()
    try {
      const [skills, mcps] = await Promise.all([api('/skills'), api('/mcp-servers')])
      state.skills = (Array.isArray(skills) ? skills : []).filter((item) => item.enabled !== false)
      state.mcpServers = (Array.isArray(mcps) ? mcps : []).filter((item) => item.enabled !== false)
    } catch (cause) {
      state.loadFailed = true
      showError(messageOf(cause))
    } finally {
      state.loading = false
      renderOptions()
      syncSubmit()
    }
  }

  async function open() {
    state.selectedSkills.clear()
    state.selectedMcp.clear()
    state.skillQuery = ''
    state.mcpQuery = ''
    state.skillsOpen = false
    state.mcpOpen = false
    skillsSearch.value = ''
    mcpSearch.value = ''
    nameInput.value = '新工作区'
    showError('')
    root.hidden = false
    root.setAttribute('aria-hidden', 'false')
    if (state.bodyOverflow === null) state.bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    syncSubmit()
    await loadOptions()
  }

  function close() {
    root.hidden = true
    root.setAttribute('aria-hidden', 'true')
    state.skillsOpen = false
    state.mcpOpen = false
    if (state.bodyOverflow !== null) {
      document.body.style.overflow = state.bodyOverflow
      state.bodyOverflow = null
    }
    state.busy = false
    state.loading = false
    syncSubmit()
  }

  skillsSearch.addEventListener('focus', () => {
    state.skillsOpen = true
    renderOptions()
  })
  skillsSearch.addEventListener('input', () => {
    state.skillQuery = skillsSearch.value
    state.skillsOpen = true
    renderOptions()
  })
  skillsSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.skillsOpen) {
      event.stopPropagation()
      state.skillsOpen = false
      renderOptions()
    }
  })
  mcpSearch.addEventListener('focus', () => {
    state.mcpOpen = true
    renderOptions()
  })
  mcpSearch.addEventListener('input', () => {
    state.mcpQuery = mcpSearch.value
    state.mcpOpen = true
    renderOptions()
  })
  mcpSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.mcpOpen) {
      event.stopPropagation()
      state.mcpOpen = false
      renderOptions()
    }
  })
  // 点候选面板和搜索框之外的地方收起下拉；只重画面板，不动已选卡片。
  document.addEventListener('mousedown', (event) => {
    if (!state.skillsOpen && !state.mcpOpen) return
    const target = event.target
    if (!(target instanceof Element)) return
    let changed = false
    if (state.skillsOpen && !target.closest('#dsh-ws-skills-search') && !target.closest('#dsh-ws-skills-panel')) {
      state.skillsOpen = false
      changed = true
    }
    if (state.mcpOpen && !target.closest('#dsh-ws-mcp-search') && !target.closest('#dsh-ws-mcp-panel')) {
      state.mcpOpen = false
      changed = true
    }
    if (!changed) return
    renderPanel(skillsPanel, state.skills, state.selectedSkills, 'skills', state.skillsOpen, state.skillQuery)
    renderPanel(mcpPanel, state.mcpServers, state.selectedMcp, 'mcp', state.mcpOpen, state.mcpQuery)
  })
  submitButton.addEventListener('click', () => { void submit() })
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden) close()
  })
  for (const node of root.querySelectorAll('[data-dsh-ws-close]')) {
    node.addEventListener('click', close)
  }
})()
