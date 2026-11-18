/* 工作区文件树的上传按钮。由 files-upload.ts 内联进外壳页面。 */
(() => {
  const PAGE = '[data-files-page]'
  const RELOAD = '[data-files-reload]'
  const PATH = '[data-files-path]'
  // closest 用选择器；getAttribute 必须用属性名（不能带方括号）。
  const SESSION_ATTR = 'data-sidebar-right-session'
  const SESSION = `[${SESSION_ATTR}]`
  const UPLOAD = 'data-files-upload'
  const STATUS_ID = 'dsh-files-upload-status'
  const UPLOAD_PATH = '/dsh-api/platform/v1/workspaceFiles/upload'
  const DONE_HIDE_MS = 1800
  const ERROR_HIDE_MS = 6000
  const CANCELLED_HIDE_MS = 3200

  const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true">'
    + '<path d="M8 10.0469V1.95317" stroke="currentColor"></path>'
    + '<path d="M4.25 5.70317L8 1.95317L11.75 5.70317" stroke="currentColor"></path>'
    + '<path d="M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469" stroke="currentColor"></path>'
    + '</svg>'

  const MESSAGES = {
    'workspace-file/session-not-found': '会话已失效，刷新页面后重试',
    'workspace-file/invalid-name': '文件名不能包含路径分隔符',
    'workspace-file/too-large': '单个文件不能超过 64 MB',
    'workspace-file/incomplete': '上传中断，请重试',
    'workspace-file/outside-workspace': '目标目录不在工作区里',
    'workspace-file/name-conflict': '同名文件太多，请先整理目录',
    'workspace-file/write-failed': '写入失败，请稍后重试',
  }

  function ensureStyle() {
    if (document.getElementById('dsh-files-upload-style')) return
    const style = document.createElement('style')
    style.id = 'dsh-files-upload-style'
    style.textContent = `
#${STATUS_ID}{position:fixed;left:50%;bottom:24px;z-index:10060;width:min(420px,calc(100vw - 32px));transform:translateX(-50%);padding:11px 14px 12px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-l3,rgba(15,17,21,.12));box-shadow:0 10px 28px rgba(15,17,21,.18);color:var(--dsw-alias-label-primary,#0f1115);font:12.5px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
#${STATUS_ID}[hidden]{display:none}
#${STATUS_ID}[data-state="error"]{border-color:var(--dsw-alias-state-error-secondary,#f5c2c7);color:var(--dsw-alias-state-error-primary,#d1242f)}
[data-files-upload-heading]{display:flex;align-items:center;gap:8px}
[data-files-upload-title]{flex:1;font-weight:600}
[data-files-upload-cancel]{flex:none;padding:0 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;cursor:pointer}
[data-files-upload-cancel]:hover{color:var(--dsw-alias-label-primary,#0f1115)}
[data-files-upload-name]{margin-top:2px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-files-upload-track]{margin-top:8px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(15,17,21,.1));overflow:hidden}
[data-files-upload-track][hidden],[data-files-upload-name][hidden]{display:none}
[data-files-upload-bar]{height:100%;width:0;border-radius:inherit;background:var(--dsw-alias-state-business-primary,#0969da);transition:width .15s linear}
[data-files-upload-track][data-indeterminate="true"] [data-files-upload-bar]{width:35%;animation:dsh-files-upload-slide 1.1s ease-in-out infinite}
@keyframes dsh-files-upload-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
[data-files-upload-meta]{margin-top:6px;color:var(--dsw-alias-label-tertiary,#8b9096);font-variant-numeric:tabular-nums}
#${STATUS_ID}[data-state="error"] [data-files-upload-meta]{color:inherit}
#${STATUS_ID}[data-state="done"] [data-files-upload-title]{color:var(--dsw-alias-state-success-primary,#1a7f37)}
[data-files-upload-host]{display:inline-flex}
[data-files-upload]{display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}
[data-files-upload] svg{width:16px;height:16px;flex:none}
[data-files-upload]:hover{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.06))}
[data-files-upload]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#0969da));outline-offset:-2px}
[data-files-upload][aria-busy="true"]{opacity:.5;cursor:progress}
`
    document.head.append(style)
  }

  // 文件树的页头会随自动刷新被 React 重建；input 若挂在页头里，用户还在
  // 选择器里挑文件时就会被换掉，选完的事件落在脱离文档的节点上。input 只建
  // 一份挂到 body，按钮只负责触发，选完再回头找当前的页面。
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  input.tabIndex = -1
  input.setAttribute('data-files-upload-input', '')
  document.body.append(input)

  /** 最近一次点上传按钮的页面；选择器打开期间页面可能已被重建。 */
  let activePage = null
  /** 点按钮时的会话 id，作为页面重建后的兜底。 */
  let activeSession = ''
  /** 最近一次点上传按钮的按钮本身，用来在选完文件后置忙。 */
  let activeButton = null
  /** 正在上传的 XHR；取消时 abort 它。 */
  let activeXhr = null
  let cancelRequested = false

  /** 进度 / 结果面板；和文件页无关，只建一份挂到 body。 */
  let status = null
  let statusTimer = 0

  function statusNodes() {
    if (status && status.root.isConnected) return status
    const root = document.createElement('div')
    root.id = STATUS_ID
    root.hidden = true
    root.setAttribute('role', 'status')
    root.setAttribute('aria-live', 'polite')

    const heading = document.createElement('div')
    heading.setAttribute('data-files-upload-heading', '')
    const title = document.createElement('span')
    title.setAttribute('data-files-upload-title', '')
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.setAttribute('data-files-upload-cancel', '')
    cancel.textContent = '取消'
    cancel.hidden = true
    heading.append(title, cancel)

    const name = document.createElement('div')
    name.setAttribute('data-files-upload-name', '')
    name.hidden = true

    const track = document.createElement('div')
    track.setAttribute('data-files-upload-track', '')
    track.setAttribute('role', 'progressbar')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', '100')
    track.hidden = true
    const bar = document.createElement('div')
    bar.setAttribute('data-files-upload-bar', '')
    track.append(bar)

    const meta = document.createElement('div')
    meta.setAttribute('data-files-upload-meta', '')

    root.append(heading, name, track, meta)
    document.body.append(root)

    status = { root, title, cancel, name, track, bar, meta }
    cancel.addEventListener('click', () => {
      cancelRequested = true
      if (activeXhr) activeXhr.abort()
    })
    return status
  }

  function clearStatusTimer() {
    clearTimeout(statusTimer)
    statusTimer = 0
  }

  function hideStatusSoon(delay) {
    clearStatusTimer()
    statusTimer = window.setTimeout(() => {
      if (status) status.root.hidden = true
    }, delay)
  }

  /** 清空上一条状态，换成 `state` 对应的布局。 */
  function resetStatus(state) {
    const view = statusNodes()
    clearStatusTimer()
    view.root.hidden = false
    view.root.setAttribute('data-state', state)
    view.cancel.hidden = state !== 'progress'
    view.name.hidden = true
    view.name.textContent = ''
    view.track.hidden = true
    view.track.removeAttribute('data-indeterminate')
    view.track.removeAttribute('aria-valuenow')
    view.bar.style.width = ''
    view.meta.textContent = ''
    return view
  }

  function showProgress(index, total, file) {
    const view = resetStatus('progress')
    view.title.textContent = `正在上传 ${index}/${total}`
    view.name.hidden = false
    // 文件名来自用户，只能用 textContent。
    view.name.textContent = file.name
    view.track.hidden = false
    view.meta.textContent = '0%'
  }

  function showFailure(message) {
    const view = resetStatus('error')
    view.title.textContent = '上传失败'
    view.meta.textContent = message
    hideStatusSoon(ERROR_HIDE_MS)
  }

  function showDone(count) {
    const view = resetStatus('done')
    view.title.textContent = count === 1 ? '文件已上传' : `已上传 ${count} 个文件`
    hideStatusSoon(DONE_HIDE_MS)
  }

  function showCancelled() {
    const view = resetStatus('cancelled')
    view.title.textContent = '已取消上传'
    hideStatusSoon(CANCELLED_HIDE_MS)
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  }

  function renderProgress(loaded, total) {
    if (!status) return
    if (total > 0) {
      const percent = Math.min(100, Math.round((loaded / total) * 100))
      status.track.hidden = false
      status.track.removeAttribute('data-indeterminate')
      status.track.setAttribute('aria-valuenow', String(percent))
      status.bar.style.width = `${percent}%`
      status.meta.textContent = `${percent}% · ${formatBytes(loaded)} / ${formatBytes(total)}`
      return
    }
    // 服务端没给总长度时用不确定态，至少让人看到还在动。
    status.track.hidden = false
    status.track.setAttribute('data-indeterminate', 'true')
    status.track.removeAttribute('aria-valuenow')
    status.bar.style.width = ''
    status.meta.textContent = `已上传 ${formatBytes(loaded)}`
  }

  function currentDir(page) {
    const label = page.querySelector(PATH)
    const raw = (label?.getAttribute('title') || label?.textContent || '').trim()
    if (raw === '') return '/desk'
    if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/desk'
    return `/desk/${raw}`.replace(/\/+$/, '')
  }

  // 用 XHR 而不是 fetch：只有它可以拿到上传进度。
  function uploadOne(file, sessionId, dir, onProgress) {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams({ sessionId, dir, name: file.name })
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${UPLOAD_PATH}?${query.toString()}`)
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
      xhr.upload.addEventListener('progress', (event) => {
        if (cancelRequested) return
        onProgress(event.loaded, event.lengthComputable ? event.total : 0)
      })
      xhr.addEventListener('load', () => {
        activeXhr = null
        let body = null
        try { body = JSON.parse(xhr.responseText) } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || !body || body.ok !== true) {
          const error = body && body.error ? body.error : {}
          reject(new Error(MESSAGES[error.code] || error.message || '上传失败，请稍后重试'))
          return
        }
        resolve(body.value)
      })
      xhr.addEventListener('error', () => {
        activeXhr = null
        reject(new Error('网络异常，上传失败，请稍后重试'))
      })
      xhr.addEventListener('abort', () => {
        activeXhr = null
        const error = new Error('upload aborted')
        error.name = 'AbortError'
        reject(error)
      })
      activeXhr = xhr
      xhr.send(file)
    })
  }

  async function upload(button) {
    // 选择器打开期间页头可能被重建，优先用还挂在文档上的页面。
    const page = activePage?.isConnected ? activePage : document.querySelector(PAGE)
    const sessionId = page?.closest(SESSION)?.getAttribute(SESSION_ATTR) || activeSession
    if (!page || !sessionId) {
      showFailure('找不到当前会话，刷新页面后重试')
      return
    }
    const files = [...(input.files || [])]
    input.value = ''
    if (files.length === 0) return
    const dir = currentDir(page)
    cancelRequested = false
    button.setAttribute('aria-busy', 'true')
    button.disabled = true
    let uploaded = 0
    let failure = ''
    for (let index = 0; index < files.length; index += 1) {
      if (cancelRequested) break
      showProgress(index + 1, files.length, files[index])
      try {
        await uploadOne(files[index], sessionId, dir, renderProgress)
        uploaded += 1
      } catch (error) {
        if (cancelRequested || (error && error.name === 'AbortError')) break
        failure = error instanceof Error ? error.message : String(error)
        break
      }
    }
    button.removeAttribute('aria-busy')
    button.disabled = false
    if (cancelRequested) showCancelled()
    else if (failure) showFailure(failure)
    else showDone(uploaded)
    // 上传无论成败都刷新一次：成功的文件要出现，失败也让人看到目录现状。
    page.querySelector(RELOAD)?.click()
  }

  input.addEventListener('change', () => {
    if (activeButton) void upload(activeButton)
  })

  function mount(page) {
    if (page.querySelector(`[${UPLOAD}]`)) return
    if (!page.closest(SESSION)) return
    const reload = page.querySelector(RELOAD)
    if (!reload || !reload.parentElement) return
    ensureStyle()

    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(UPLOAD, '')
    button.className = reload.className
    button.title = '上传文件'
    button.setAttribute('aria-label', '上传文件')
    button.innerHTML = ICON

    button.addEventListener('click', () => {
      activePage = page
      activeSession = page.closest(SESSION)?.getAttribute(SESSION_ATTR) || ''
      activeButton = button
      input.click()
    })

    const host = document.createElement('span')
    host.setAttribute('data-files-upload-host', '')
    host.append(button)
    reload.parentElement.insertBefore(host, reload)
  }

  function scan() {
    for (const page of document.querySelectorAll(PAGE)) mount(page)
  }

  scan()
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
})()
