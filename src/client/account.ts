/**
 * 账号密码弹窗。
 *
 * 两处入口共用同一个对话框：
 * - 管理员开户 / 重置密码后，`/auth/me` 的 `mustChangePassword` 为真，进页面就强制弹出，
 *   不改完不能关（没有关闭按钮、Esc 和点遮罩都无效）。
 * - 左下角账号菜单的「修改密码」按需打开，可随时关闭。
 *
 * 密码只发给平台 `PATCH /me/password`，不经过脑，也不落在本地存储。
 */

const ME = '/dsh-api/platform/v1/auth/me'
const CHANGE = '/dsh-api/platform/v1/me/password'

const MESSAGES: Record<string, string> = {
  'invalid-password': '当前密码不正确',
  'password-too-short': '新密码至少 6 位',
  unauthorized: '登录已失效，请重新登录',
}

export function accountDialog(): string {
  return `<div id="dsh-account-password" hidden data-mode="optional">
<style>
#dsh-account-password{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.42);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#0f1115}
#dsh-account-password[hidden]{display:none}
#dsh-account-password .dsh-pwd-card{width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:22px 22px 18px;border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(15,17,21,.24),0 2px 8px rgba(15,17,21,.08)}
#dsh-account-password h2{margin:0 0 6px;font-size:16px;font-weight:650}
#dsh-account-password .dsh-pwd-sub{margin:0 0 16px;font-size:12px;color:#5b616b}
#dsh-account-password label{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;font-size:12px;color:#3c4149}
#dsh-account-password input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid rgba(15,17,21,.14);border-radius:8px;font:inherit;font-size:13px;background:#fff;color:inherit}
#dsh-account-password input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.16)}
#dsh-account-password .dsh-pwd-error{margin:0 0 10px;font-size:12px;color:#c0392b}
#dsh-account-password .dsh-pwd-error[hidden]{display:none}
#dsh-account-password .dsh-pwd-ok{margin:0 0 12px;font-size:12px;color:#1a7f37}
#dsh-account-password .dsh-pwd-ok[hidden]{display:none}
#dsh-account-password .dsh-pwd-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
#dsh-account-password button{padding:7px 14px;border-radius:8px;border:1px solid rgba(15,17,21,.14);background:#fff;font:inherit;font-size:13px;cursor:pointer}
#dsh-account-password button.dsh-pwd-primary{border-color:#0f1115;background:#0f1115;color:#fff}
#dsh-account-password button:disabled{opacity:.55;cursor:default}
#dsh-account-password button[hidden]{display:none}
@media (prefers-color-scheme: dark){
#dsh-account-password{background:rgba(0,0,0,.55);color:#f3f4f6}
#dsh-account-password .dsh-pwd-card{background:#1c1d21;box-shadow:0 18px 48px rgba(0,0,0,.55)}
#dsh-account-password .dsh-pwd-sub,#dsh-account-password label{color:#a9aeb6}
#dsh-account-password input{background:#141519;border-color:rgba(255,255,255,.14);color:#f3f4f6}
#dsh-account-password button{background:#26272c;border-color:rgba(255,255,255,.14);color:#f3f4f6}
#dsh-account-password button.dsh-pwd-primary{background:#f3f4f6;border-color:#f3f4f6;color:#0f1115}
}
</style>
<div class="dsh-pwd-card" role="dialog" aria-modal="true" aria-labelledby="dsh-pwd-title">
<h2 id="dsh-pwd-title">修改密码</h2>
<p class="dsh-pwd-sub">管理员开户或重置密码后，首次登录必须先改密码；之后可随时修改。</p>
<form id="dsh-pwd-form" autocomplete="off">
<label>当前密码<input id="dsh-pwd-current" type="password" autocomplete="current-password" required></label>
<label>新密码<input id="dsh-pwd-new" type="password" autocomplete="new-password" required></label>
<label>确认新密码<input id="dsh-pwd-confirm" type="password" autocomplete="new-password" required></label>
<p id="dsh-pwd-error" class="dsh-pwd-error" hidden></p>
<p id="dsh-pwd-ok" class="dsh-pwd-ok" hidden></p>
<div class="dsh-pwd-foot">
<button id="dsh-pwd-cancel" type="button">取消</button>
<button id="dsh-pwd-submit" class="dsh-pwd-primary" type="submit">确认修改</button>
</div>
</form>
</div>
</div>
<script>
(() => {
  const root = document.getElementById('dsh-account-password')
  if (!root || root.dataset.ready === '1') return
  root.dataset.ready = '1'

  const form = document.getElementById('dsh-pwd-form')
  const currentEl = document.getElementById('dsh-pwd-current')
  const newEl = document.getElementById('dsh-pwd-new')
  const confirmEl = document.getElementById('dsh-pwd-confirm')
  const errorEl = document.getElementById('dsh-pwd-error')
  const okEl = document.getElementById('dsh-pwd-ok')
  const cancelButton = document.getElementById('dsh-pwd-cancel')
  const submitButton = document.getElementById('dsh-pwd-submit')

  let forced = false
  let busy = false

  function showError(text) {
    errorEl.hidden = text === ''
    errorEl.textContent = text
  }

  function reset() {
    form.reset()
    showError('')
    okEl.hidden = true
    okEl.textContent = ''
    submitButton.hidden = false
    submitButton.textContent = '确认修改'
    submitButton.disabled = false
    cancelButton.hidden = forced
    busy = false
  }

  function open(mode) {
    forced = mode === 'forced'
    root.dataset.mode = forced ? 'forced' : 'optional'
    reset()
    root.hidden = false
    currentEl.focus()
  }

  function close() {
    if (forced) return
    root.hidden = true
  }

  const MESSAGES = ${JSON.stringify(MESSAGES)}

  function messageOf(body, status) {
    const code = body && typeof body.msg === 'string' ? body.msg : ''
    return body && MESSAGES[code] ? MESSAGES[code] : code || '请求失败（' + status + '）'
  }

  async function submit() {
    if (busy) return
    showError('')
    const current = currentEl.value
    const next = newEl.value
    if (next.length < 6) {
      showError('新密码至少 6 位')
      return
    }
    if (next !== confirmEl.value) {
      showError('两次输入的新密码不一致')
      return
    }
    if (next === current) {
      showError('新密码不能和当前密码相同')
      return
    }
    busy = true
    submitButton.disabled = true
    cancelButton.disabled = true
    try {
      const response = await fetch(${JSON.stringify(CHANGE)}, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      let body = null
      try { body = await response.json() } catch {}
      if (!response.ok || (body && body.code !== 0)) {
        showError(messageOf(body, response.status))
        submitButton.disabled = false
        cancelButton.disabled = false
        busy = false
        return
      }
      // 改完刷新页面：服务端一直按库里的用户行判定，刷新后强制标记已经清了。
      okEl.hidden = false
      okEl.textContent = '密码已更新，正在重新加载…'
      submitButton.hidden = true
      setTimeout(() => location.reload(), 600)
    } catch {
      showError('网络错误，请稍后再试')
      submitButton.disabled = false
      cancelButton.disabled = false
      busy = false
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  cancelButton.addEventListener('click', close)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden && !forced) close()
  })

  window.__dshAccountChangePassword = () => open('optional')

  // 管理员开的号、重置过密码的号，进页面先强制改密，改不完不能进工作区。
  fetch(${JSON.stringify(ME)}, { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return
      const body = await response.json()
      const data = body && body.data
      if (data && data.mustChangePassword === true) open('forced')
    })
    .catch(() => undefined)
})()
</script>`
}
