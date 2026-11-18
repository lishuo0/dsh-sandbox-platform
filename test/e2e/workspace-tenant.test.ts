import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { startClientHost, type ClientHost } from '../../src/client/host.js'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import {
  freePort,
  openSse,
  readSseUntil,
  startTestPlatform,
  type TestPlatform,
} from '../helpers/app.js'

/**
 * 排序、置顶、归档、设置写入和会话流都必须只作用于当前成员。
 *
 * 这里的两个成员各自有工作区和会话；跨租户的 id 一律在**开流之前**拒绝，
 * 排序/置顶的返回值也只能包含自己的 id。进程级的 settings 命名空间在浏览器
 * 面上不存在；`GET /api/socket` 这类旧 Upgrade 面也不再存在（非 101）。
 */

const ME = 'u_me'
const OTHER = 'u_other'
const MY_WORKSPACES = ['ws_a1', 'ws_a2', 'ws_a3']
const OTHER_WORKSPACE = 'ws_b1'
const MY_SESSIONS = ['s_a1', 's_a2', 's_a3']
const OTHER_SESSION = 's_b1'

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let myCookie: string
let tokenSecret: string
/** 假脑收到的所有请求路径，用来确认被拒的调用没有漏过去。 */
const brainPaths: string[] = []
/** 假脑收到的请求头，用来确认平台没有把浏览器凭证 / 租户断言转发过去。 */
const brainHeaders: Array<{ path: string; headers: IncomingHttpHeaders }> = []
let workspacesSynced = 0
/** 让假脑的 cancel 接口失败，验证归档不会被停止动作挡住。 */
let cancelFails = false

beforeAll(async () => {
  platform = await startTestPlatform()
  const client: ClientHost = await startClientHost()

  brain = createServer((req, res) => {
    brainPaths.push(req.url ?? '')
    brainHeaders.push({ path: req.url ?? '', headers: req.headers })
    const send = (payload: unknown, status = 200): void => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    const sse = (frames: readonly unknown[]): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.end()
    }
    if (cancelFails && (req.url ?? '').startsWith('/brain/v1/sessions/') && (req.url ?? '').endsWith('/cancel')) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'brain/busy' }))
      req.resume()
      return
    }
    if (req.url === '/brain/v1/workspaces/sync') {
      workspacesSynced += 1
      send({ ok: true })
      return
    }
    // 会话实时面：平台对脑的唯一上游连接。
    if (/^\/brain\/v1\/sessions\/[^/]+\/stream$/.test(req.url ?? '')) {
      sse([{ type: 'ready', seq: 0 }])
      return
    }
    // 后台任务清单。
    if (/^\/brain\/v1\/sessions\/[^/]+\/jobs$/.test(req.url ?? '')) {
      sse([{ type: 'rows', jobs: [{ id: 'job-mine', status: 'running' }] }])
      return
    }
    // 分叉：脑返回新会话 id 的原始值（平台按它落一条会话）。
    if (/^\/brain\/v1\/sessions\/[^/]+\/fork$/.test(req.url ?? '')) {
      req.resume()
      send({ sessionId: 's_fork000000000000000000000000000' })
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let rpcId: unknown = 'rpc-brain'
      try {
        rpcId = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId?: unknown }).rpcId
      } catch {
        /* 非 JSON 请求保持默认 rpcId */
      }
      if (req.url === '/api/settings/describe') {
        send({ type: 'server-response', rpcId, result: { ok: true, value: { namespaces: [] } } })
        return
      }
      send({ type: 'server-response', rpcId, result: { ok: true, value: {} } })
    })
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

  for (const [id, name] of [[ME, 'me'], [OTHER, 'other']]) {
    await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, $2, 'x')`, [id, name])
  }
  // 停用的成员即使还拿着未过期的 token 也不能再进来。
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, status) VALUES ('u_dead', 'dead', 'x', 'suspended')`,
  )
  // 我：三块工作区（最近活跃倒序 a3、a2、a1），每块一条会话。
  for (const [index, id] of MY_WORKSPACES.entries()) {
    await platform.db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, created_at, last_active_at)
       VALUES ($1, $2, $3, '/tmp', '/desk', $4, $4)`,
      [id, ME, id, `2026-01-0${index + 1}T00:00:00.000Z`],
    )
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, created_at, last_active_at)
       VALUES ($1, $2, $3, '', $4, $4)`,
      [MY_SESSIONS[index], ME, id, `2026-01-0${index + 1}T00:00:00.000Z`],
    )
  }
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root)
     VALUES ($1, $2, 'other', '/tmp', '/desk')`,
    [OTHER_WORKSPACE, OTHER],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES ($1, $2, $3, '')`,
    [OTHER_SESSION, OTHER, OTHER_WORKSPACE],
  )

  const token = signToken(config.auth.tokenSecret, ME, config.auth.tokenTtlHours)
  tokenSecret = config.auth.tokenSecret
  myCookie = `${PLATFORM_COOKIE}=${token}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

interface RpcFrame {
  type?: string
  rpcId?: string
  result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
}

async function post(method: string, request: unknown): Promise<RpcFrame> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/${method}`, {
    method: 'POST',
    headers: { cookie: myCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-e2e', method, payload: { args: { request } } }),
  })
  expect(response.status).toBe(200)
  return await response.json() as RpcFrame
}

function valueOf(frame: RpcFrame): Record<string, unknown> {
  expect(frame.result?.ok).toBe(true)
  return frame.result?.value as Record<string, unknown>
}

function codeOf(frame: RpcFrame): string | undefined {
  expect(frame.result?.ok).toBe(false)
  return frame.result?.error?.code
}

async function workspaceSortOrders(): Promise<Record<string, number>> {
  const rows = await platform.db.query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM dsh_workspaces ORDER BY id`,
  )
  return Object.fromEntries(rows.rows.map((row) => [row.id, Number(row.sort_order)]))
}

describe('工作区排序与置顶按成员隔离', () => {
  it('insertBefore 只重排自己的工作区，响应里没有别人的 id', async () => {
    const frame = await post('workspace/insertBefore', {
      workspaceId: 'ws_a1',
      beforeWorkspaceId: 'ws_a3',
    })
    expect(valueOf(frame)).toEqual({ workspaceIds: ['ws_a1', 'ws_a3', 'ws_a2'] })
    expect(await workspaceSortOrders()).toEqual({
      ws_a1: 1,
      ws_a3: 2,
      ws_a2: 3,
      ws_b1: 0,
    })
    expect(workspacesSynced).toBeGreaterThan(0)
  })

  it('拿别人的工作区做锚点会被拒绝，且不改任何顺序', async () => {
    await post('workspace/insertBefore', { workspaceId: 'ws_a2', beforeWorkspaceId: 'ws_a3' })
    const before = await workspaceSortOrders()
    const frame = await post('workspace/insertBefore', {
      workspaceId: 'ws_a2',
      beforeWorkspaceId: OTHER_WORKSPACE,
    })
    expect(codeOf(frame)).toBe('workspace/not-found')
    expect(await workspaceSortOrders()).toEqual(before)
  })

  it('insertSessionBefore 只重排自己的会话', async () => {
    const frame = await post('workspace/insertSessionBefore', {
      workspaceId: 'ws_a1',
      sessionId: 's_a1',
    })
    const value = valueOf(frame) as { workspace?: { workspaceId: string; sessionIds: string[] } }
    // 没给锚点＝移到末尾；工作区里只有我自己的会话。
    expect(value.workspace?.workspaceId).toBe('ws_a1')
    expect(value.workspace?.sessionIds).toEqual(['s_a1'])
  })

  it('insertSessionBefore 拒绝别人的会话', async () => {
    const frame = await post('workspace/insertSessionBefore', {
      workspaceId: 'ws_a1',
      sessionId: OTHER_SESSION,
    })
    expect(codeOf(frame)).toBe('session/not-found')
  })

  it('pinSession / unpinSession 只碰自己的置顶', async () => {
    expect(valueOf(await post('workspace/pinSession', { sessionId: 's_a1' }))).toEqual({
      pinnedSessionIds: ['s_a1'],
    })
    const other = await platform.db.query<{ pinned_at: string | null }>(
      `SELECT pinned_at FROM dsh_sessions WHERE id = $1`,
      [OTHER_SESSION],
    )
    expect(other.rows[0]?.pinned_at).toBeNull()
    expect(valueOf(await post('workspace/unpinSession', { sessionId: 's_a1' }))).toEqual({
      pinnedSessionIds: [],
    })
  })

  it('pinSession 拒绝别人的会话', async () => {
    const frame = await post('workspace/pinSession', { sessionId: OTHER_SESSION })
    expect(codeOf(frame)).toBe('session/not-found')
  })

  it('归档清掉置顶，归档会话不能再置顶', async () => {
    await post('workspace/pinSession', { sessionId: 's_a2' })
    const archived = valueOf(await post('workspace/archiveSession', { sessionId: 's_a2' }))
    expect(archived).toEqual({ archivedSessionIds: ['s_a2'] })
    const row = await platform.db.query<{ pinned_at: string | null }>(
      `SELECT pinned_at FROM dsh_sessions WHERE id = 's_a2'`,
    )
    expect(row.rows[0]?.pinned_at).toBeNull()
    expect(codeOf(await post('workspace/pinSession', { sessionId: 's_a2' }))).toBe('gateway/bad-request')
  })
})

describe('SSE 流同样按成员拦截', () => {
  it('自己的会话能拿到 snapshot，脑收到的是平台凭据', async () => {
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'session/follow', {
      args: { request: { sessionId: 's_a1' } },
    }, { cookie: myCookie, signal: controller.signal })
    expect(response.status).toBe(200)
    const frame = await readSseUntil(response, value => (value as { type?: string }).type === 'snapshot')
    expect(frame).toMatchObject({ type: 'snapshot', cursor: expect.any(Number) })
    controller.abort()

    await vi.waitFor(() => {
      const seen = [...brainHeaders].reverse().find((entry) => entry.path === '/brain/v1/sessions/s_a1/stream')
      expect(seen).toBeDefined()
      expect(seen?.headers['x-app-id']).toBe(platform.config.brain.appId)
      expect(seen?.headers['x-dsh-user-id']).toBe(ME)
      // 浏览器带来的 cookie 一律不转给脑；凭据换成平台自己的应用密钥。
      expect(seen?.headers.cookie).toBeUndefined()
      expect(seen?.headers['x-app-key']).toBe(platform.config.brain.appKey)
    }, { timeout: 3_000 })
  })

  it('点别人的会话：开流之前就 404，脑不会被连上', async () => {
    const before = brainPaths.filter((path) => path.startsWith('/brain/v1/sessions/')).length
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'session/follow', {
      args: { request: { sessionId: OTHER_SESSION } },
    }, { cookie: myCookie, signal: controller.signal })
    expect(response.status).toBe(404)
    controller.abort()
    expect(brainPaths.filter((path) => path.startsWith('/brain/v1/sessions/')).length).toBe(before)
  })

  it('job/list 只按自己的会话向脑开流', async () => {
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'job/list', {
      args: { request: { sessionId: 's_a1' } },
    }, { cookie: myCookie, signal: controller.signal })
    expect(response.status).toBe(200)
    const frame = await readSseUntil(response, value => (value as { type?: string }).type === 'rows')
    expect(frame).toMatchObject({ type: 'rows', jobs: [{ id: 'job-mine', status: 'running' }] })
    controller.abort()
    expect(brainPaths).toContain('/brain/v1/sessions/s_a1/jobs')
  })

  it('job/follow 点别人的会话直接 404', async () => {
    const before = brainPaths.length
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'job/follow', {
      args: { request: { sessionId: OTHER_SESSION, jobId: 'job-x' } },
    }, { cookie: myCookie, signal: controller.signal })
    expect(response.status).toBe(404)
    controller.abort()
    expect(brainPaths.length).toBe(before)
  })

  it('旧 Upgrade 面不存在：握手拿不到 101', async () => {
    const text = await upgradeProbe('/api/socket')
    expect(text.startsWith('HTTP/1.1 101')).toBe(false)
  })
})

describe('settings 写入在平台侧被拒绝', () => {
  it.each(['settings/mutate', 'settings/update', 'settings/replace'])(
    '%s 返回 gateway/not-found，且不转发给脑',
    async (method) => {
      const before = brainPaths.length
      const frame = await post(method, { namespace: 'permission', value: { mode: 'yolo' } })
      expect(codeOf(frame)).toBe('gateway/not-found')
      expect(brainPaths.length).toBe(before)
    },
  )
})

describe('进程级接口不暴露给浏览器', () => {
  it.each([
    'pluginManager/list',
    'account/profile',
    'credentials/list',
    'mcpManager/servers',
    'directoryPicker/pick',
    'session/openWorkspacePath',
  ])('%s 回 gateway/not-found 且不转发', async (method) => {
    const before = brainPaths.length
    const frame = await post(method, {})
    expect(codeOf(frame)).toBe('gateway/not-found')
    expect(brainPaths.length).toBe(before)
  })

  it('initializeDefaultModel 由平台直接成功应答，不碰脑', async () => {
    const before = brainPaths.length
    const frame = await post('session/initializeDefaultModel', {})
    expect(frame.result?.ok).toBe(true)
    expect(brainPaths.length).toBe(before)
  })
})

describe('前缀之外一律 404', () => {
  it('旧的 GET 接口不再存在', async () => {
    const response = await fetch(`${baseUrl}/api/session/export?sessionId=s_a1`, { headers: { cookie: myCookie } })
    expect(response.status).toBe(404)
  })

  it('自定义 HTTP 动词也不会被兜底转发', async () => {
    const response = await fetch(`${baseUrl}/api/session/modelCatalog`, {
      method: 'POST',
      headers: { cookie: myCookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })
})

describe('停用成员', () => {
  it('旧 token 访问 P 面返回 401', async () => {
    const dead = signToken(tokenSecret, 'u_dead', 1)
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/session/modelCatalog`, {
      method: 'POST',
      headers: { cookie: `${PLATFORM_COOKIE}=${dead}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-dead', method: 'session/modelCatalog', payload: { args: { request: {} } } }),
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('unauthorized')
  })
})

describe('登录 cookie 的传输约束', () => {
  function loginHeaders(proto?: string): HeadersInit {
    return {
      'content-type': 'application/x-www-form-urlencoded',
      ...(proto === undefined ? {} : { 'x-forwarded-proto': proto }),
    }
  }

  async function loginCookie(proto?: string): Promise<string> {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: loginHeaders(proto),
      body: new URLSearchParams({
        username: platform.config.auth.adminUsername,
        password: platform.config.auth.adminPassword,
      }),
    })
    expect(response.status).toBe(302)
    return response.headers.get('set-cookie') ?? ''
  }

  it('明文 HTTP 下不加 Secure，否则浏览器不会回传 cookie', async () => {
    const cookie = await loginCookie()
    expect(cookie).toContain(`${PLATFORM_COOKIE}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure')
  })

  it('反向代理声明 https 时加 Secure', async () => {
    expect(await loginCookie('https')).toContain('Secure')
  })

  it('登出时按同样的协议清理 cookie', async () => {
    const response = await fetch(`${baseUrl}/logout`, { method: 'POST', headers: loginHeaders('https') })
    expect(response.status).toBe(204)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Secure')
  })
})

describe('fork 只认自己的源会话', () => {
  // 脑的 SessionForkRequest 只有 `sessionId`，它就是源会话；子会话 id 由脑返回。
  it('源会话是别人的直接拒绝，不转发给脑', async () => {
    const before = brainPaths.length
    const frame = await post('session/fork', { sessionId: OTHER_SESSION })
    expect(codeOf(frame)).toBe('session/not-found')
    expect(brainPaths.length).toBe(before)
  })

  it('源会话是自己的照常转发', async () => {
    const frame = await post('session/fork', { sessionId: 's_a1' })
    expect(frame.result?.ok).toBe(true)
    expect(brainPaths).toContain('/brain/v1/sessions/s_a1/fork')
  })
})

describe('归档先停回合', () => {
  function cancelCalls(sessionId: string): number {
    return brainPaths.filter((path) => path === `/brain/v1/sessions/${sessionId}/cancel`).length
  }

  it('归档前给脑发 cancel，停止失败也不挡归档落库', async () => {
    const before = cancelCalls('s_a3')
    const archived = await post('workspace/archiveSession', { sessionId: 's_a3' })
    expect(valueOf(archived)).toEqual({ archivedSessionIds: expect.arrayContaining(['s_a3']) })
    expect(cancelCalls('s_a3')).toBe(before + 1)

    expect(valueOf(await post('workspace/unarchiveSession', { sessionId: 's_a3' }))).toBeDefined()
    cancelFails = true
    try {
      const again = await post('workspace/archiveSession', { sessionId: 's_a3' })
      expect(again.result?.ok).toBe(true)
      expect(cancelCalls('s_a3')).toBe(before + 2)
      const rows = await platform.db.query<{ status: string }>(
        `SELECT status FROM dsh_sessions WHERE id = 's_a3'`,
      )
      expect(rows.rows[0]?.status).toBe('archived')
    } finally {
      cancelFails = false
    }
  })

  it('归档别人的会话不发 cancel', async () => {
    const before = cancelCalls(OTHER_SESSION)
    expect(codeOf(await post('workspace/archiveSession', { sessionId: OTHER_SESSION }))).toBe('session/not-found')
    expect(cancelCalls(OTHER_SESSION)).toBe(before)
  })
})

/** 发一次 WebSocket 握手，返回服务端写回的第一段字节（可能是空串）。 */
async function upgradeProbe(path: string): Promise<string> {
  const port = Number(new URL(baseUrl).port)
  return await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      )
    })
    let text = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(text)
    }
    socket.setTimeout(2_000, finish)
    socket.on('data', (chunk) => { text += chunk.toString('utf8') })
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', (error) => {
      if (text === '') reject(error)
      else finish()
    })
  })
}
