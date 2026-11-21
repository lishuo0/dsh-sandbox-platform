import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startClientHost, type ClientHost } from '../../src/client/host.js'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import { decodeKey } from '../../src/config.js'
import { startHttp } from '../../src/kernel/http.js'
import { seal } from '../../src/kernel/seal.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, openSse, readSseUntil, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 真实客户端外壳：加载平台 roster 里的全部浏览器包，经平台 surface 交付。
 * 盯住三件事：Agent 预设包不再进启动图；左下角有登录成员标记；
 * 代理会话列表时不清掉投影提示（客户端拿不到 kind 会断言失败）。
 */

const OWNED_SESSION = 's_0123456789abcdef0123456789abcdef'
const NEW_SESSION = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
/** 成员手建的工作区；显式点名工作区时用它是为了和默认块区分开。 */
const MANUAL_WORKSPACE = 'ws_manual0000000000000000'
/** 别的成员名下的会话；工作区归档必须挡住它。 */
const OTHER_SESSION = 's_cccccccccccccccccccccccccccccccc'
/** 上传用例专用会话；挂在手建工作区上，不额外占一块工作区。 */
const UPLOAD_SESSION = 's_11111111111111111111111111111111'

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let cookie: string
let userId = ''
/** 假脑收到的 /brain/v1/sessions 调用（平台补模型走这条）。 */
const adoptions: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = []
/** 假脑收到的「工作区变了，重新投影」通知。 */
const syncs: Array<Record<string, string | string[] | undefined>> = []
/** 文件树变更跟随用例里假脑的 stat 状态：路径 → 第几次被 stat、是否已删除。 */
const statCounts = new Map<string, number>()
const statGone = new Set<string>()

beforeAll(async () => {
  platform = await startTestPlatform()
  const client: ClientHost = await startClientHost()

  // 假的脑：会话列表、模型目录、建会话、平台补模型。够平台外壳把所有请求走通。
  brain = createServer((req, res) => {
    const send = (payload: unknown, status = 200): void => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    // 平台补模型：POST /brain/v1/sessions（带会话 id 就是认领）。
    if (req.url === '/brain/v1/sessions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        adoptions.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        send({ sessionId: NEW_SESSION, requestId: 'adopt' }, 201)
      })
      return
    }
    // 平台改完工作区后让脑重新投影。
    if (req.url === '/brain/v1/workspaces/sync') {
      syncs.push(req.headers)
      send({ ok: true })
      return
    }
    // 文件树变更跟随：平台的轮询把 stat 转给脑，由沙箱给出 version。
    if (req.url?.includes('/workspace-files/stat')) {
      const path = new URL(req.url, 'http://dsh.local').searchParams.get('path') ?? ''
      if (statGone.has(path)) {
        res.writeHead(404)
        res.end()
        return
      }
      const count = (statCounts.get(path) ?? 0) + 1
      statCounts.set(path, count)
      send({ absolutePath: path, version: `v${count}` })
      return
    }
    // 会话列表、模型目录、发消息都已经是平台自己收口，不再经过脑；
    // 这里只保留平台确实会调脑的两条：认领会话、重新投影工作区。
    res.writeHead(404)
    res.end()
  })
  const brainPort = await freePort()
  await new Promise<void>((resolve, reject) => {
    brain.listen(brainPort, '127.0.0.1', () => resolve())
    brain.once('error', reject)
  })

  const config = {
    ...platform.config,
    brain: { ...platform.config.brain, baseUrl: `http://127.0.0.1:${brainPort}` },
    http: { host: '127.0.0.1', port: await freePort() },
  }
  const surface = createClientSurface(config, platform.db, client)
  server = startHttp(config, platform.db, identityRoutes(platform.deps), surface)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有监听地址')
  baseUrl = `http://127.0.0.1:${address.port}`

  // 登录动作由 integration 覆盖；这里直接签一份平台会话 cookie，绕开脑的启动令牌。
  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  const foundUser = admin.rows[0]?.id
  if (foundUser === undefined) throw new Error('没有找到管理员')
  userId = foundUser
  const token = signToken(platform.config.auth.tokenSecret, userId, platform.config.auth.tokenTtlHours)
  cookie = `${PLATFORM_COOKIE}=${token}`

  // 平台模型配置：地址 + 密钥 + 两个可选模型。客户端请求靠它补上脑需要的凭据。
  const credentialsKey = decodeKey(platform.config.credentialsKey)
  await platform.db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    [userId, 'https://api.example.com/v1', ['deepseek-chat', 'deepseek-reasoner'], 'deepseek-chat'],
  )
  await platform.db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    [userId, 'model-api-key', 'default', seal(credentialsKey, 'sk-platform-secret')],
  )
  // 手建的工作区（不是默认块），给「显式点名工作区」的用例用。
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name)
     VALUES ($1, $2, '手建的工作区', $3, $4, $5)`,
    [MANUAL_WORKSPACE, userId, `/var/agent-desk/${userId}/${MANUAL_WORKSPACE}`, '/desk', `desk-${MANUAL_WORKSPACE}`],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client')`,
    [OWNED_SESSION, userId, MANUAL_WORKSPACE],
  )
  // 另一个成员名下的一条会话，用来验证跨租户被挡住。
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other_tenant', 'other', 'x')`,
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ($1, 'u_other_tenant', '', 'client')`,
    [OTHER_SESSION],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client')`,
    [UPLOAD_SESSION, userId, MANUAL_WORKSPACE],
  )
})

/** 客户端 Remote 调用：统一前缀 + `payload.args.request`。 */
async function postRpc(
  method: string,
  request: unknown,
): Promise<{ result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } }> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-workspace', method, payload: { args: { request } } }),
  })
  return await response.json() as never
}

/** 原始字节上传；返回平台的 JSON 信封（非 JSON 时为 undefined）。 */
async function uploadFile(
  query: { sessionId: string; dir?: string; name: string },
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<{ status: number; json?: { ok?: boolean; value?: { path: string; name: string; bytes: number; requestedName: string }; error?: { code?: string } } }> {
  const params = new URLSearchParams({ dir: '/desk', ...query })
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/workspaceFiles/upload?${params}`, {
    method: 'POST',
    headers: { cookie, 'content-type': contentType },
    body: new Uint8Array(body),
  })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json: json as never }
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

describe('登录后的客户端外壳', () => {
  it('左下角头像进右侧设置页，不弹框、不盖左侧菜单', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('id="dsh-account"')
    expect(html).toContain('id="dsh-account-trigger"')
    expect(html).toContain('id="dsh-account-role"')
    expect(html).toContain('id="dsh-account-menu"')
    expect(html).toContain('id="dsh-account-settings"')
    expect(html).toContain('id="dsh-account-change-password"')
    expect(html).toContain('id="dsh-account-logout"')
    // 强制改密弹窗随外壳下发；账号菜单的「修改密码」复用同一个。
    expect(html).toContain('id="dsh-account-password"')
    expect(html).toContain('window.__dshAccountChangePassword')
    expect(html).toContain('mustChangePassword')
    expect(html).toContain('openSettings')
    expect(html).toContain('closeSettings')
    // 头像挂进侧栏底槽，会话列表只滚自己的区域，不会和头像重叠。
    expect(html).toContain('[class*="footArea"]')
    expect(html).toContain('foot.prepend(root)')
    expect(html).toContain('data-fixed="false"')
    expect(html).toContain('data-rail="true"')
    // Skills / MCP 是左侧菜单入口，不挤在左下角账号菜单里。
    expect(html).not.toContain('id="dsh-account-skills"')
    expect(html).not.toContain('id="dsh-account-mcp"')
    // 左下角头像菜单里的「管理」子菜单：只有管理员能看到，下面挂用户 / 沙箱。
    expect(html).toContain('id="dsh-account-admin"')
    expect(html).toContain("window.__dshConsoleOpen('users')")
    expect(html).toContain("adminRow.hidden = roleKey !== 'admin'")
    expect(html).toContain('"view":"users"')
    expect(html).toContain('"view":"sandboxes"')
    expect(html).toContain('"menu":"account"')
    expect(html).toContain('window.__dshConsoleOpen')
    // 平台自己的 Skills / MCP 配置页随外壳一起下发，入口插进侧栏面板导航。
    expect(html).toContain('id="dsh-console"')
    expect(html).toContain('dsh-console-menu')
    expect(html).toContain('[class*="sidebarCol"]')
    // 视图清单由服务端注入成 JSON 字面量，不再硬编码在浏览器脚本里。
    expect(html).toContain('"view":"skills"')
    expect(html).toContain('"view":"mcp"')
    expect(html).toContain('"view":"users"')
    expect(html).toContain('"view":"sandboxes"')
    expect(html).toContain('"adminOnly":true')
    expect(html).not.toContain('__CONSOLE_VIEWS__')
    // 页面里只有内容区，没有第二套 Skills / MCP 菜单。
    expect(html).not.toContain('admin-page-side')
    expect(html).not.toContain('admin-page-nav')
    expect(html).toContain('id="dsh-console-body"')
    // 设置页同款：左栏导航 + 内容，fixed 钉在侧栏右侧，不盖左侧菜单。
    expect(html).toContain('id="dsh-console-rail"')
    expect(html).toContain('id="dsh-console-nav"')
    expect(html).toContain('data-scope="admin"')
    expect(html).toContain('function mountConsole')
    expect(html).toContain('--dsh-platform-sidebar-width')
    expect(html).toContain('position:fixed')
    expect(html).not.toContain('function mountIntoMain')
    expect(html).not.toContain('id="dsh-console-mask"')
    expect(html).not.toContain('id="dsh-console-panel"')
    // 点到整页之外先返回对话，左侧菜单不会被整页吞掉点击。
    expect(html).toContain("target.closest('#dsh-console-menu')")
    expect(html).toContain("root.contains(target)")
    // 新建 / 编辑是列表页里的表单子页：页头切换成「返回列表 / 保存」，不再叠在网格上方。
    expect(html).toContain('id="dsh-console-return"')
    expect(html).toContain('id="dsh-console-save"')
    expect(html).toContain('function syncHeader')
    expect(html).toContain('function closeForm')
    // Skills / MCP 是卡片网格；用户和沙箱是管理员表格页。
    expect(html).toContain('dsh-card-grid')
    expect(html).toContain('dsh-card-avatar')
    expect(html).toContain('renderUserTable')
    expect(html).toContain('renderSandboxTable')
    expect(html).not.toContain('合集')
    expect(html).toContain('--dsh-platform-sidebar-width')
    expect(html).not.toContain('id="dsh-account-general"')
    expect(html).not.toContain('id="dsh-account-models"')
    expect(html).toContain('/dsh-api/platform/v1/auth/me')
    // 侧边栏工作区标题旁的「新增工作区」入口，弹窗里选 Skills / MCP。
    expect(html).toContain('id="dsh-workspace-create"')
    expect(html).toContain('dsh-workspace-add')
    expect(html).toContain('[data-sidebar-workspace-header]')
    // 入口只留图标，悬浮提示里仍有「新建工作区」。
    expect(html).toContain("'aria-label': '新建工作区'")
    expect(html).not.toContain('dsh-ws-add-label')
    expect(html).not.toContain('data-compact')
    // 左侧菜单只留 Skills / MCP，不再有「文件」「反馈」入口。
    expect(html).not.toContain("view: 'files'")
    expect(html).not.toContain("view: 'feedback'")
    expect(html).not.toContain('openFilesPane')
    // 右侧文件树的页头注入上传按钮，和官方刷新按钮同款。
    expect(html).toContain('data-files-upload')
    expect(html).toContain('/dsh-api/platform/v1/workspaceFiles/upload')
    // 大文件慢传时要有进度条和取消，不只是一个置灰的按钮。
    expect(html).toContain('dsh-files-upload-status')
    expect(html).toContain('data-files-upload-bar')
    expect(html).toContain('data-files-upload-cancel')
    expect(html).toContain("xhr.upload.addEventListener('progress'")
    expect(html).toContain('activeXhr.abort()')
    expect(html).toContain('workspace-file/incomplete')
    expect(html).toContain('id="dsh-ws-skills"')
    expect(html).toContain('id="dsh-ws-mcp"')
    // 工作区选择是「搜索框下拉候选 + 已选卡片网格」，和参考项目一致。
    expect(html).toContain('id="dsh-ws-skills-panel"')
    expect(html).toContain('id="dsh-ws-mcp-panel"')
    expect(html).toContain('dsh-ws-candidate')
    expect(html).toContain('dsh-ws-selected')
    expect(html).toContain('dsh-ws-remove')
    expect(html).toContain('/remote/workspace/create')
    expect(html).toContain('[class*="_settingsArea"]{display:none!important}')
    expect(html).toContain('body>div:has([data-shortcut-modal="settings"])')
    expect(html).not.toContain('[class*="_navList"]{display:none!important}')
    expect(html).not.toContain('模型设置</a>')
    // 设置 → 模型改为平台自有页，读写 /dsh-api/platform/v1/settings/model。
    expect(html).toContain('id="dsh-platform-models"')
    expect(html).toContain('/dsh-api/platform/v1/settings/model')
    // 协议类型和 DSH 客户端一致：OpenAI 兼容 / Responses / Anthropic / Gemini。
    expect(html).toContain('name="api"')
    expect(html).toContain('value="openai-responses"')
    expect(html).toContain('value="anthropic-messages"')
    expect(html).toContain('value="google-generative-ai"')
  })

  it('集成页和工单任务页随外壳下发，都钉在侧栏右侧', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    // 头像菜单的「集成」：飞书机器人 + 群与工作区绑定。
    expect(html).toContain('id="dsh-account-integrations"')
    expect(html).toContain('window.__dshIntegrationsOpen')
    expect(html).toContain('id="dsh-integrations"')
    expect(html).toContain('/superagent/channels')
    expect(html).toContain('/superagent/bindings')
    // 修改机器人 / 绑定在卡片原位展开表单，不在页面顶部另起一块。
    expect(html).toContain('channelFormBody(channel)')
    expect(html).toContain('bindingFormBody(binding)')
    expect(html).toContain("state.form === 'channel' && state.editing === channel.id")
    // 群列表不用手填：选好机器人自动拉取，机器人卡片也能直接进入绑定。
    expect(html).toContain('data-act="channel-bind"')
    expect(html).toContain('syncChats()')
    // 左侧菜单的「工单任务」：自己的工单和执行进度。
    expect(html).toContain('id="dsh-tickets"')
    expect(html).toContain("'dsh-tickets-menu'")
    expect(html).toContain('/superagent/tickets')
    expect(html).toContain('window.__dshTicketsOpen')
    // 列表正文默认折两行，长回复点「展开全文」再看完整内容。
    expect(html).toContain('.dsh-ticket-note.clamp{display:-webkit-box;-webkit-line-clamp:2')
    expect(html).toContain('data-act="expand"')
    expect(html).toContain('展开全文')
    // 两个页面都用设置页同款钉法，不遮住左侧菜单。
    expect(html).toContain('inset:0 0 0 var(--dsh-platform-sidebar-width,280px)')
  })

  it('启动图不再包含 Agent 预设客户端包', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    expect(html).not.toContain('@deepseek-ai/dsh-client-ui-agent-preset')
    expect(html).toContain('@deepseek-ai/dsh-client-ui-settings-general')
  })
  it('启动图包含后台任务的读/停面板与 Remote 命名空间', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    // 脑侧同名包提供 `job` Remote；没有这两个包，浏览器既看不到后台任务也杀不掉它。
    expect(html).toContain('@deepseek-ai/dsh-api-job-controller')
    expect(html).toContain('@deepseek-ai/dsh-client-ui-jobs')
  })

  it('传输适配作为带内容哈希的启动资产在 boot 之前加载', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    // 传输脚本不再内联：head 里是一个 parser-blocking 的 `<script src>`，由
    // index 注入表的顺序保证排在 `window.__ModuleLoader__` 启动脚本之前。
    const match = /<script src="(\/dsh-api\/platform\/v1\/client\/transport\.js\?rev=[0-9a-f]{12})"><\/script>/.exec(html)
    expect(match).not.toBeNull()
    expect(html).not.toContain("var prefix = '/dsh-api/platform/v1'")
    expect(html.indexOf(match![1])).toBeLessThan(html.indexOf('window.__ModuleLoader__'))

    const asset = await fetch(`${baseUrl}${match![1]}`, { headers: { cookie } })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const script = await asset.text()
    expect(script).toContain('__DSH_TRANSPORT__')
    // 逻辑流复用到一条物理 `$mux` 流：否则五条常驻流 + 面板会占满浏览器
    // 每源 6 条 HTTP/1.1 连接，unary 请求（文件列表等）永久排队。
    expect(script).toContain("/sse/$mux")
    expect(script).toContain("'$mux/open'")
    expect(script).toContain("'$mux/close'")
    expect(script).not.toMatch(/\b__name\b/)
  })

  it('启动资产的旧 rev 不写强缓存，HEAD 无正文，未知资产 404', async () => {
    const stale = await fetch(`${baseUrl}/dsh-api/platform/v1/client/transport.js?rev=000000000000`, {
      headers: { cookie },
    })
    expect(stale.status).toBe(200)
    expect(stale.headers.get('cache-control')).toBe('no-store')
    expect(await stale.text()).toContain('__DSH_TRANSPORT__')

    const head = await fetch(`${baseUrl}/dsh-api/platform/v1/client/transport.js`, {
      method: 'HEAD',
      headers: { cookie },
    })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const missing = await fetch(`${baseUrl}/dsh-api/platform/v1/client/nope.js`, { headers: { cookie } })
    expect(missing.status).toBe(404)
  })

  it('remoteAccess/follow 由平台直接答 owner 基线，unary 调用拒绝', async () => {
    // 官方客户端每次挂载都会跟这条流；缺了它浏览器控制台常驻 404，
    // 权限判定也拿不到基线。平台里的每个成员都是自己页面的 owner。
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'remoteAccess/follow', { args: {} }, { cookie, signal: controller.signal })
    expect(response.status).toBe(200)
    const frame = await readSseUntil(response, (value) => (value as { type?: string }).type === 'baseline')
    controller.abort()
    expect(frame).toEqual({ type: 'baseline', owner: true })

    const unary = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/remoteAccess/follow`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ra-1', method: 'remoteAccess/follow', payload: { args: {} } }),
    })
    const body = await unary.json() as { result?: { ok?: boolean; error?: { code?: string } } }
    expect(body.result?.ok).toBe(false)
    expect(body.result?.error?.code).toBe('gateway/bad-request')
  })

  it('设置页的「打开配置文件」按钮在交付的包里被关掉', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    const match = /plugins\/\?\?@deepseek-ai\/dsh-client-ui-settings-general\/client\.js&rev=[0-9a-f]+/.exec(html)
    expect(match).not.toBeNull()
    const bundle = await fetch(`${baseUrl}/${match![0]}`, { headers: { cookie } })
    expect(bundle.status).toBe(200)
    const source = await bundle.text()
    expect(source).toContain('isLoopback&&false?new SettingsDocumentStore(')
    expect(source).not.toContain('$host.isLoopback?new SettingsDocumentStore(')
    expect(source).not.toContain('可选择完整的 Agent 预设切换')
  })

  it('桌面更新通道与侧栏更新角标不随 web 交付包下发', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    const match = /plugins\/\?\?@deepseek-ai\/dsh-client-ui-settings-general\/client\.js&rev=[0-9a-f]+/.exec(html)
    expect(match).not.toBeNull()
    const bundle = await fetch(`${baseUrl}/${match![0]}`, { headers: { cookie } })
    expect(bundle.status).toBe(200)
    const source = await bundle.text()
    expect(source).not.toContain('id:`desktop-update-channel`')
    expect(source).not.toContain('id:`desktop-channel-toast`')
    expect(source).not.toContain('`sidebar.toggle.badge`')
  })

  it('桌面端「预览版说明」欢迎条不随 web 交付包下发', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    const match = /plugins\/\?\?@deepseek-ai\/dsh-client-ui-settings-models\/client\.js&rev=[0-9a-f]+/.exec(html)
    expect(match).not.toBeNull()
    const bundle = await fetch(`${baseUrl}/${match![0]}`, { headers: { cookie } })
    expect(bundle.status).toBe(200)
    const source = await bundle.text()
    expect(source).not.toContain('id:`welcome-notice`')
  })

  it('交付物卡与上下文推荐卡不再携带桌面宿主逻辑', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    const bundleOf = async (id: string): Promise<string> => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = new RegExp(`plugins/\\?\\?${escaped}/client\\.js&rev=[0-9a-f]+`).exec(html)
      expect(match).not.toBeNull()
      const bundle = await fetch(`${baseUrl}/${match![0]}`, { headers: { cookie } })
      expect(bundle.status).toBe(200)
      return bundle.text()
    }
    const deliverables = await bundleOf('@deepseek-ai/dsh-client-ui-deliverables')
    expect(deliverables).not.toContain('fetch(PRESENT_HOST_ROUTE')
    expect(deliverables).not.toContain('host!==null&&host!==`error`&&!host.available&&')
    const context = await bundleOf('dsh-context')
    expect(context).not.toContain('桌面端现已发布')
    expect(context).not.toContain('desktop app is now available')
  })

  it('会话列表由平台从库读出，只含成员自己的会话', async () => {
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/list`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-list', method: 'session/list' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { value: { items: Array<{ sessionId: string; cwd: string; agentAvailable?: boolean }> } }
    }
    const ids = body.result.value.items.map((item) => item.sessionId)
    expect(ids).toContain(OWNED_SESSION)
    expect(ids).not.toContain(OTHER_SESSION)
    const mine = body.result.value.items.find((item) => item.sessionId === OWNED_SESSION)
    expect(mine?.cwd).toBe('/desk')
    expect(mine?.agentAvailable).toBe(true)
  })

  it('模型目录按成员配置改写，不露出占位模型', async () => {
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/modelCatalog`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-catalog',
        method: 'session/modelCatalog',
        payload: { args: { request: {} } },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { value: { default: unknown; routableProviders: string[]; groups: Array<{ id: string; models: Array<{ id: string }> }> } }
    }
    const catalog = body.result.value
    expect(catalog.groups).toEqual([{
      id: 'user',
      name: 'user',
      models: [
        { id: 'deepseek-chat', name: 'deepseek-chat' },
        { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
      ],
    }])
    expect(catalog.default).toEqual({ provider: 'user', model: 'deepseek-chat' })
    expect(catalog.routableProviders).toEqual(['user'])
  })

  it('建会话没带工作区时落到默认工作区，会话、沙箱和模型都指向同一块', async () => {
    const before = adoptions.length
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/create`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-create',
        method: 'session/create',
        payload: { args: { request: { cwd: '/desk/not-a-member-workspace' } } },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { value: { sessionId: string } } }
    // 会话由平台建、平台命名；客户端给的 cwd 不采信。
    const sessionId = body.result.value.sessionId
    expect(sessionId).toMatch(/^s_[0-9a-f]{32}$/)

    // 默认工作区名称固定，成员名下只有这一块默认。
    const defaults = await platform.db.query<{ id: string; name: string; guest_root: string; volume_name: string }>(
      `SELECT id, name, guest_root, volume_name FROM dsh_workspaces WHERE user_id = $1 AND is_default = true`,
      [userId],
    )
    expect(defaults.rows).toHaveLength(1)
    const defaultId = defaults.rows[0]?.id
    expect(defaultId).toMatch(/^ws_[0-9a-f]{24}$/)
    expect(defaults.rows[0]?.name).toBe('默认工作区')
    expect(defaults.rows[0]?.guest_root).toBe('/desk')
    expect(defaults.rows[0]?.volume_name).toBe(`desk-${defaultId}`)

    // 会话记在成员名下，并且挂到了同一个工作区（沙箱注册表靠它路由）。
    const rows = await platform.db.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    )
    expect(rows.rows[0]?.workspace_id).toBe(defaultId)

    // 平台直接走脑的 /brain/v1/sessions（不碰宿主机目录），带上成员模型。
    const adopted = adoptions
      .slice(before)
      .find((call) => (call.body as { sessionId?: string }).sessionId === sessionId)
    expect(adopted).toBeDefined()
    expect(adopted!.headers['x-dsh-model-key']).toBe('sk-platform-secret')
    expect(adopted!.headers['x-dsh-model-base-url']).toBe('https://api.example.com/v1')
    // 老配置没有协议字段，按 OpenAI 兼容下发，脑据此选 `user` 路由。
    expect(adopted!.headers['x-dsh-model-api']).toBe('openai-completions')
    expect(adopted!.headers['x-dsh-model-id']).toBe('deepseek-chat')
    expect(adopted!.headers['x-dsh-model-ids']).toBe('deepseek-chat,deepseek-reasoner')
    expect(adopted!.headers['x-dsh-workspace-id']).toBe(defaultId)
    expect(adopted!.body).toMatchObject({ cwd: '/desk' })
  })

  it('建会话点名成员自己的工作区时用它，不落默认块', async () => {
    const before = adoptions.length
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/create`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-create',
        method: 'session/create',
        payload: { args: { request: { workspaceId: MANUAL_WORKSPACE } } },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { value: { sessionId: string } } }
    const sessionId = body.result.value.sessionId
    expect(sessionId).toMatch(/^s_[0-9a-f]{32}$/)

    const rows = await platform.db.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    )
    expect(rows.rows[0]?.workspace_id).toBe(MANUAL_WORKSPACE)

    const adopted = adoptions
      .slice(before)
      .find((call) => (call.body as { sessionId?: string }).sessionId === sessionId)
    expect(adopted).toBeDefined()
    expect(adopted!.headers['x-dsh-workspace-id']).toBe(MANUAL_WORKSPACE)
    expect(adopted!.body).toMatchObject({ cwd: '/desk' })
  })

  it('客户端带自己分配的会话 id 时沿用它，同一个 id 重试不再新建', async () => {
    const requested = 's_3c5a5232a89772ebc37f222a219b2bf5'
    const create = async () => {
      const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/create`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-create-client-id',
          method: 'session/create',
          payload: { args: { request: { workspaceId: MANUAL_WORKSPACE, sessionId: requested } } },
        }),
      })
      expect(response.status).toBe(200)
      return await response.json() as { result: { ok: boolean; value: { sessionId: string } } }
    }

    const before = adoptions.length
    const first = await create()
    const second = await create()
    expect(first.result.ok).toBe(true)
    expect(first.result.value.sessionId).toBe(requested)
    expect(second.result.value.sessionId).toBe(requested)

    const rows = await platform.db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
      [requested, userId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.workspace_id).toBe(MANUAL_WORKSPACE)

    const adopted = adoptions
      .slice(before)
      .filter((call) => (call.body as { sessionId?: string }).sessionId === requested)
    expect(adopted).toHaveLength(1)
  })

  it('客户端想用别的成员的会话 id 时明确报冲突', async () => {
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/create`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-create-conflict',
        method: 'session/create',
        payload: { args: { request: { sessionId: OTHER_SESSION } } },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { ok: boolean; error: { code: string } } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('session/id-conflict')
  })

  it('发消息进平台的会话队列，不再同步转给脑', async () => {
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/prompt`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-prompt',
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              requestId: 'req-e2e-1',
              sessionId: OWNED_SESSION,
              mode: 'queue',
              content: [{ type: 'text', text: '你好' }],
            },
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect((await response.json() as { result: { ok: boolean } }).result.ok).toBe(true)

    // 原文落进 dsh_session_queue；派发由队列泵在脑空闲时完成，是平台自己的状态。
    const queued = await platform.db.query<{ request_id: string; content: string; user_id: string }>(
      `SELECT request_id, content, user_id FROM dsh_session_queue WHERE session_id = $1`,
      [OWNED_SESSION],
    )
    expect(queued.rows).toHaveLength(1)
    expect(queued.rows[0]).toMatchObject({ request_id: 'req-e2e-1', content: '你好', user_id: userId })
  })

  it('工作区创建由平台落库，再让脑重新投影', async () => {
    const created = await postRpc('workspace/create', { path: '/tmp/客户端传来的宿主路径' })
    expect(created.result?.ok).toBe(true)
    const value = created.result?.value as {
      created: boolean
      workspace: { workspaceId: string; path: string; title: string; sessionIds: string[] }
    }
    expect(value.created).toBe(true)
    expect(value.workspace.title).toBe('新工作区')
    // 路径由平台决定：工作卷挂载点，不是客户端传来的宿主目录。
    expect(value.workspace.path).toBe('/desk')
    const rows = await platform.db.query<{ user_id: string }>(
      `SELECT user_id FROM dsh_workspaces WHERE id = $1`,
      [value.workspace.workspaceId],
    )
    expect(rows.rows[0]?.user_id).toBe(userId)
    // 平台改完库之后通知脑重新投影。
    expect(syncs.at(-1)?.['x-app-id']).toBe(platform.config.brain.appId)
  })

  it('新建工作区时选的 Skills / MCP 由平台落库', async () => {
    await platform.db.query(
      `INSERT INTO dsh_skills (user_id, name, description, scope, enabled) VALUES ($1, 'rpc-skill', '客户端选的', 'private', true)`,
      [userId],
    )
    await platform.db.query(
      `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, scope, enabled)
       VALUES ($1, 'rpc-mcp', 'streamable-http', 'https://mcp.example.com/rpc', 'private', true)`,
      [userId],
    )

    const created = await postRpc('workspace/create', {
      title: '带选择的工作区',
      skills: [{ name: 'rpc-skill', scope: 'private' }],
      mcpServers: [{ name: 'rpc-mcp', scope: 'private' }],
    })
    expect(created.result?.ok).toBe(true)
    const workspaceId = (created.result?.value as { workspace: { workspaceId: string } }).workspace.workspaceId

    const configured = await platform.db.query<{ selection_configured: unknown }>(
      `SELECT selection_configured FROM dsh_workspaces WHERE id = $1`,
      [workspaceId],
    )
    expect(Boolean(configured.rows[0]?.selection_configured)).toBe(true)
    const skills = await platform.db.query(`SELECT skill_name, skill_scope FROM dsh_workspace_skills WHERE workspace_id = $1`, [workspaceId])
    expect(skills.rows).toEqual([{ skill_name: 'rpc-skill', skill_scope: 'private' }])
    const servers = await platform.db.query(`SELECT server_name, server_scope FROM dsh_workspace_mcp_servers WHERE workspace_id = $1`, [workspaceId])
    expect(servers.rows).toEqual([{ server_name: 'rpc-mcp', server_scope: 'private' }])

    // 引用了不存在的条目：整体拒绝，不留下半块工作区。
    const rejected = await postRpc('workspace/create', {
      title: '坏选择',
      skills: [{ name: 'missing-skill', scope: 'private' }],
      mcpServers: [],
    })
    expect(rejected.result?.ok).toBe(false)
    expect(rejected.result?.error?.message).toBe('invalid-selection')
    const leftover = await platform.db.query(`SELECT id FROM dsh_workspaces WHERE name = '坏选择'`)
    expect(leftover.rows.length).toBe(0)
  })

  it('工作区改名、删除同样由平台收口', async () => {
    const created = await postRpc('workspace/create', { title: '临时工作区' })
    const workspaceId = (created.result?.value as { workspace: { workspaceId: string } }).workspace.workspaceId

    const renamed = await postRpc('workspace/rename', { workspaceId, title: '改名后' })
    expect(renamed.result?.ok).toBe(true)
    expect((renamed.result?.value as { workspace: { title: string } }).workspace.title).toBe('改名后')

    const removed = await postRpc('workspace/delete', { workspaceId })
    expect(removed.result?.value).toEqual({ deleted: true })
    const again = await postRpc('workspace/delete', { workspaceId })
    expect(again.result?.ok).toBe(false)
    expect(again.result?.error?.code).toBe('workspace/not-found')
  })

  it('归档只认成员自己的会话', async () => {
    const archived = await postRpc('workspace/archiveSession', { sessionId: OWNED_SESSION })
    expect(archived.result?.ok).toBe(true)
    expect((archived.result?.value as { archivedSessionIds: string[] }).archivedSessionIds).toContain(OWNED_SESSION)
    const rows = await platform.db.query<{ status: string }>(
      `SELECT status FROM dsh_sessions WHERE id = $1`,
      [OWNED_SESSION],
    )
    expect(rows.rows[0]?.status).toBe('archived')

    const foreign = await postRpc('workspace/archiveSession', { sessionId: OTHER_SESSION })
    expect(foreign.result?.ok).toBe(false)
    expect(foreign.result?.error?.code).toBe('session/not-found')
  })

  it('首页加载时给没有工作区的成员补一块默认工作区，并让脑重新投影', async () => {
    // 新成员从没开过会话，也就没有默认工作区；首页选择器会是空的，输入框一直禁用。
    await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_new_home', 'new', 'x')`)
    const token = signToken(platform.config.auth.tokenSecret, 'u_new_home', platform.config.auth.tokenTtlHours)
    const newCookie = `${PLATFORM_COOKIE}=${token}`

    const before = syncs.length
    const first = await fetch(`${baseUrl}/`, { headers: { cookie: newCookie } })
    expect(first.status).toBe(200)

    const rows = await platform.db.query<{ name: string; is_default: unknown }>(
      `SELECT name, is_default FROM dsh_workspaces WHERE user_id = $1`,
      ['u_new_home'],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.name).toBe('默认工作区')
    expect(Boolean(rows.rows[0]?.is_default)).toBe(true)

    // 加载首页时就通知脑重新投影，带的是这个成员。
    expect(syncs.length).toBe(before + 1)
    expect(syncs.at(-1)?.['x-dsh-user-id']).toBe('u_new_home')

    // 再加载一次不会建出第二块。
    await fetch(`${baseUrl}/`, { headers: { cookie: newCookie } })
    const again = await platform.db.query(`SELECT id FROM dsh_workspaces WHERE user_id = $1`, ['u_new_home'])
    expect(again.rows).toHaveLength(1)
  })

  it('平台 auth/me 用登录 cookie 返回当前成员', async () => {
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/auth/me`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { displayName?: string } }
    expect(typeof body.data.displayName).toBe('string')
  })

  it('退出登录清 cookie，页面回到登录页', async () => {
    const out = await fetch(`${baseUrl}/logout`, { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie') ?? '').toContain('platform_session=;')
    const home = await fetch(`${baseUrl}/`)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('<form method="post" action="/login">')
  })
})

describe('文件树变更跟随', () => {
  // 同一条 SSE 只能开一个 reader；按序收集到够用的帧再断开。
  async function framesUntil(
    response: Response,
    until: (frames: unknown[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<unknown[]> {
    if (response.body === null) throw new Error('SSE response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const frames: unknown[] = []
    let buffer = ''
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error(`SSE frames timed out: ${JSON.stringify(frames)}`)
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timed out')), Math.max(1, deadline - Date.now()))),
        ])
        if (chunk.done) throw new Error(`SSE closed early: ${JSON.stringify(frames)}`)
        buffer += decoder.decode(chunk.value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut >= 0) {
          const data = buffer.slice(0, cut)
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          buffer = buffer.slice(cut + 2)
          cut = buffer.indexOf('\n\n')
          if (data === '') continue
          frames.push(JSON.parse(data) as unknown)
          if (until(frames)) return frames
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  it('先发 ready，stat 版本变了再发 change', async () => {
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'workspaceFiles/changes', {
      args: { workspaceFileScopeId: UPLOAD_SESSION, path: '/desk/live.txt' },
    }, { cookie, signal: controller.signal })
    expect(response.status).toBe(200)
    const frames = await framesUntil(
      response,
      (seen) => seen.filter((frame) => (frame as { kind?: string }).kind === 'change').length >= 1,
    )
    controller.abort()
    expect(frames[0]).toEqual({ kind: 'ready' })
    const change = frames.find((frame) => (frame as { kind?: string }).kind === 'change') as {
      kind: string
      change: { absolutePath: string; version: string }
    }
    expect(change.change.absolutePath).toBe('/desk/live.txt')
    expect(change.change.version).toMatch(/^v\d+$/)
  })

  it('文件被删后发 absent，不是停在旧版本', async () => {
    const path = '/desk/delete-me.txt'
    statGone.delete(path)
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'workspaceFiles/changes', {
      args: { workspaceFileScopeId: UPLOAD_SESSION, path },
    }, { cookie, signal: controller.signal })
    expect(response.status).toBe(200)
    const frames = await framesUntil(response, (seen) => {
      // 收到 ready 之后再让文件消失，下一次轮询就要报 absent。
      if (seen.some((frame) => (frame as { kind?: string }).kind === 'ready')) statGone.add(path)
      return seen.some((frame) => {
        const change = (frame as { change?: { absent?: boolean } }).change
        return change?.absent === true
      })
    })
    controller.abort()
    expect(frames[0]).toEqual({ kind: 'ready' })
    expect(frames.at(-1)).toEqual({ kind: 'change', change: { absolutePath: path, absent: true } })
  })

  it('别的成员的会话被挡住，路径为空报 400', async () => {
    const foreign = await fetch(
      `${baseUrl}/dsh-api/platform/v1/sse/workspaceFiles/changes?payload=${encodeURIComponent(Buffer.from(JSON.stringify({ args: { workspaceFileScopeId: OTHER_SESSION, path: '/desk/a.txt' } })).toString('base64url'))}`,
      { headers: { accept: 'text/event-stream', cookie } },
    )
    expect(foreign.status).toBe(404)
    foreign.body?.cancel().catch(() => undefined)

    const empty = await fetch(
      `${baseUrl}/dsh-api/platform/v1/sse/workspaceFiles/changes?payload=${encodeURIComponent(Buffer.from(JSON.stringify({ args: { workspaceFileScopeId: UPLOAD_SESSION, path: ' ' } })).toString('base64url'))}`,
      { headers: { accept: 'text/event-stream', cookie } },
    )
    expect(empty.status).toBe(400)
    empty.body?.cancel().catch(() => undefined)
  })
})

describe('工作区文件上传', () => {
  const objectDir = (): string => join(platform.storageDir, 'desks', MANUAL_WORKSPACE)

  it('原始字节按会话写进工作区对象前缀', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 255])
    const response = await uploadFile(
      { sessionId: UPLOAD_SESSION, dir: '/desk', name: 'photo.bin' },
      bytes,
    )
    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({
      ok: true,
      value: { path: '/desk/photo.bin', name: 'photo.bin', bytes: 5, requestedName: 'photo.bin' },
    })
    // 沙箱的 /desk 挂的就是这个前缀，所以文件树立即可见。
    expect(await readFile(join(objectDir(), 'photo.bin'))).toEqual(bytes)
  })

  it('重名顺延，不覆盖已有文件', async () => {
    const response = await uploadFile(
      { sessionId: UPLOAD_SESSION, dir: '/desk', name: 'photo.bin' },
      Buffer.from('second'),
    )
    expect(response.status).toBe(200)
    expect(response.json?.value?.name).toBe('photo (1).bin')
    expect(response.json?.value?.path).toBe('/desk/photo (1).bin')
    expect((await readFile(join(objectDir(), 'photo (1).bin'))).toString()).toBe('second')
    // 原文件内容没被替换。
    expect(await readFile(join(objectDir(), 'photo.bin'))).toEqual(Buffer.from([0, 1, 2, 3, 255]))
  })

  it('上传到当前子目录', async () => {
    const response = await uploadFile(
      { sessionId: UPLOAD_SESSION, dir: '/desk/docs', name: 'notes.md' },
      Buffer.from('# notes'),
      'text/markdown',
    )
    expect(response.status).toBe(200)
    expect(response.json?.value?.path).toBe('/desk/docs/notes.md')
    expect((await readFile(join(objectDir(), 'docs', 'notes.md'))).toString()).toBe('# notes')
  })

  it('拒绝越出工作区的目录', async () => {
    const response = await uploadFile(
      { sessionId: UPLOAD_SESSION, dir: '/desk/../escape', name: 'x.txt' },
      Buffer.from('x'),
    )
    expect(response.status).toBe(422)
    expect(response.json?.error?.code).toBe('workspace-file/outside-workspace')
    await expect(readFile(join(platform.storageDir, 'desks', MANUAL_WORKSPACE, '..', 'escape', 'x.txt')))
      .rejects.toThrow()
  })

  it('拒绝非法文件名和别人的会话', async () => {
    const badName = await uploadFile(
      { sessionId: UPLOAD_SESSION, dir: '/desk', name: '../evil.txt' },
      Buffer.from('x'),
    )
    expect(badName.status).toBe(422)
    expect(badName.json?.error?.code).toBe('workspace-file/invalid-name')

    const foreign = await uploadFile(
      { sessionId: OTHER_SESSION, dir: '/desk', name: 'x.txt' },
      Buffer.from('x'),
    )
    expect(foreign.status).toBe(404)
    expect(foreign.json?.error?.code).toBe('workspace-file/session-not-found')

    const missing = await uploadFile(
      { sessionId: '', dir: '/desk', name: 'x.txt' },
      Buffer.from('x'),
    )
    expect(missing.status).toBe(400)
    expect(missing.json?.error?.code).toBe('workspace-file/session-required')
  })
})

/**
 * 历史分页和等待输出都必须把 `surfaceOp` 带回去。
 *
 * 浏览器 session store 会拒绝没有 `surfaceOp` 的 surface 事件，一旦漏掉，
 * 整段历史加载失败（`requires a surfaceOp marker`）。
 */
describe('会话历史分页的表面元数据', () => {
  const replaceOp = { op: 'replace', startSeq: 1, endSeq: 1 }

  beforeAll(async () => {
    const events = [
      { seq: 0, type: 'turn/start', data: {} },
      { seq: 1, type: 'system/message', data: { message: { role: 'system', content: [] } }, surfaceOp: 'append' },
      { seq: 2, type: 'user/message', data: { message: { role: 'user', content: [] } }, surfaceOp: 'append' },
      {
        seq: 3,
        type: 'system/message',
        data: { message: { role: 'system', content: [] } },
        surfaceOp: replaceOp,
        sourceEventSeqs: [1],
      },
    ]
    for (const event of events) {
      await platform.db.query(
        `INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`,
        [UPLOAD_SESSION, event.seq, JSON.stringify({ ...event, time: 1_700_000_000_000 + event.seq })],
      )
    }
  })

  type Record = { event: { seq: number; type: string; surfaceOp?: unknown; sourceEventSeqs?: unknown } }

  it('session/page 的分页记录保留 surfaceOp 与 sourceEventSeqs', async () => {
    const response = await postRpc('session/page', { address: { sessionId: UPLOAD_SESSION }, maxMessages: 50 })
    const value = response.result?.value as { records: Record[] } | undefined
    expect(value).toBeDefined()
    const bySeq = new Map((value?.records ?? []).map(record => [record.event.seq, record.event]))
    expect(bySeq.get(1)?.surfaceOp).toBe('append')
    expect(bySeq.get(2)?.surfaceOp).toBe('append')
    expect(bySeq.get(3)?.surfaceOp).toEqual(replaceOp)
    expect(bySeq.get(3)?.sourceEventSeqs).toEqual([1])
    expect(bySeq.get(0)).not.toHaveProperty('surfaceOp')
  })

  it('session/page 的 throughSeq 截断点就是回包 cursor，不被更新的日志尾推高', async () => {
    // 日志已经写到 seq 5，但请求只要截到 3：cursor 必须仍是 3，
    // 末条也是 3。否则浏览器会报 page did not end at its requested cursor。
    for (const seq of [4, 5]) {
      await platform.db.query(
        `INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`,
        [UPLOAD_SESSION, seq, JSON.stringify({ type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn: seq } })],
      )
    }
    const response = await postRpc('session/page', {
      address: { sessionId: UPLOAD_SESSION },
      throughSeq: 3,
      maxMessages: 50,
    })
    const value = response.result?.value as { cursor: number; records: Record[]; hasMore: boolean } | undefined
    expect(value?.cursor).toBe(3)
    expect(value?.records.at(-1)?.event.seq).toBe(3)
    expect(value?.records.map(record => record.event.seq)).toEqual([0, 1, 2, 3])
  })

  it('session/wait 的输出记录保留 surfaceOp', async () => {
    const response = await postRpc('session/wait', { sessionId: UPLOAD_SESSION, afterSeq: -1, timeoutMs: 0 })
    const output = (response.result?.value as { output?: { records: Record[] } } | undefined)?.output
    const records = output?.records ?? []
    const system = records.filter(record => record.event.type === 'system/message')
    expect(system.map(record => record.event.seq)).toEqual([1, 3])
    expect(system[0]?.event.surfaceOp).toBe('append')
    expect(system[1]?.event.surfaceOp).toEqual(replaceOp)
  })

  it('脑不可用时的 REST 事件回退同样保留 surfaceOp 与 sourceEventSeqs', async () => {
    // startTestPlatform 的脑地址不可达，pipeEvents 失败后走数据库回退。
    const response = await fetch(`${platform.baseUrl}/dsh-api/platform/v1/sessions/${UPLOAD_SESSION}/events?after=-1`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const frames = (await response.text())
      .split('\n\n')
      .map(block => block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n'))
      .filter(text => text !== '')
      .map(text => JSON.parse(text) as { seq?: number; type?: string; data?: unknown; surfaceOp?: unknown; sourceEventSeqs?: unknown })

    expect(frames.find(frame => frame.seq === 1)).toMatchObject({ type: 'system/message', surfaceOp: 'append' })
    const replaced = frames.find(frame => frame.seq === 3)
    expect(replaced).toMatchObject({ surfaceOp: replaceOp, sourceEventSeqs: [1] })
    // data 是事件体本身，不是整条持久记录。
    expect(replaced?.data).toEqual({ message: { role: 'system', content: [] } })
  })
})
