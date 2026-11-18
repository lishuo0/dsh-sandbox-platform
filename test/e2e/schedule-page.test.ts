import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { decodeKey } from '../../src/config.js'
import { startHttp } from '../../src/kernel/http.js'
import { seal } from '../../src/kernel/seal.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 官方定时任务页的数据通道：浏览器 → `P/remote/schedule/*` → 脑的 `/brain/v1/schedule/*`。
 * 平台必须按登录成员收口：给脑补会话范围、拒绝越权会话、把页面的
 * 「独立会话」目标落成成员名下的一条真实会话。
 *
 * 脑侧 Remote 的行为在 dsh-sandbox-brain 的单元测试里覆盖；这里只放一个
 * 记录请求的假脑，盯住平台代理改写后的信封。
 */

const OWNED_SESSION = 's_11111111111111111111111111111111'
const FOREIGN_SESSION = 's_22222222222222222222222222222222'

interface Forwarded {
  path: string
  body: {
    type: string
    rpcId: string
    method: string
    payload?: { args?: { request?: Record<string, unknown>; sessionIds?: string[] } }
  }
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let cookie: string
let adminId = ''
let foreignUserId = ''
const forwarded: Forwarded[] = []
const opened: Array<{ sessionId: string }> = []

beforeAll(async () => {
  platform = await startTestPlatform()

  brain = createServer((req, res) => {
    const send = (payload: unknown, status = 200): void => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text ? JSON.parse(text) as Record<string, unknown> : {}
      if (path === '/brain/v1/sessions') {
        opened.push({ sessionId: String(body['sessionId']) })
        send({ sessionId: body['sessionId'], requestId: 'open' }, 201)
        return
      }
      if (path.startsWith('/brain/v1/schedule/')) {
        const envelope = body as unknown as Forwarded['body']
        forwarded.push({ path, body: envelope })
        const value = path === '/brain/v1/schedule/catalog'
          ? []
          : path === '/brain/v1/schedule/list'
            ? { items: [], shown: 0, total: 0, limit: 50, offset: 0 }
            : { id: 'sch_0123456789abcdef' }
        send({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } })
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

  const credentialsKey = decodeKey(platform.config.credentialsKey)
  await platform.db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    [adminId, 'https://api.example.com/v1', ['deepseek-chat'], 'deepseek-chat'],
  )
  await platform.db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    [adminId, 'model-api-key', 'default', seal(credentialsKey, 'sk-platform-secret')],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id, preset_id) VALUES ($1, $2, 'client')`, [
    OWNED_SESSION,
    adminId,
  ])

  // 另一个成员：他的会话不能出现在管理员的 schedule 范围里。
  foreignUserId = 'e2e-other'
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, $2, $3)`,
    [foreignUserId, '别人', 'not-a-real-hash'],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, $2)`, [FOREIGN_SESSION, foreignUserId])
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

async function post(method: string, args: { rpcId: string; request?: unknown; extra?: Record<string, unknown> }): Promise<{
  status: number
  body: Envelope
}> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: args.rpcId,
      method,
      payload: {
        args: {
          ...(args.request === undefined ? {} : { request: args.request }),
          ...(args.extra ?? {}),
        },
      },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

function lastForwarded(path: string): Forwarded {
  const found = forwarded.filter((item) => item.path === path).at(-1)
  if (found === undefined) throw new Error(`假脑没有收到 ${path}`)
  return found
}

describe('定时任务页（平台代理 → 脑）', () => {
  it('catalog 只带当前成员的会话范围', async () => {
    const result = await post('schedule/catalog', { rpcId: 'rpc-catalog' })
    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(true)
    const body = lastForwarded('/brain/v1/schedule/catalog')
    expect(body.body.rpcId).toBe('rpc-catalog')
    const ids = body.body.payload?.args?.sessionIds ?? []
    expect(ids).toContain(OWNED_SESSION)
    expect(ids).not.toContain(FOREIGN_SESSION)
  })

  it('客户端点名别人的会话建任务直接拒掉', async () => {
    const before = forwarded.length
    const result = await post('schedule/create', {
      rpcId: 'rpc-forged',
      request: {
        title: '越权',
        prompt: '往别人的会话里发消息',
        target: { kind: 'session', sessionId: FOREIGN_SESSION },
        timing: { kind: 'every', every_seconds: 300 },
      },
    })
    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('session/not-found')
    expect(forwarded.length).toBe(before)
  })

  it('「独立会话」目标由平台开一条真实会话，并改写 target', async () => {
    const sessionsBefore = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    const result = await post('schedule/create', {
      rpcId: 'rpc-create-new',
      request: {
        title: '每天喝水',
        prompt: '去喝一杯水',
        target: { kind: 'new_once' },
        timing: { kind: 'daily', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } },
      },
    })
    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(true)

    const body = lastForwarded('/brain/v1/schedule/create')
    const request = body.body.payload?.args?.request ?? {}
    const target = request['target'] as { kind: string; sessionId?: string }
    expect(target.kind).toBe('session')
    expect(target.sessionId).toMatch(/^s_[0-9a-f]{32}$/)

    // 新会话记在发起人名下，并且马上进入这次请求的会话范围。
    const created = await platform.db.query<{ user_id: string; preset_id: string; workspace_id: string | null }>(
      `SELECT user_id, preset_id, workspace_id FROM dsh_sessions WHERE id = $1`,
      [target.sessionId],
    )
    expect(created.rows[0]).toMatchObject({ user_id: adminId, preset_id: 'platform' })
    expect(created.rows[0]?.workspace_id).not.toBeNull()
    expect(opened.map((item) => item.sessionId)).toContain(target.sessionId)
    expect(body.body.payload?.args?.sessionIds ?? []).toContain(target.sessionId)

    const sessionsAfter = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    expect(sessionsAfter.rows[0]?.count).toBe((sessionsBefore.rows[0]?.count ?? 0) + 1)
  })

  it('已有会话目标原样转发，不再新建会话', async () => {
    const sessionsBefore = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    const result = await post('schedule/create', {
      rpcId: 'rpc-create-existing',
      request: {
        title: '提醒',
        prompt: '起来走走',
        target: { kind: 'session', sessionId: OWNED_SESSION },
        timing: { kind: 'every', every_seconds: 300 },
      },
    })
    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(true)
    const request = lastForwarded('/brain/v1/schedule/create').body.payload?.args?.request ?? {}
    expect(request['target']).toEqual({ kind: 'session', sessionId: OWNED_SESSION })
    const sessionsAfter = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    expect(sessionsAfter.rows[0]?.count).toBe(sessionsBefore.rows[0]?.count)
  })

  it('编辑 / 立即运行原样转发，并带上成员会话范围', async () => {
    const edit = await post('schedule/edit', {
      rpcId: 'rpc-edit',
      request: { id: 'sch_0123456789abcdef', action: 'update', patch: { active: false } },
    })
    expect(edit.status).toBe(200)
    expect(edit.body.result?.ok).toBe(true)
    const editBody = lastForwarded('/brain/v1/schedule/edit').body
    expect(editBody.payload?.args?.request).toEqual({
      id: 'sch_0123456789abcdef',
      action: 'update',
      patch: { active: false },
    })
    expect(editBody.payload?.args?.sessionIds).toContain(OWNED_SESSION)
    expect(editBody.payload?.args?.sessionIds).not.toContain(FOREIGN_SESSION)

    const run = await post('schedule/run', {
      rpcId: 'rpc-run',
      request: { id: 'sch_0123456789abcdef' },
    })
    expect(run.body.result?.ok).toBe(true)
    const runBody = lastForwarded('/brain/v1/schedule/run').body
    expect(runBody.payload?.args?.request).toEqual({ id: 'sch_0123456789abcdef' })
    expect(runBody.payload?.args?.sessionIds).toContain(OWNED_SESSION)
    expect(runBody.payload?.args?.sessionIds).not.toContain(FOREIGN_SESSION)
  })

  it('历史与清理调用也补范围，清理不要求 request', async () => {
    const history = await post('schedule/history', {
      rpcId: 'rpc-history',
      request: { id: 'sch_0123456789abcdef', limit: 20 },
    })
    expect(history.body.result?.ok).toBe(true)
    const historyBody = lastForwarded('/brain/v1/schedule/history').body
    expect(historyBody.payload?.args?.request).toEqual({ id: 'sch_0123456789abcdef', limit: 20 })
    expect(historyBody.payload?.args?.sessionIds).toContain(OWNED_SESSION)

    const cleaned = await post('schedule/deleteInactive', {
      rpcId: 'rpc-clean',
    })
    expect(cleaned.body.result?.ok).toBe(true)
    const cleanBody = lastForwarded('/brain/v1/schedule/deleteInactive').body
    expect(cleanBody.payload?.args?.sessionIds).toContain(OWNED_SESSION)
    expect(cleanBody.payload?.args?.sessionIds).not.toContain(FOREIGN_SESSION)
  })

  it('「每次新建会话」按输入错误退回，不悄悄换成复用会话', async () => {
    const before = forwarded.length
    const sessionsBefore = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    const result = await post('schedule/create', {
      rpcId: 'rpc-create-new-each',
      request: {
        title: '每次都新建',
        prompt: '跑一次',
        target: { kind: 'new' },
        timing: { kind: 'daily', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } },
      },
    })
    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('schedule/input-invalid')
    expect(result.body.result?.error?.details?.code).toBe('invalid_rule')
    expect(forwarded.length).toBe(before)
    const sessionsAfter = await platform.db.query<{ count: number }>(`SELECT count(*)::int AS count FROM dsh_sessions WHERE user_id = $1`, [adminId])
    expect(sessionsAfter.rows[0]?.count).toBe(sessionsBefore.rows[0]?.count)
  })
})
