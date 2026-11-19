import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { WebSocket } from 'ws'
import { startClientHost, type ClientHost } from '../../src/client/host.js'
import { MUX_SOCKET_PATH } from '../../src/client/mux/socket.js'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 浏览器 mux 的 WebSocket 载体。
 *
 * 一条 WSS 承载页面的所有逻辑流（`$events`、`session/follow`……），开关与
 * 交互答复也在带内上行，浏览器每源连接数恒等于 1。`P/sse/$mux` 保留为回退，
 * 帧集相同（见 `sse-mux.test.ts`）；这里只验 WSS 载体自己的接线：
 * 握手鉴权、ready、带内 open/close、帧按 channel 分发、带内答复。
 */

const S = 's_muxsock0000000000000000000000'
const FOREIGN = 's_muxsock0000000000000000000001'
const WORKSPACE = 'ws_muxsock00000000000000000000'

interface BrainCall {
  path: string
  headers: IncomingHttpHeaders
  body: unknown
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl = ''
let socketUrl = ''
let cookie = ''
let adminId = ''
const calls: BrainCall[] = []
/** 假脑上仍然打开的上游流，用来往会话里推帧。 */
const streams: ServerResponse[] = []
const sessionStreams = new Map<string, ServerResponse>()

interface MuxFrame {
  type: string
  mux?: string
  channel?: string
  value?: unknown
  error?: { code?: string; message?: string }
  rpcId?: string
  result?: { ok?: boolean; value?: unknown; error?: { code?: string } }
}

/** 一次带内请求：发一条消息，等同 rpcId 的 `server-response`。 */
interface MuxSocketClient {
  readonly frames: MuxFrame[]
  next(predicate: (frame: MuxFrame) => boolean, timeoutMs?: number): Promise<MuxFrame>
  send(message: Record<string, unknown>): void
  /** 发一条带 rpcId 的消息并等它的信封；等待者先于发送注册。 */
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<MuxFrame>
  close(): void
}

beforeAll(async () => {
  platform = await startTestPlatform()

  brain = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      calls.push({ path: url.pathname, headers: req.headers, body })
      const json = (value: unknown, status = 200): void => {
        const payload = JSON.stringify(value)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
        res.end(payload)
      }
      if (req.method === 'GET' && url.pathname.endsWith('/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify({ cursor: -1 })}\n\n`)
        res.write(`data: ${JSON.stringify({ replayed: 0, after: -1 })}\n\n`)
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify({ type: 'ready', seq: -1 })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'status', running: true })}\n\n`)
        streams.push(res)
        const session = /\/sessions\/([^/]+)\/stream$/.exec(url.pathname)?.[1]
        if (session !== undefined) sessionStreams.set(session, res)
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/answers')) {
        json({ accepted: true })
        return
      }
      res.writeHead(404)
      res.end()
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
  socketUrl = `ws://127.0.0.1:${address.port}${MUX_SOCKET_PATH}`

  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  adminId = admin.rows[0]?.id ?? ''
  if (!adminId) throw new Error('没有找到管理员')
  cookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, adminId, platform.config.auth.tokenTtlHours)}`

  await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other', 'other', 'x')`)
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, '默认工作区', '/tmp/w_muxsock', '/desk')`,
    [WORKSPACE, adminId],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`,
    [S, adminId, WORKSPACE],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, 'u_other')`, [FOREIGN])
})

afterAll(async () => {
  for (const stream of streams) stream.destroy()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  brain.closeAllConnections?.()
  await new Promise<void>((resolve) => brain.close(() => resolve()))
  await platform.close()
})

/** 往会话的上游流里推一帧，模拟脑的实时输出。 */
function push(sessionId: string, frame: unknown): void {
  const stream = sessionStreams.get(sessionId)
  if (stream === undefined) throw new Error(`没有 ${sessionId} 的上游流`)
  stream.write(`data: ${JSON.stringify(frame)}\n\n`)
}

function openSocket(header = cookie): Promise<MuxSocketClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(socketUrl, { headers: { cookie: header } })
    const frames: MuxFrame[] = []
    const waiters = new Set<{
      predicate: (frame: MuxFrame) => boolean
      resolve: (frame: MuxFrame) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }>()
    let closed = false

    // 平台在握手后立刻发 ready，先挂 message 监听再等 open。
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as MuxFrame
      frames.push(frame)
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(frame)) continue
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    })
    ws.on('close', () => {
      closed = true
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('socket closed'))
      }
      waiters.clear()
    })
    ws.once('unexpected-response', (_request, response) => {
      reject(new Error(`socket rejected: ${response.statusCode ?? 0}`))
      ws.terminate()
    })
    ws.once('error', (error) => reject(error))

    const client: MuxSocketClient = {
      frames,
      next(predicate, timeoutMs = 6_000) {
        const existing = frames.find(predicate)
        if (existing !== undefined) return Promise.resolve(existing)
        return new Promise<MuxFrame>((done, fail) => {
          const timer = setTimeout(() => {
            waiters.delete(holder)
            fail(new Error(`timed out; seen ${JSON.stringify(frames)}`))
          }, timeoutMs)
          const holder = { predicate, resolve: done, reject: fail, timer }
          waiters.add(holder)
        })
      },
      send(message) {
        ws.send(JSON.stringify(message))
      },
      async request(message, timeoutMs = 6_000) {
        const pending = client.next(
          frame => frame.type === 'server-response' && frame.rpcId === message.rpcId,
          timeoutMs,
        )
        ws.send(JSON.stringify(message))
        return await pending
      },
      close() {
        ws.close()
      },
    }
    void closed

    ws.once('open', () => resolve(client))
  })
}

describe('浏览器 mux socket', () => {
  it('未登录的 Upgrade 在握手阶段 401', async () => {
    await expect(openSocket('')).rejects.toThrow(/401/)
  })

  it('先发 ready 带 mux id，带内 open 后帧按 channel 分发，close 回 end', async () => {
    const client = await openSocket()
    try {
      const ready = await client.next((frame) => frame.type === 'ready')
      expect(ready.mux).toMatch(/^mux_/)

      const access = await client.request({
        type: 'open',
        rpcId: 'rpc-access',
        channel: 'c_access',
        endpoint: 'remoteAccess/follow',
        payload: { args: {} },
      })
      expect(access.result).toMatchObject({ ok: true })

      const events = await client.request({
        type: 'open',
        rpcId: 'rpc-events',
        channel: 'c_events',
        endpoint: '$events',
        payload: { args: {} },
      })
      expect(events.result).toMatchObject({ ok: true })

      const first = await client.next((frame) => frame.type === 'frame' && frame.channel === 'c_access')
      const second = await client.next((frame) => frame.type === 'frame' && frame.channel === 'c_events')
      expect(first.value).toEqual({ type: 'baseline', owner: true })
      expect(second.value).toMatchObject({ type: 'ready' })

      // close 没有回执，直接发；通道关闭时下发 `end`。
      const end = client.next((frame) => frame.type === 'end' && frame.channel === 'c_access')
      client.send({ type: 'close', channel: 'c_access' })
      expect(await end).toEqual({ type: 'end', channel: 'c_access' })
    } finally {
      client.close()
    }
  })

  it('未知端点的 open 回信封错误', async () => {
    const client = await openSocket()
    try {
      await client.next((frame) => frame.type === 'ready')
      const failed = await client.request({
        type: 'open',
        rpcId: 'rpc-bad',
        channel: 'c_bad',
        endpoint: 'nope/nothing',
        payload: { args: {} },
      })
      expect(failed.result?.ok).toBe(false)
      expect(failed.result?.error?.code).toBe('gateway/bad-request')
    } finally {
      client.close()
    }
  })

  it('别人的会话通过带内 open 被拒', async () => {
    const client = await openSocket()
    try {
      await client.next((frame) => frame.type === 'ready')
      const failed = await client.request({
        type: 'open',
        rpcId: 'rpc-foreign',
        channel: 'c_foreign',
        endpoint: 'session/follow',
        payload: { args: { request: { sessionId: FOREIGN } } },
      })
      expect(failed.result?.ok).toBe(false)
      expect(failed.result?.error?.code).toBe('session/not-found')
    } finally {
      client.close()
    }
  })

  it('带内答复把审批结果送到脑的 answers', async () => {
    const client = await openSocket()
    try {
      await client.next((frame) => frame.type === 'ready')

      await client.request({
        type: 'open',
        rpcId: 'rpc-follow',
        channel: 'c_follow',
        endpoint: 'session/follow',
        payload: { args: { request: { sessionId: S } } },
      })
      await client.request({
        type: 'open',
        rpcId: 'rpc-events',
        channel: 'c_events',
        endpoint: '$events',
        payload: { args: {} },
      })
      await client.next((frame) => frame.type === 'frame' && frame.channel === 'c_follow')

      // `$events` 的会话订阅来自 `session/follow`；先把 waterfall 推给平台。
      push(S, {
        type: 'waterfall',
        requestId: 'req_approve_sock',
        kind: 'approval',
        request: { tool: 'bash', wait: { callId: 'call_sock' } },
      })
      const forwarded = await client.next(
        (frame) => frame.type === 'frame' && frame.channel === 'c_events' && (frame.value as { eventId?: string })?.eventId === 'req_approve_sock',
      )
      expect(forwarded.value).toMatchObject({ type: 'waterfall', event: 'approval/request' })

      const answered = await client.request({
        type: 'answer',
        rpcId: 'rpc-answer',
        eventId: 'req_approve_sock',
        outcome: { kind: 'result', value: 'approved' },
      })
      expect(answered.result).toEqual({ ok: true, value: { accepted: true } })

      const answerCall = calls.filter((call) => call.path.endsWith('/answers')).at(-1)
      expect(answerCall).toMatchObject({
        path: `/brain/v1/sessions/${S}/answers`,
        body: { requestId: 'req_approve_sock', outcome: { kind: 'result', value: 'approved' } },
      })
      expect(answerCall?.headers['x-dsh-user-id']).toBe(adminId)
    } finally {
      client.close()
    }
  })
})