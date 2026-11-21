/**
 * 设置 → 模型：平台自有页。
 * 布局抄上游 ModelsSection（多行卡片 / 编辑器 / 模型行 / 虚线添加）。
 * 数据读写 /dsh-api/platform/v1/settings/model（多提供商）。
 */
;(() => {
  const API = '/dsh-api/platform/v1/settings/model'
  const MARKERS = [
    '填入各提供商的 API 密钥',
    'Enter your API keys to use models',
    '添加模型提供商',
    'Add model provider',
    '添加模型 API',
  ]

  const root = document.getElementById('dsh-platform-models')
  const rowsEl = document.getElementById('dsh-pm-rows')
  const addBtn = document.getElementById('dsh-pm-add')
  const addCard = document.getElementById('dsh-pm-add-card')
  const addEditorHost = document.getElementById('dsh-pm-add-editor')
  const editorTpl = document.getElementById('dsh-pm-editor-tpl')
  const savedEl = document.getElementById('dsh-pm-saved')
  const errorEl = document.getElementById('dsh-pm-error')

  let loaded = false
  /** @type {{ configured: boolean, providers: any[] } | null} */
  let page = null
  /** @type {string | null} */
  let editingId = null
  let creating = false
  let host = null
  let syncing = false
  let syncTimer = 0
  let loading = false
  let loadStartedAt = 0

  const settingsPanel = () => document.querySelector('[data-shortcut-modal="settings"]')

  const setError = (text) => {
    if (!text) {
      errorEl.hidden = true
      errorEl.textContent = ''
      return
    }
    errorEl.hidden = false
    errorEl.textContent = text
  }

  const setSaved = (text) => {
    if (!text) {
      savedEl.hidden = true
      savedEl.textContent = ''
      return
    }
    savedEl.hidden = false
    savedEl.textContent = text
  }

  async function api(method, path, body) {
    const response = await fetch(path || API, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok || json.code) {
      throw new Error(json.msg || `http-${response.status}`)
    }
    return json.data
  }

  /** 协议的产品名；值本身是脑的适配器认的标识符。 */
  const PROTOCOL_LABELS = {
    'openai-completions': 'OpenAI 兼容',
    'openai-responses': 'OpenAI Responses',
    'anthropic-messages': 'Anthropic',
    'google-generative-ai': 'Google Gemini',
  }

  function cloneEditor() {
    return editorTpl.content.firstElementChild.cloneNode(true)
  }

  function modelIdsOf(form) {
    return [...form.querySelectorAll('[data-role="model-id"]')]
      .map((input) => input.value.trim())
      .filter(Boolean)
  }

  function renderModelList(form, ids) {
    const list = form.querySelector('[data-role="model-list"]')
    const empty = form.querySelector('[data-role="model-empty"]')
    list.innerHTML = ''
    const values = ids.length ? ids : ['']
    for (const id of values) {
      const entry = document.createElement('div')
      entry.className = 'pm-model-entry'
      entry.innerHTML = `<div class="pm-model-row">
        <input class="pm-input" data-role="model-id" name="modelId" placeholder="模型 ID，例如 deepseek-chat" autocomplete="off">
        <button class="pm-icon-btn pm-icon-btn-danger" type="button" data-action="remove-model" aria-label="删除模型">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 3.5h8M5.5 3.5V2.5h3v1M4.5 3.5l.5 8h4l.5-8"/></svg>
        </button>
      </div>`
      entry.querySelector('[data-role="model-id"]').value = id
      list.appendChild(entry)
    }
    empty.classList.toggle('pm-hidden', list.children.length > 0)
  }

  function bindEditor(form, opts) {
    const keyInput = form.querySelector('input[name="apiKey"]')
    const protocolSelect = form.querySelector('select[name="api"]')
    const keyHint = form.querySelector('.pm-key-hint')
    const keyToggle = form.querySelector('.pm-key-toggle')
    form.querySelector('input[name="baseUrl"]').value = opts.baseUrl || ''
    if (protocolSelect) protocolSelect.value = opts.api || 'openai-completions'
    if (opts.configured && opts.apiKeyMasked) {
      keyInput.placeholder = opts.apiKeyMasked
      keyHint.textContent = '已保存密钥；留空表示不修改。输入新值将覆盖。'
    } else {
      keyInput.placeholder = 'sk-...'
      keyHint.textContent = '密钥只存平台库，不会回显明文。'
    }
    renderModelList(form, opts.modelIds || [])

    keyToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const show = keyInput.type === 'password'
      keyInput.type = show ? 'text' : 'password'
      keyToggle.setAttribute('aria-pressed', String(show))
      keyToggle.setAttribute('aria-label', show ? '隐藏密钥' : '显示密钥')
    })

    form.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]')
      if (!btn || !form.contains(btn)) return
      event.preventDefault()
      event.stopPropagation()
      const action = btn.getAttribute('data-action')
      if (action === 'add-model') {
        const ids = modelIdsOf(form)
        ids.push('')
        renderModelList(form, ids)
        const inputs = form.querySelectorAll('[data-role="model-id"]')
        inputs[inputs.length - 1]?.focus()
      } else if (action === 'remove-model') {
        const entry = btn.closest('.pm-model-entry')
        entry?.remove()
        if (!form.querySelector('.pm-model-entry')) renderModelList(form, [''])
        form.querySelector('[data-role="model-empty"]').classList.toggle(
          'pm-hidden',
          form.querySelectorAll('.pm-model-entry').length > 0,
        )
      } else if (action === 'cancel') {
        opts.onCancel?.()
      }
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const baseUrl = form.querySelector('input[name="baseUrl"]').value.trim()
      const modelIds = [...new Set(modelIdsOf(form))]
      const apiKey = keyInput.value.trim()
      const body = {
        baseUrl,
        api: protocolSelect ? protocolSelect.value : 'openai-completions',
        modelIds,
        defaultModel: modelIds[0] || '',
      }
      if (apiKey) body.apiKey = apiKey
      void opts.onSave?.(body, form)
    })
  }

  async function saveCreate(body, form) {
    setError('')
    setSaved('')
    const saveBtn = form.querySelector('[data-action="save"]')
    saveBtn.disabled = true
    try {
      await api('POST', API, body)
      creating = false
      editingId = null
      await load()
      setSaved('已添加提供商到平台数据库')
    } catch (error) {
      setError(mapError(error))
    } finally {
      saveBtn.disabled = false
    }
  }

  async function saveUpdate(id, body, form) {
    setError('')
    setSaved('')
    const saveBtn = form.querySelector('[data-action="save"]')
    saveBtn.disabled = true
    try {
      await api('PUT', `${API}/${encodeURIComponent(id)}`, body)
      editingId = null
      await load()
      setSaved('已保存到平台数据库')
    } catch (error) {
      setError(mapError(error))
    } finally {
      saveBtn.disabled = false
    }
  }

  function mapError(error) {
    const code = error instanceof Error ? error.message : String(error)
    return ({
      'model-config-required': '请填写 API 地址和至少一个模型',
      'default-model-not-listed': '默认模型必须在模型列表中',
      'model-api-key-required': '首次配置必须填写 API 密钥',
      'model-protocol-invalid': '协议类型不认识，请重新选择',
      'provider-not-found': '提供商不存在或已删除',
    })[code] || code
  }

  async function removeProvider(id, name) {
    if (!confirm(`删除提供商「${name}」？`)) return
    setError('')
    setSaved('')
    try {
      await api('DELETE', `${API}/${encodeURIComponent(id)}`)
      if (editingId === id) editingId = null
      await load()
      setSaved(`已删除「${name}」`)
    } catch (error) {
      setError(mapError(error))
    }
  }

  function render() {
    const providers = page?.providers || []
    rowsEl.innerHTML = ''
    addEditorHost.innerHTML = ''
    addCard.hidden = true
    addCard.classList.add('pm-hidden')

    // 有提供商时仍显示虚线添加按钮（多提供商）；创建中则暂时藏起。
    const showAdd = !creating
    addBtn.hidden = !showAdd
    addBtn.classList.toggle('pm-hidden', !showAdd)

    for (const provider of providers) {
      const li = document.createElement('li')
      li.className = 'pm-row-card'
      li.dataset.providerId = provider.id
      li.innerHTML = `<div class="pm-row-head">
        <span class="pm-row-identity">
          <span class="pm-row-name"></span>
          <span class="pm-row-tag"></span>
          <span class="pm-dot" data-ok="${provider.configured ? 'true' : 'false'}" role="img"
            aria-label="${provider.configured ? '已配置密钥' : '缺少密钥'}"
            title="${provider.configured ? '已配置密钥' : '缺少密钥'}"></span>
        </span>
        <span class="pm-row-actions">
          <button type="button" class="pm-btn pm-btn-secondary" data-action="edit">编辑</button>
          <button type="button" class="pm-btn pm-btn-danger" data-action="remove">删除</button>
        </span>
      </div>`
      li.querySelector('.pm-row-name').textContent = provider.displayName || provider.baseUrl
      li.querySelector('.pm-row-tag').textContent = PROTOCOL_LABELS[provider.api] || '自定义'

      li.querySelector('[data-action="edit"]').addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        creating = false
        editingId = editingId === provider.id ? null : provider.id
        setSaved('')
        setError('')
        render()
      })
      li.querySelector('[data-action="remove"]').addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void removeProvider(provider.id, provider.displayName || provider.baseUrl)
      })

      if (editingId === provider.id) {
        const form = cloneEditor()
        bindEditor(form, {
          baseUrl: provider.baseUrl,
          api: provider.api || 'openai-completions',
          modelIds: provider.modelIds || [],
          configured: provider.configured,
          apiKeyMasked: provider.apiKeyMasked || '',
          onCancel: () => {
            editingId = null
            render()
          },
          onSave: (body, f) => saveUpdate(provider.id, body, f),
        })
        li.appendChild(form)
      }
      rowsEl.appendChild(li)
    }

    if (creating) {
      addBtn.hidden = true
      addBtn.classList.add('pm-hidden')
      addCard.hidden = false
      addCard.classList.remove('pm-hidden')
      const form = cloneEditor()
      bindEditor(form, {
        baseUrl: '',
        modelIds: [''],
        configured: false,
        onCancel: () => {
          creating = false
          render()
        },
        onSave: (body, f) => saveCreate(body, f),
      })
      addEditorHost.appendChild(form)
    }

    root.dataset.configured = page?.configured ? 'true' : 'false'
  }

  async function load() {
    if (loading) return
    loading = true
    setError('')
    try {
      page = await api('GET', API)
      // 兼容万一还是旧单对象响应
      if (page && !Array.isArray(page.providers)) {
        const legacy = page
        page = {
          configured: Boolean(legacy.configured),
          providers: legacy.configured
            ? [{
              id: 'legacy',
              displayName: legacy.baseUrl,
              baseUrl: legacy.baseUrl,
              api: legacy.api || 'openai-completions',
              modelIds: legacy.modelIds || [],
              defaultModel: legacy.defaultModel || '',
              apiKeyMasked: legacy.apiKeyMasked || '',
              configured: true,
            }]
            : [],
        }
      }
      loaded = true
      render()
    } catch (error) {
      setError(mapError(error))
    } finally {
      loading = false
    }
  }

  /**
   * 设置面板里装分区的那一块（上游叫 `options`）。
   *
   * 只按结构认，不能按文字猜：导航、分区容器、分区自身、分区里的段落都带着
   * 同样的说明文字，按文字找会一层层往下漂，挂载点跟着乱跳，页面就一直闪。
   */
  function sectionHost(panel) {
    const nav = panel.querySelector('nav')
    const usable = (el) => el !== root && !root.contains(el) && !(nav && (el === nav || el.contains(nav)))
    for (const el of panel.children) {
      if (!usable(el)) continue
      if (String(el.className || '').includes('_options')) return el
    }
    // 老壳没有可读的类名：退回「直接子节点里带模型说明文字、且不含导航」的那块。
    for (const el of panel.children) {
      if (!usable(el)) continue
      const text = el.textContent || ''
      if (MARKERS.some((marker) => text.includes(marker))) return el
    }
    return null
  }

  /** 导航栏当前选中的分区文字；老壳没有 aria-current 时返回 undefined。 */
  function selectedNavLabel(panel) {
    const nav = panel.querySelector('nav')
    if (!nav) return undefined
    const selected = nav.querySelector('[aria-current="true"], [aria-selected="true"], [data-active="true"], .active')
    return selected ? (selected.textContent || '').trim() : undefined
  }

  function isModelsNavActive(panel) {
    // 只看导航选中项。页面已经挂进面板、正在编辑，都不能算「还停在模型页」——
    // 否则切到通用设置后这里仍返回 true，模型页就一直盖在上面。
    const label = selectedNavLabel(panel)
    if (label !== undefined) return label === '模型' || label === 'Models'
    // 老壳没有可读的选中标记：分区容器里还有上游模型区块就算停在模型页。
    const section = sectionHost(panel)
    if (section === null) return false
    return [...section.children].some((el) =>
      el !== root && !root.contains(el) && MARKERS.some((marker) => (el.textContent || '').includes(marker)))
  }

  function detach() {
    if (host) host.removeAttribute('data-dsh-pm-host')
    // 上游分区可能已经被 React 卸载，连带把根节点摘掉：无论如何先放回 body。
    if (root.parentElement !== document.body) document.body.appendChild(root)
    host = null
    root.hidden = true
    root.dataset.open = 'false'
    editingId = null
    creating = false
  }

  function attach(panel) {
    const section = sectionHost(panel)
    const mount = section || panel
    if (root.parentElement !== mount) mount.appendChild(root)
    // 藏上游分区靠容器上的属性 + 一条 CSS 规则，而不是逐个节点改 style：
    // React 重渲染会换掉分区节点，逐个改必然闪；规则对之后挂上来的节点立即生效。
    if (section !== null && section.getAttribute('data-dsh-pm-host') !== 'true') {
      section.setAttribute('data-dsh-pm-host', 'true')
    }
    host = section
    if (root.hidden || root.dataset.open !== 'true') {
      root.hidden = false
      root.dataset.open = 'true'
    }
    ensureLoaded()
  }

  function ensureLoaded() {
    if (loaded || loading) return
    // 失败后不要跟着每次 DOM 变更重试，隔两秒再说。
    if (Date.now() - loadStartedAt < 2000) return
    loadStartedAt = Date.now()
    void load()
  }

  function sync() {
    if (syncing) return
    syncing = true
    try {
      const panel = settingsPanel()
      if (!panel) {
        if (root.dataset.open === 'true') detach()
        return
      }
      if (isModelsNavActive(panel)) attach(panel)
      else if (root.dataset.open === 'true') detach()
    } finally {
      syncing = false
    }
  }

  function scheduleSync() {
    if (syncTimer) return
    syncTimer = window.setTimeout(() => {
      syncTimer = 0
      sync()
    }, 50)
  }

  // 冒泡阶段拦住，别让 DSH 壳收到（关设置 / 切会话）；
  // 不能用捕获，否则「编辑」自己也点不到。
  root.addEventListener('click', (event) => {
    event.stopPropagation()
  })
  root.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })
  root.addEventListener('mousedown', (event) => {
    event.stopPropagation()
  })

  addBtn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    creating = true
    editingId = null
    setSaved('')
    setError('')
    render()
  })

  // 只在设置面板导航变化时同步；不要用 document capture click（会把编辑点成关面板）。
  const watch = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target === root || root.contains(mutation.target)) continue
      scheduleSync()
      return
    }
  })
  watch.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-selected', 'aria-current', 'data-active', 'hidden'],
  })
  sync()
})()
