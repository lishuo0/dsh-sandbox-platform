import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { startClientHost, type ClientHost } from '../../src/client/host.js'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, openSse, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 物理 `$mux` 流。
 *
 * 页面常驻 5 条逻辑流，浏览器每源只允许 6 条 HTTP/1.1 连接；再开一个文件树
 * 面板就会让后续 unary（如 `workspaceFiles/list`）永久排队。这里验证逻辑流能
 * 复用到一条物理流：`$mux/open` 开关通道、帧按 `channel` 分发、物理流断开时
 * 逻辑流的清理（轮询/订阅）确实停掉。
 */

const ME = 'u_mux_me'
const OTHER = 'u_mux_other'
const API = '/dsh-api/platform/v1'

interface Envelope {
  result?: { ok?: boolean; value?: unknown; error?: { code?: string } }
}

interface MuxFrame {
  type: string
  mux?: string
  channel?: string
  value?: unknown
  error?: { code?: string; message?: string }
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let myCookie: string
let otherCookie: string
/** 假脑收到的 `workspace-files/stat` 次数；用来验证物理流断开后轮询停止。 */
let statCalls = 0

beforeAll(async () => {
  platform = await startTestPlatform()
  const client: ClientHost = await startClientHost()

  brain = createServer((req, res) => {
    if (req.url?.includes('/workspace-files/stat')) statCalls += 1
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ absolutePath: '/desk/a.txt', version: 'v1' }))
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
    await platform.db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, $2, '/tmp', '/desk')`,
      [`ws_${id}`, id],
    )
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, status) VALUES ($1, $2, $3, '', 'active')`,
      [`s_${id}`, id, `ws_${id}`],
    )
  }

  myCookie = `${PLATFORM_COOKIE}=${signToken(config.auth.tokenSecret, ME, config.auth.tokenTtlHours)}`
  otherCookie = `${PLATFORM_COOKIE}=${signToken(config.auth.tokenSecret, OTHER, config.auth.tokenTtlHours)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

/** 同一条物理流上连续取帧；带超时，避免用例把测试拖死。 */
async function openFrames(response: Response): Promise<{
  next(timeoutMs?: number): Promise<MuxFrame>
  close(): Promise<void>
}> {
  if (response.body === null) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const next = async (timeoutMs = 6_000): Promise<MuxFrame> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        cut = buffer.indexOf('\n\n')
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data !== '') return JSON.parse(data) as MuxFrame
      }
      if (done) throw new Error('SSE closed before the expected frame')
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE frame')
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timed out')), Math.max(1, deadline - Date.now()))),
      ])
      if (chunk.done) {
        done = true
        continue
      }
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { next, close: async () => { await reader.cancel().catch(() => undefined) } }
}

async function openMux(signal?: AbortSignal): Promise<Response> {
  return await openSse(baseUrl, '$mux', { args: {} }, { cookie: myCookie, ...(signal === undefined ? {} : { signal }) })
}

async function control(
  method: '$mux/open' | '$mux/close',
  args: Record<string, unknown>,
  cookie = myCookie,
): Promise<Envelope> {
  const response = await fetch(`${baseUrl}${API}/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `rpc-${String(args.channel ?? 'x')}`,
      method,
      payload: { args },
    }),
  })
  expect(response.status).toBe(200)
  return await response.json() as Envelope
}

async function openChannel(
  mux: string,
  channel: string,
  endpoint: string,
  payload: unknown = { args: {} },
  cookie = myCookie,
): Promise<Envelope> {
  return control('$mux/open', { mux, channel, endpoint, payload }, cookie)
}

/** 普通 unary Remote 调用；args 的形状与浏览器一致（`args.request`）。 */
async function rpc(method: string, args: Record<string, unknown>, cookie = myCookie): Promise<Envelope> {
  const response = await fetch(`${baseUrl}${API}/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${method}`, method, payload: { args } }),
  })
  expect(response.status).toBe(200)
  return await response.json() as Envelope
}

interface JournalRecord {
  event: { seq: number; type: string; surfaceOp?: unknown }
}

/** 直接写日志表，模拟脑已经提交的事件。 */
async function seedEvents(sessionId: string, events: readonly Record<string, unknown>[]): Promise<void> {
  for (const event of events) {
    await platform.db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`,
      [sessionId, event.seq, JSON.stringify(event)],
    )
  }
}

const append = 'append' as const

describe('物理 $mux 流', () => {
  it('先发 ready 带 mux id，逻辑帧按 channel 分发', async () => {
    const controller = new AbortController()
    const response = await openMux(controller.signal)
    expect(response.status).toBe(200)
    const frames = await openFrames(response)

    const ready = await frames.next()
    expect(ready).toMatchObject({ type: 'ready' })
    expect(ready.mux).toMatch(/^mux_/)

    const opened = await openChannel(ready.mux as string, 'c_access', 'remoteAccess/follow')
    expect(opened.result?.ok).toBe(true)
    const opened2 = await openChannel(ready.mux as string, 'c_events', '$events')
    expect(opened2.result?.ok).toBe(true)

    // 两条逻辑流的第一帧都要带各自的 channel，客户端据此分发。
    const first = await frames.next()
    const second = await frames.next()
    const byChannel = new Map([[first.channel, first.value], [second.channel, second.value]])
    expect(first.type).toBe('frame')
    expect(second.type).toBe('frame')
    expect(byChannel.get('c_access')).toEqual({ type: 'baseline', owner: true })
    expect(byChannel.get('c_events')).toMatchObject({ type: 'ready' })

    await frames.close()
    controller.abort()
  })

  it('$mux/close 发 end 帧，重复关闭是幂等的', async () => {
    const controller = new AbortController()
    const response = await openMux(controller.signal)
    const frames = await openFrames(response)
    const ready = await frames.next()
    const mux = ready.mux as string

    await openChannel(mux, 'c_one', 'remoteAccess/follow')
    const baseline = await frames.next()
    expect(baseline).toMatchObject({ type: 'frame', channel: 'c_one' })

    const closed = await control('$mux/close', { mux, channel: 'c_one' })
    expect(closed.result?.ok).toBe(true)
    expect(await frames.next()).toEqual({ type: 'end', channel: 'c_one' })

    // 再关一次不报错，也不再多发帧。
    const again = await control('$mux/close', { mux, channel: 'c_one' })
    expect(again.result?.ok).toBe(true)

    await frames.close()
    controller.abort()
  })

  it('只有自己的物理流能开通道；未知 mux 按不存在处理', async () => {
    const controller = new AbortController()
    const response = await openMux(controller.signal)
    const frames = await openFrames(response)
    const ready = await frames.next()
    await frames.close()
    controller.abort()

    const foreign = await openChannel(ready.mux as string, 'c_x', 'remoteAccess/follow', { args: {} }, otherCookie)
    expect(foreign.result?.ok).toBe(false)
    expect(foreign.result?.error?.code).toBe('gateway/not-found')

    const missing = await openChannel('mux_not_a_real_one', 'c_y', 'remoteAccess/follow')
    expect(missing.result?.ok).toBe(false)
    expect(missing.result?.error?.code).toBe('gateway/not-found')
  })

  it('非流端点、缺参数与重复通道都被拒', async () => {
    const controller = new AbortController()
    const response = await openMux(controller.signal)
    const frames = await openFrames(response)
    const ready = await frames.next()
    const mux = ready.mux as string

    const unary = await openChannel(mux, 'c_u', 'workspaceFiles/list')
    expect(unary.result?.error?.code).toBe('gateway/bad-request')

    const nested = await openChannel(mux, 'c_m', '$mux')
    expect(nested.result?.error?.code).toBe('gateway/bad-request')

    const noChannel = await control('$mux/open', { mux, endpoint: 'remoteAccess/follow' })
    expect(noChannel.result?.error?.code).toBe('gateway/bad-request')

    expect((await openChannel(mux, 'c_dup', 'remoteAccess/follow')).result?.ok).toBe(true)
    const duplicate = await openChannel(mux, 'c_dup', 'remoteAccess/follow')
    expect(duplicate.result?.error?.code).toBe('gateway/bad-request')

    await frames.close()
    controller.abort()
  })

  it('物理流断开后逻辑流的轮询随之停止', async () => {
    const controller = new AbortController()
    const response = await openMux(controller.signal)
    const frames = await openFrames(response)
    const ready = await frames.next()
    const mux = ready.mux as string

    const opened = await openChannel(
      mux,
      'c_files',
      'workspaceFiles/changes',
      { args: { workspaceFileScopeId: `s_${ME}`, path: '/desk/a.txt' } },
    )
    expect(opened.result?.ok).toBe(true)
    const first = await frames.next()
    expect(first).toMatchObject({ type: 'frame', channel: 'c_files', value: { kind: 'ready' } })
    // 轮询至少跑起来一次。
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(statCalls).toBeGreaterThan(0)

    await frames.close()
    controller.abort()
    // 允许断开瞬间还有一帧在途。
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = statCalls
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(statCalls).toBeLessThanOrEqual(after + 1)
  })

  it('会话快照 cursor 等于页内末条，分页截断点不被日志尾推高', async () => {
    await seedEvents(`s_${ME}`, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [] }, surfaceOp: append },
      { type: 'assistant/message', seq: 2, time: 3, data: { message: { role: 'assistant' } }, surfaceOp: append },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    const controller = new AbortController()
    const response = await openMux(controller.signal)
    const frames = await openFrames(response)
    const ready = await frames.next()
    const mux = ready.mux as string

    const opened = await openChannel(mux, 'c_session', 'session/follow', {
      args: { request: { address: { sessionId: `s_${ME}` }, maxMessages: 50 } },
    })
    expect(opened.result?.ok).toBe(true)
    const snapshot = await frames.next()
    expect(snapshot).toMatchObject({ type: 'frame', channel: 'c_session' })
    const page = snapshot.value as { cursor: number; records: JournalRecord[]; hasMore: boolean }
    const seqs = page.records.map((record) => record.event.seq)
    expect(seqs).toEqual([0, 1, 2, 3])
    // 回归点：cursor 取页内末条，不能用表上 MAX(seq)（并发写入会把它推到页外）。
    expect(page.cursor).toBe(seqs.at(-1))
    expect(page.cursor).toBe(3)
    // surface 元数据必须随快照到达浏览器。
    expect(page.records[1]?.event.surfaceOp).toBe('append')
    expect(page.records[2]?.event.surfaceOp).toBe('append')

    // 分页截断点：throughSeq 是回包 cursor，也是末条 seq。
    const sliced = await rpc('session/page', {
      request: { address: { sessionId: `s_${ME}` }, throughSeq: 2, maxMessages: 50 },
    })
    const slicedPage = sliced.result?.value as { cursor: number; records: JournalRecord[] } | undefined
    expect(slicedPage?.cursor).toBe(2)
    expect(slicedPage?.records.at(-1)?.event.seq).toBe(2)

    // 空会话：cursor 是上游 emptyCursor -1。
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, status) VALUES ('s_me_empty', $1, $2, '', 'active')`,
      [ME, `ws_${ME}`],
    )
    const emptyOpened = await openChannel(mux, 'c_empty', 'session/follow', {
      args: { request: { address: { sessionId: 's_me_empty' }, maxMessages: 50 } },
    })
    expect(emptyOpened.result?.ok).toBe(true)
    const empty = await frames.next()
    expect(empty).toMatchObject({ type: 'frame', channel: 'c_empty' })
    expect(empty.value).toMatchObject({ cursor: -1, records: [] })

    await frames.close()
    controller.abort()
  })

  it('直连 SSE 仍然可用，未登录开 $mux 被拒', async () => {
    const controller = new AbortController()
    const direct = await openSse(baseUrl, 'remoteAccess/follow', { args: {} }, { cookie: myCookie, signal: controller.signal })
    const frames = await openFrames(direct)
    expect(await frames.next()).toEqual({ type: 'baseline', owner: true })
    await frames.close()
    controller.abort()

    const anonymous = await openSse(baseUrl, '$mux', { args: {} }, { signal: new AbortController().signal })
    expect(anonymous.status).toBe(401)
    await anonymous.body?.cancel().catch(() => undefined)
  })
})
