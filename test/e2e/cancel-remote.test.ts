import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { decodeKey } from '../../src/config.js'
import { startHttp } from '../../src/kernel/http.js'
import { seal } from '../../src/kernel/seal.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 浏览器停止按钮的取消：`POST P/remote/session/cancel`（Remote `session/cancel`）。
 *
 * 平台必须自己收口，不能原样转给脑的 Remote controller——那条路径只
 * `agent.cancel()`，后台任务照跑、卡死工具也没有强制收尾。平台改走
 * `/brain/v1/sessions/:id/cancel`，由脑停掉会话的后台活动并在超时后强制关闭回合并。
 * 这里用一个记录请求的假脑盯住「平台到底把请求打到了哪里、带没带成员/工作区」。
 */

const OWNED_SESSION = 's_11111111111111111111111111111111'
const FOREIGN_SESSION = 's_22222222222222222222222222222222'

interface BrainCall {
  path: string
  headers: IncomingHttpHeaders
  body: { requestId?: string }
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let cookie: string
let adminId = ''
const calls: BrainCall[] = []
/** 假脑对 cancel 的应答；用例可改成 404 / 500。 */
let brainStatus = 200
let brainErrorCode = 'brain-error'

beforeAll(async () => {
  platform = await startTestPlatform()

  brain = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const text = Buffer.concat(chunks).toString('utf8')
      calls.push({ path, headers: req.headers, body: text ? JSON.parse(text) as { requestId?: string } : {} })
      const send = (payload: unknown, status = 200): void => {
        const body = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      if (/^\/brain\/v1\/sessions\/[^/]+\/cancel$/.test(path)) {
        if (brainStatus !== 200) {
          send({ error: { code: brainErrorCode, message: 'brain said no' } }, brainStatus)
          return
        }
        send({ accepted: true })
        return
      }
      send({ code: 404, msg: 'not found', data: null }, 404)
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
  // `/api` 与 `/login` 不碰外壳资源；这里只需要一个占位客户端宿主。
  const client: ClientHost = {
    indexHtml: '<!doctype html><title>stub</title>',
    shellRoot: platform.storageDir,
    fetchPlugin: async () => undefined,
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

  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  adminId = admin.rows[0]?.id ?? ''
  if (!adminId) throw new Error('没有找到管理员')
  cookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, adminId, platform.config.auth.tokenTtlHours)}`

  // 取消路由要按成员配置解析模型/工作区时会读这两张表；这里只需要它们存在。
  const credentialsKey = decodeKey(platform.config.credentialsKey)
  await platform.db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    [adminId, 'https://api.example.com/v1', ['deepseek-chat'], 'deepseek-chat'],
  )
  await platform.db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    [adminId, 'model-api-key', 'default', seal(credentialsKey, 'sk-platform-secret')],
  )
  // 平台自己收口取消时要按会话解析工作区；会话必须有归属的工作区。
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, '默认工作区', '/tmp/w_cancel', '/desk')`,
    ['ws_cancel0000000000000000000', adminId],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`, [
    OWNED_SESSION,
    adminId,
    'ws_cancel0000000000000000000',
  ])
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other_tenant', 'other', 'x')`,
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, 'u_other_tenant')`, [FOREIGN_SESSION])
})

beforeEach(() => {
  brainStatus = 200
  brainErrorCode = 'brain-error'
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

interface Envelope {
  type?: string
  rpcId?: string
  result?: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string; details?: { code?: string } }
  }
}

async function post(_path: string, rpcId: string, method: string, request?: unknown): Promise<{
  status: number
  body: Envelope
}> {
  // 浏览器面只有统一前缀：旧 `path` 参数保留给用例可读性，真实地址按端点拼。
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args: request === undefined ? {} : { request } },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

const cancelCalls = (): BrainCall[] =>
  calls.filter((call) => /^\/brain\/v1\/sessions\/[^/]+\/cancel$/.test(call.path))

describe('停止按钮（平台收口 → 脑的 cancel）', () => {
  it('收口到 /brain/v1/.../cancel，带上成员与工作区，不把 Remote 原样转发给脑', async () => {
    const before = cancelCalls().length
    const result = await post('/api/session/cancel', 'rpc-cancel-1', 'session/cancel', { sessionId: OWNED_SESSION })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      type: 'server-response',
      rpcId: 'rpc-cancel-1',
      result: { ok: true, value: { accepted: true } },
    })

    const cancel = cancelCalls().slice(before).at(-1)
    expect(cancel).toBeDefined()
    expect(cancel!.path).toBe(`/brain/v1/sessions/${OWNED_SESSION}/cancel`)
    // 用 rpcId 做幂等请求号，脑按它去重。
    expect(cancel!.body).toEqual({ requestId: 'rpc-cancel-1' })
    expect(cancel!.headers['x-app-id']).toBe(platform.config.brain.appId)
    expect(cancel!.headers['x-dsh-user-id']).toBe(adminId)
    expect(cancel!.headers.sessionid).toBe(OWNED_SESSION)
    expect(cancel!.headers['x-request-id']).toBe('rpc-cancel-1')

    // 工作区头指向平台给这条会话落下的默认工作区。
    const rows = await platform.db.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1`,
      [OWNED_SESSION],
    )
    expect(rows.rows[0]?.workspace_id).not.toBeNull()
    expect(cancel!.headers['x-dsh-workspace-id']).toBe(rows.rows[0]?.workspace_id)

    // 原 Remote 请求没有转发给脑：否则上游 controller 会再取消一次、且不收敛后台任务。
    expect(calls.some((call) => call.path === '/api/session/cancel')).toBe(false)
  })

  it('别的成员的会话直接拒掉，脑不会被调用', async () => {
    const before = calls.length
    const result = await post('/api/session/cancel', 'rpc-cancel-foreign', 'session/cancel', {
      sessionId: FOREIGN_SESSION,
    })

    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('session/not-found')
    expect(calls.length).toBe(before)
  })

  it('缺 sessionId 按输入错误退回，不打扰脑', async () => {
    const before = calls.length
    const result = await post('/api/session/cancel', 'rpc-cancel-missing', 'session/cancel', {})

    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('session/id-invalid')
    expect(calls.length).toBe(before)
  })

  it('脑说会话已不在时按会话消失回包', async () => {
    brainStatus = 404
    brainErrorCode = 'session-not-found'
    const result = await post('/api/session/cancel', 'rpc-cancel-404', 'session/cancel', {
      sessionId: OWNED_SESSION,
    })

    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('session/not-found')
    expect(result.body.result?.error?.details?.code).toBe('session-not-found')
  })

  it('脑不可达/出错按平台内部错误回包，而不是假装已取消', async () => {
    brainStatus = 500
    brainErrorCode = 'boom'
    const result = await post('/api/session/cancel', 'rpc-cancel-500', 'session/cancel', {
      sessionId: OWNED_SESSION,
    })

    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('gateway/internal')
    expect(result.body.result?.error?.details?.code).toBe('boom')
  })
})
