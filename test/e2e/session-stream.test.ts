import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { PLATFORM_COOKIE, createClientSurface, type ClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { answersPath, sessionStreamPath } from '../../src/client/mux/protocol.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 平台会话级实时面：真实 HTTP + 假脑的 SSE。
 *
 * 验的是接线与授权，不重复脑侧的协议细节：
 * 浏览器只有一条到平台的 SSE；平台先按成员归属判定，再建到脑的连接；
 * 下行的帧原样下发；上行的答复只转发到同一会话的答复接口。
 */

const OWNED = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FOREIGN = 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const MISSING = 's_cccccccccccccccccccccccccccccccc'

interface BrainRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
}

const brainRequests: BrainRequest[] = []
const streams: { path: string; res: ServerResponse; closed: boolean }[] = []
const answers: { path: string; body: unknown }[] = []
let answerStatus = 200
let brain: Server
let platform: TestPlatform
let server: Server
let surface: ClientSurface
let ownedCookie = ''
let foreignCookie = ''

beforeAll(async () => {
  brain = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    brainRequests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers })
    if (req.method === 'GET' && url.pathname.endsWith('/stream')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.write(': connected\n\n')
      const entry = { path: url.pathname, res, closed: false }
      streams.push(entry)
      req.on('close', () => { entry.closed = true })
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/answers')) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        let body: unknown = Buffer.concat(chunks).toString('utf8')
        try {
          body = JSON.parse(body as string) as unknown
        } catch {
          /* keep the raw text */
        }
        answers.push({ path: url.pathname, body })
        res.writeHead(answerStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answerStatus === 200 ? { accepted: true } : { error: { code: 'session/mismatch' } }))
      })
      return
    }
    res.writeHead(404, { 'content-length': 0 })
    res.end()
  })
  const brainPort = await freePort()
  await new Promise<void>((resolve, reject) => {
    brain.listen(brainPort, '127.0.0.1', () => resolve())
    brain.once('error', reject)
  })

  platform = await startTestPlatform()
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
  surface = createClientSurface(config, platform.db, client)
  server = startHttp(config, platform.db, [], surface)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有监听地址')
  platform.baseUrl = `http://127.0.0.1:${address.port}`

  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  const ownerId = admin.rows[0]?.id ?? ''
  if (!ownerId) throw new Error('没有找到管理员')
  ownedCookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, ownerId, platform.config.auth.tokenTtlHours)}`

  await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other', 'other', 'x')`)
  foreignCookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, 'u_other', platform.config.auth.tokenTtlHours)}`
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id, preset_id) VALUES ($1, $2, 'client')`, [OWNED, ownerId])
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, 'u_other')`, [FOREIGN])
})

beforeEach(() => {
  answers.length = 0
  answerStatus = 200
})

afterAll(async () => {
  for (const entry of streams) entry.res.destroy()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  brain.closeAllConnections?.()
  await new Promise<void>((resolve) => brain.close(() => resolve()))
  await platform.close()
})

/** 浏览器侧 SSE 客户端：解析 `event: frame`。 */
interface BrowserStream {
  status: number
  frames: Record<string, unknown>[]
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): void
}

async function openBrowserStream(path: string, cookie?: string, method = 'GET'): Promise<BrowserStream> {
  const controller = new AbortController()
  const response = await fetch(`${platform.baseUrl}${path}`, {
    method,
    headers: {
      accept: 'text/event-stream',
      ...(cookie === undefined ? {} : { cookie }),
    },
    signal: controller.signal,
  })
  const frames: Record<string, unknown>[] = []
  if (response.status !== 200 || response.body === null) {
    return { status: response.status, frames, waitFor: async () => { throw new Error('不是 SSE 响应') }, close: () => controller.abort() }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const split = buffer.indexOf('\n\n')
          if (split === -1) break
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const lines = block.split('\n')
          if (lines.every((line) => line === '' || line.startsWith(':'))) continue
          let event = 'message'
          let data = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (event !== 'frame' || data === '') continue
          frames.push(JSON.parse(data) as Record<string, unknown>)
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return {
    status: 200,
    frames,
    waitFor(predicate, timeoutMs = 3_000) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs
        const tick = (): void => {
          const found = frames.find(predicate)
          if (found !== undefined) {
            resolve(found)
            return
          }
          if (Date.now() > deadline) {
            reject(new Error(`等待帧超时：${frames.map((frame) => String(frame.type)).join(',')}`))
            return
          }
          setTimeout(tick, 5)
        }
        tick()
      })
    },
    close: () => {
      controller.abort()
      reader.cancel().catch(() => undefined)
    },
  }
}

function pushFrame(frame: unknown): void {
  const entry = streams.at(-1)
  if (entry === undefined) throw new Error('还没有上游流')
  entry.res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
}

async function postAnswer(path: string, body: unknown, cookie?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${platform.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    /* raw text */
  }
  return { status: response.status, body: parsed }
}

describe('会话级实时面（平台中转）', () => {
  it('未登录 401，且不建立到脑的连接', async () => {
    const before = brainRequests.length
    const client = await openBrowserStream(sessionStreamPath(OWNED))
    expect(client.status).toBe(401)
    expect(brainRequests.length).toBe(before)
  })

  it('别人的会话 404，且不建立到脑的连接', async () => {
    const before = brainRequests.length
    const client = await openBrowserStream(sessionStreamPath(OWNED), foreignCookie)
    expect(client.status).toBe(404)
    expect(brainRequests.length).toBe(before)
  })

  it('不存在的会话 404', async () => {
    const before = brainRequests.length
    const client = await openBrowserStream(sessionStreamPath(MISSING), ownedCookie)
    expect(client.status).toBe(404)
    expect(brainRequests.length).toBe(before)
  })

  it('归属通过后建立一条到脑的 SSE，帧原样下发', async () => {
    const before = streams.length
    const client = await openBrowserStream(sessionStreamPath(OWNED), ownedCookie)
    expect(client.status).toBe(200)
    const deadline = Date.now() + 3_000
    while (streams.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const upstream = brainRequests.filter((item) => item.path === `/brain/v1/sessions/${OWNED}/stream`).at(-1)
    expect(upstream?.headers['x-app-id']).toBe(platform.config.brain.appId)
    expect(upstream?.headers['x-app-key']).toBe(platform.config.brain.appKey)
    expect(upstream?.headers['x-dsh-user-id']).not.toBe('')

    pushFrame({ type: 'ready', sessionId: OWNED, seq: -1 })
    pushFrame({ type: 'waterfall', requestId: 'r1', kind: 'approval', request: { tool: 'bash' } })
    expect(await client.waitFor((frame) => frame.type === 'ready')).toMatchObject({
      type: 'ready',
      sessionId: OWNED,
      seq: -1,
    })
    expect(await client.waitFor((frame) => frame.type === 'waterfall')).toMatchObject({
      type: 'waterfall',
      requestId: 'r1',
      kind: 'approval',
    })
    client.close()
  })

  it('答复转发到同一会话的脑答复接口，body 原样', async () => {
    const client = await openBrowserStream(sessionStreamPath(OWNED), ownedCookie)
    try {
      const outcome = { kind: 'result', value: 'approved' }
      const reply = await postAnswer(answersPath(OWNED), { requestId: 'r1', outcome }, ownedCookie)
      expect(reply.status).toBe(200)
      expect(reply.body).toEqual({ accepted: true })
      expect(answers).toEqual([
        { path: `/brain/v1/sessions/${OWNED}/answers`, body: { requestId: 'r1', outcome } },
      ])
    } finally {
      client.close()
    }
  })

  it('答复体的会话与路径不符时 409，脑未被调用', async () => {
    const reply = await postAnswer(answersPath(OWNED), { requestId: 'r1', sessionId: FOREIGN, outcome: { kind: 'result' } }, ownedCookie)
    expect(reply.status).toBe(409)
    expect(answers).toEqual([])
  })

  it('答复体形状不对时 400，脑未被调用', async () => {
    const reply = await postAnswer(answersPath(OWNED), { requestId: 'r1' }, ownedCookie)
    expect(reply.status).toBe(400)
    expect(answers).toEqual([])
  })

  it('外租户答复一律 404，脑未被调用', async () => {
    const reply = await postAnswer(answersPath(OWNED), { requestId: 'r1', outcome: { kind: 'result' } }, foreignCookie)
    expect(reply.status).toBe(404)
    expect(answers).toEqual([])
  })

  it('脑拒绝时按脑的状态码回传', async () => {
    answerStatus = 409
    const reply = await postAnswer(answersPath(OWNED), { requestId: 'r1', outcome: { kind: 'result' } }, ownedCookie)
    expect(reply.status).toBe(409)
    expect(answers).toHaveLength(1)
  })

  it('前缀之外的路径不会被当成会话流', async () => {
    const client = await openBrowserStream('/api/remote.mux', ownedCookie)
    expect(client.status).not.toBe(200)
  })

  it('浏览器断开后上游连接也被关掉', async () => {
    const before = streams.length
    const client = await openBrowserStream(sessionStreamPath(OWNED), ownedCookie)
    const deadline = Date.now() + 3_000
    while (streams.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const entry = streams.at(-1)
    expect(entry?.closed).toBe(false)
    client.close()
    const closeDeadline = Date.now() + 3_000
    while (entry?.closed !== true && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(entry?.closed).toBe(true)
  })
})
