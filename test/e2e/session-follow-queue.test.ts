import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { API, freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 浏览器实时面的三块平台行为：
 *
 * 1. `session/follow` 的快照带平台队列注入的 `inbox` 投影，后续 `stream` 帧抬成
 *    `assistant-stream` 且 `start` 变体带 `startedAfterSeq`；
 * 2. `session/control` 的基线与轮询把同一条 `inbox` 推给客户端；
 * 3. `$events` 把脑的 `waterfall` 抬成可答复事件，`$events/result` /
 *    `userQuestions/answer` 再按会话路由回脑的 `answers`。
 *
 * 还有平台输入队列本身：`session/prompt` 只落 `dsh_session_queue`，泵在脑报
 * `status: idle` 后才用原 `requestId` 发 `POST /messages`，发完出队。
 */

const S = 's_follow000000000000000000000000'
/** 派发触发点的独立会话：泵按会话隔离，避免和其它用例的状态互相影响。 */
const S2 = 's_follow000000000000000000000002'
const S3 = 's_follow000000000000000000000003'
const FOREIGN = 's_foreign00000000000000000000000'
const WORKSPACE = 'ws_follow000000000000000000000'
const PROJECTION_SEQ = 3

interface BrainCall {
  path: string
  headers: IncomingHttpHeaders
  body: unknown
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl = ''
let cookie = ''
let adminId = ''
const calls: BrainCall[] = []
/** 假脑上仍然打开的上游流，用来往会话里推帧。 */
const streams: ServerResponse[] = []
/** 按会话找到它最近一条 `/stream`，只向该会话推状态帧。 */
const sessionStreams = new Map<string, ServerResponse>()
/** 接下来的若干次 `/messages` 返回 5xx，用来验证队列泵的重试。 */
let messageFailures = 0
/**
 * 假脑的进程内日志末尾。脑先广播后落库，库里可能暂时落后；`/events` 负责
 * 把这段补齐。默认与数据库里的三帧一致。
 */
let backlog: { cursor: number; events: Array<Record<string, unknown>> } = { cursor: PROJECTION_SEQ, events: [] }

beforeEach(() => {
  backlog = { cursor: PROJECTION_SEQ, events: [] }
  messageFailures = 0
})

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
        // 脑的已提交日志回放：snapshot → 回放 → ready。只回大于 `after` 的部分。
        const after = Number(url.searchParams.get('after') ?? '-1')
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify({ cursor: backlog.cursor })}\n\n`)
        let last = after
        for (const event of backlog.events) {
          const seq = Number(event.seq)
          if (!Number.isSafeInteger(seq) || seq <= after) continue
          res.write(`data: ${JSON.stringify(event)}\n\n`)
          last = Math.max(last, seq)
        }
        res.write(`data: ${JSON.stringify({ replayed: last - after, after: last })}\n\n`)
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        // 上游流一开就算「已知空闲」：队列泵据此派发下一条消息。
        res.write(`data: ${JSON.stringify({ type: 'ready', seq: PROJECTION_SEQ })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: 'status', running: false })}\n\n`)
        streams.push(res)
        const session = /\/sessions\/([^/]+)\/stream$/.exec(url.pathname)?.[1]
        if (session !== undefined) sessionStreams.set(session, res)
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/projections')) {
        json({ projections: { asOfSeq: PROJECTION_SEQ, values: {} } })
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
        if (messageFailures > 0) {
          messageFailures -= 1
          json({ code: 'gateway/internal', message: 'brain unavailable' }, 503)
          return
        }
        json({ ok: true })
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

  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  adminId = admin.rows[0]?.id ?? ''
  if (!adminId) throw new Error('没有找到管理员')
  cookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, adminId, platform.config.auth.tokenTtlHours)}`

  await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other', 'other', 'x')`)
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, '默认工作区', '/tmp/w_follow', '/desk')`,
    [WORKSPACE, adminId],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`,
    [S, adminId, WORKSPACE],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`,
    [S2, adminId, WORKSPACE],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`,
    [S3, adminId, WORKSPACE],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, 'u_other')`, [FOREIGN])
  // 历史页只读这张表；三帧事件让快照的 cursor 有确定的值。
  for (const seq of [1, 2, 3]) {
    await platform.db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event) VALUES ($1, $2, $3)`,
      [S, seq, JSON.stringify({ type: seq === 3 ? 'assistant/message' : 'user/message', data: { seq }, time: seq * 1000 })],
    )
  }
})

afterAll(async () => {
  for (const stream of streams) stream.destroy()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  brain.closeAllConnections?.()
  await new Promise<void>((resolve) => brain.close(() => resolve()))
  await platform.close()
})

// ---------------------------------------------------------------------------
// 浏览器侧的流
// ---------------------------------------------------------------------------

interface Browser {
  status: number
  frames: Record<string, unknown>[]
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): void
}

async function connect(endpoint: string, args: Record<string, unknown>): Promise<Browser> {
  const controller = new AbortController()
  // 流端点的查询串就是内层 payload（`{args}`），不是 Remote 信封。
  const query = Buffer.from(JSON.stringify({ args })).toString('base64url')
  const response = await fetch(`${baseUrl}${API}/sse/${endpoint}?payload=${encodeURIComponent(query)}`, {
    headers: { accept: 'text/event-stream', cookie },
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
          if (data !== '') frames.push(JSON.parse(data) as Record<string, unknown>)
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
    close: () => controller.abort(),
  }
}

/** 往最近一条上游流里写一帧。 */
function push(frame: unknown): void {
  const stream = streams.at(-1)
  if (stream === undefined) throw new Error('还没有上游流')
  stream.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/** 只向某个会话的上游流写一帧。 */
function pushTo(sessionId: string, frame: unknown): void {
  const stream = sessionStreams.get(sessionId)
  if (stream === undefined) throw new Error(`会话 ${sessionId} 还没有上游流`)
  stream.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/** 等脑收到第 `total` 条 `/messages`（绝对计数）。 */
async function waitForMessages(total: number, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (calls.filter((call) => call.path.endsWith('/messages')).length >= total) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待第 ${total} 条消息超时`)
}

/** 等上游真的连上（watchers / 队列泵都是异步建连的）。 */
async function waitForStream(count: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (streams.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (streams.length < count) throw new Error('上游流没有建立')
}

async function rpc(method: string, args: Record<string, unknown>): Promise<{
  result: { ok: boolean; value?: unknown; error?: { code: string } }
}> {
  const response = await fetch(`${baseUrl}${API}/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-queue', method, payload: { args } }),
  })
  expect(response.status).toBe(200)
  return await response.json() as { result: { ok: boolean; value?: unknown; error?: { code: string } } }
}

async function queueRows(sessionId: string): Promise<Array<{ item_id: string; request_id: string; content: string }>> {
  const rows = await platform.db.query<{ item_id: string; request_id: string; content: string }>(
    `SELECT item_id, request_id, content FROM dsh_session_queue WHERE session_id = $1 ORDER BY created_at ASC, item_id ASC`,
    [sessionId],
  )
  return rows.rows
}

function inboxOf(value: unknown): Record<string, unknown> | undefined {
  const projections = (value as { projections?: { values?: Record<string, unknown> } } | undefined)?.projections
  return projections?.values?.inbox as Record<string, unknown> | undefined
}

describe('session/follow 快照与增量', () => {
  it('快照带 inbox 投影和 revision 0，助手流按通道本地序号重编号', async () => {
    const queued = await queueRows(S)
    expect(queued).toHaveLength(0)
    // 直接准备两条排队消息：它们只应出现在平台注入的 inbox 里。
    await platform.db.query(
      `INSERT INTO dsh_session_queue (session_id, item_id, request_id, user_id, content) VALUES
         ($1, 'item_a', 'req_a', $2, 'first'), ($1, 'item_b', 'req_b', $2, 'second')`,
      [S, adminId],
    )

    const stream = await connect('session/follow', { request: { sessionId: S } })
    try {
      const snapshot = await stream.waitFor((frame) => frame.type === 'snapshot')
      expect(snapshot).toMatchObject({
        header: { version: 4, id: S, cwd: '/desk', isSeeded: false },
        cursor: PROJECTION_SEQ,
        projections: { asOfSeq: PROJECTION_SEQ },
        assistantStream: { revision: 0 },
      })
      // 历史页的 3 帧事件都在快照里。
      expect((snapshot.records as unknown[]).length).toBe(3)
      expect(inboxOf(snapshot)).toEqual({
        'next-turn': [
          { id: 'item_a', source: { kind: 'user', rpcId: 'req_a' }, content: [{ type: 'text', text: 'first' }] },
          { id: 'item_b', source: { kind: 'user', rpcId: 'req_b' }, content: [{ type: 'text', text: 'second' }] },
        ],
        'next-step': [],
      })

      const before = streams.length
      await waitForStream(before)
      // 脑的 revision 是 Agent 实例级计数，同一会话的第二轮从 73 接着走；
      // 客户端只接受「快照基线 + 1」的连续序号，所以平台按通道重编号。
      push({ type: 'stream', frame: { type: 'start', revision: 73, attemptId: 'attempt-1', turn: 3, step: 0 } })
      const started = await stream.waitFor((frame) => frame.type === 'assistant-stream')
      expect(started).toEqual({
        type: 'assistant-stream',
        frame: { type: 'start', revision: 1, attemptId: 'attempt-1', turn: 3, step: 0, startedAfterSeq: PROJECTION_SEQ },
      })

      push({
        type: 'stream',
        frame: { type: 'chunk', revision: 74, attemptId: 'attempt-1', index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
      })
      const delta = await stream.waitFor(
        (frame) => frame.type === 'assistant-stream' && (frame.frame as { type?: string }).type === 'chunk',
      )
      expect(delta.frame).toEqual({
        type: 'chunk',
        revision: 2,
        attemptId: 'attempt-1',
        index: 0,
        time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hi' },
      })

      // 落库事件抬成客户端 `event` 帧，seq 单调递增。
      push({ type: 'event', seq: 4, event: { type: 'assistant/message', data: { text: 'hi' } } })
      const event = await stream.waitFor((frame) => frame.type === 'event')
      expect(event).toMatchObject({ type: 'event', event: { type: 'assistant/message', seq: 4, data: { text: 'hi' } } })

      // 表面元数据必须跟着增量走：上游 session store 缺 `surfaceOp` 就把
      // 整段历史判成 `requires a surfaceOp marker`。
      const surfaceOp = { op: 'replace', startSeq: 9, endSeq: 9 }
      push({
        type: 'event',
        seq: 5,
        event: { type: 'system/message', data: { text: '摘要' }, surfaceOp, sourceEventSeqs: [9] },
      })
      const rewritten = await stream.waitFor(
        (frame) => frame.type === 'event' && (frame.event as { seq?: number }).seq === 5,
      )
      expect(rewritten.event).toEqual({
        type: 'system/message',
        seq: 5,
        time: expect.any(Number),
        data: { text: '摘要' },
        surfaceOp,
        sourceEventSeqs: [9],
      })
    } finally {
      stream.close()
      await platform.db.query(`DELETE FROM dsh_session_queue WHERE session_id = $1`, [S])
    }
  })

  it('库还没落盘时，快照用脑的日志把页尾补到连续', async () => {
    // 脑先广播、后按批落库：库里只有 1..3，进程内日志已经到 5。
    backlog = {
      cursor: 5,
      events: [
        { seq: 4, type: 'tool/call', data: { callId: 'c1' } },
        { seq: 5, type: 'tool/result', data: { callId: 'c1' } },
      ],
    }
    const stream = await connect('session/follow', { request: { sessionId: S } })
    try {
      const snapshot = await stream.waitFor((frame) => frame.type === 'snapshot')
      const records = snapshot.records as Array<{ event: { seq: number } }>
      expect(records.map(record => record.event.seq)).toEqual([1, 2, 3, 4, 5])
      // cursor 必须等于补全后的末条，否则 journal 无法通过页尾校验。
      expect(snapshot.cursor).toBe(5)
    } finally {
      stream.close()
    }
  })

  it('修复页遇到未落库的 throughSeq 时从脑补齐，cursor 与页尾对齐', async () => {
    backlog = {
      cursor: 5,
      events: [
        { seq: 4, type: 'tool/call', data: { callId: 'c1' } },
        { seq: 5, type: 'tool/result', data: { callId: 'c1' } },
      ],
    }
    const page = await rpc('session/page', {
      request: { address: { sessionId: S }, throughSeq: 5, maxMessages: 50 },
    })
    const value = page.result.value as { cursor: number; records: Array<{ event: { seq: number } }> }
    expect(value.cursor).toBe(5)
    expect(value.records.at(-1)?.event.seq).toBe(5)
    expect(value.records.map(record => record.event.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('session/control 的 inbox 投影', () => {
  it('基线带当前队列，之后的变化按 projection 帧推下来', async () => {
    // control 只发缓存里的投影；先落一条排队消息，再让 follow 建缓存。
    await platform.db.query(
      `INSERT INTO dsh_session_queue (session_id, item_id, request_id, user_id, content)
       VALUES ($1, 'item_c', 'req_c', $2, 'third')`,
      [S, adminId],
    )
    const follow = await connect('session/follow', { request: { sessionId: S } })
    await follow.waitFor((frame) => frame.type === 'snapshot')

    const control = await connect('session/control', {})
    try {
      const baseline = await control.waitFor((frame) => frame.type === 'baseline')
      const projections = (baseline.value as { projections: Record<string, { values: { inbox: unknown } }> }).projections
      expect(projections[S]?.values.inbox).toEqual({
        'next-turn': [{ id: 'item_c', source: { kind: 'user', rpcId: 'req_c' }, content: [{ type: 'text', text: 'third' }] }],
        'next-step': [],
      })

      // 轮询会在 1s 内发现队列变化，并把新的 inbox 作为 projection 推下来。
      await platform.db.query(
        `INSERT INTO dsh_session_queue (session_id, item_id, request_id, user_id, content)
         VALUES ($1, 'item_d', 'req_d', $2, 'fourth')`,
        [S, adminId],
      )
      const update = await control.waitFor((frame) => frame.type === 'projection', 4_000)
      expect(update).toMatchObject({ type: 'projection', sessionId: S })
      const changes = update.changes as Array<{ key: string; val: { 'next-turn': Array<{ id: string }> } }>
      expect(changes[0]?.key).toBe('inbox')
      expect(changes[0]?.val['next-turn'].map((item) => item.id)).toEqual(['item_c', 'item_d'])
    } finally {
      control.close()
      follow.close()
      await platform.db.query(`DELETE FROM dsh_session_queue WHERE session_id = $1`, [S])
    }
  })
})

describe('$events 转发与答复', () => {
  it('waterfall 抬成转发事件，$events/result 按会话路由回脑', async () => {
    const follow = await connect('session/follow', { request: { sessionId: S } })
    await follow.waitFor((frame) => frame.type === 'snapshot')
    const events = await connect('$events', {})
    try {
      const ready = await events.waitFor((frame) => frame.type === 'ready')
      expect(ready).toMatchObject({ type: 'ready', host: { home: '/desk' } })

      push({
        type: 'waterfall',
        requestId: 'req_approve_1',
        kind: 'approval',
        request: { tool: 'bash', wait: { callId: 'call_1' } },
      })
      const forwarded = await events.waitFor((frame) => frame.type === 'waterfall')
      expect(forwarded).toEqual({
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'req_approve_1',
        agentId: S,
        request: { tool: 'bash', wait: { callId: 'call_1' } },
      })

      // 答复走平台收口：按 eventId 找回会话，再把结果送到脑的 answers。
      const before = calls.filter((call) => call.path.endsWith('/answers')).length
      const answered = await rpc('$events/result', {
        eventId: 'req_approve_1',
        outcome: { kind: 'result', value: 'approved' },
      })
      expect(answered.result).toEqual({ ok: true, value: { accepted: true } })
      const answerCalls = calls.filter((call) => call.path.endsWith('/answers'))
      expect(answerCalls.length).toBe(before + 1)
      expect(answerCalls.at(-1)).toMatchObject({
        path: `/brain/v1/sessions/${S}/answers`,
        body: { requestId: 'req_approve_1', outcome: { kind: 'result', value: 'approved' } },
      })
      expect(answerCalls.at(-1)?.headers['x-dsh-user-id']).toBe(adminId)

      // 提问只用 callId 找回 eventId。
      push({ type: 'waterfall', requestId: 'req_ask_1', kind: 'questions', request: { wait: { callId: 'call_2' } } })
      const asked = await events.waitFor(
        (frame) => frame.type === 'waterfall' && (frame as { eventId?: string }).eventId === 'req_ask_1',
      )
      expect(asked.event).toBe('user-questions/request')

      const replied = await rpc('userQuestions/answer', { callId: 'call_2', answer: 'yes' })
      expect(replied.result).toEqual({ ok: true, value: true })
      expect(calls.filter((call) => call.path.endsWith('/answers')).at(-1)).toMatchObject({
        path: `/brain/v1/sessions/${S}/answers`,
        body: { requestId: 'req_ask_1', outcome: { kind: 'result', value: 'yes' } },
      })
    } finally {
      events.close()
      follow.close()
    }
  })

  it('别人的会话不能借 eventId 答复', async () => {
    const result = await rpc('$events/result', { eventId: 'req_unknown', outcome: { kind: 'result', value: 1 } })
    expect(result.result.ok).toBe(false)
    expect(result.result.error?.code).toBe('session/not-found')
  })
})

describe('平台输入队列的派发', () => {
  it('prompt 先入队，脑报 idle 后才按原 requestId 发出并出队', async () => {
    const beforeMessages = calls.filter((call) => call.path.endsWith('/messages')).length
    const accepted = await rpc('session/prompt', {
      request: { sessionId: S, requestId: 'req_dispatch_1', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(accepted.result).toEqual({ ok: true, value: { accepted: true } })
    // 入队是同步的：回包时消息还在平台表里。
    expect(await queueRows(S)).toEqual([{ item_id: expect.any(String), request_id: 'req_dispatch_1', content: 'hello' }])

    const deadline = Date.now() + 3_000
    let dispatched = 0
    while (Date.now() < deadline) {
      dispatched = calls.filter((call) => call.path.endsWith('/messages')).length - beforeMessages
      if (dispatched > 0 && (await queueRows(S)).length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(dispatched).toBe(1)
    const sent = calls.filter((call) => call.path.endsWith('/messages')).at(-1)
    expect(sent).toMatchObject({
      path: `/brain/v1/sessions/${S}/messages`,
      body: { text: 'hello', requestId: 'req_dispatch_1', mode: 'queue' },
    })
    expect(sent?.headers['x-dsh-user-id']).toBe(adminId)
    expect(sent?.headers['x-dsh-workspace-id']).toBe(WORKSPACE)
    expect(await queueRows(S)).toEqual([])

    const state = await rpc('session/state', { request: { sessionId: S } })
    expect(state.result).toMatchObject({ ok: true, value: { active: true, queue: [] } })
  })

  it('空闲会话的第二条消息靠入队唤醒派发，不必等新的状态帧', async () => {
    const baseline = calls.filter((call) => call.path.endsWith('/messages')).length
    await rpc('session/prompt', {
      request: { sessionId: S2, requestId: 'req_wake_1', content: [{ type: 'text', text: 'first' }] },
    })
    await waitForMessages(baseline + 1)
    expect(await queueRows(S2)).toEqual([])

    // 第一轮结束：脑再报一次空闲。此后泵已知空闲，脑不会再发状态帧。
    pushTo(S2, { type: 'status', running: false })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 第二条只可能由入队唤醒触发派发。
    await rpc('session/prompt', {
      request: { sessionId: S2, requestId: 'req_wake_2', content: [{ type: 'text', text: 'second' }] },
    })
    await waitForMessages(baseline + 2)
    const sent = calls.filter((call) => call.path.endsWith('/messages')).slice(baseline)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      path: `/brain/v1/sessions/${S2}/messages`,
      body: { text: 'second', requestId: 'req_wake_2', mode: 'queue' },
    })
    expect(await queueRows(S2)).toEqual([])
  })

  it('派发失败后自动重试，成功后才出队', async () => {
    const baseline = calls.filter((call) => call.path.endsWith('/messages')).length
    messageFailures = 1
    await rpc('session/prompt', {
      request: { sessionId: S3, requestId: 'req_retry_1', content: [{ type: 'text', text: 'retry' }] },
    })
    // 首次失败：消息留在平台队列里，而且没有新的状态帧会再来触发。
    await waitForMessages(baseline + 1)
    expect(await queueRows(S3)).toHaveLength(1)
    // 泵自己按退避重试，第二次成功并出队。
    await waitForMessages(baseline + 2, 5_000)
    expect(await queueRows(S3)).toEqual([])
    const sent = calls.filter((call) => call.path.endsWith('/messages')).slice(baseline)
    expect(sent.at(-1)).toMatchObject({
      path: `/brain/v1/sessions/${S3}/messages`,
      body: { text: 'retry', requestId: 'req_retry_1', mode: 'queue' },
    })
  })

  it('updateQueue 的 remove / edit 只动自己的队列项', async () => {
    await platform.db.query(
      `INSERT INTO dsh_session_queue (session_id, item_id, request_id, user_id, content)
       VALUES ($1, 'item_edit', 'req_edit', $2, 'before')`,
      [S, adminId],
    )
    const edited = await rpc('session/updateQueue', {
      request: { sessionId: S, itemId: 'item_edit', action: { kind: 'edit', content: [{ type: 'text', text: 'after' }] } },
    })
    expect(edited.result).toEqual({ ok: true, value: { accepted: true } })
    expect((await queueRows(S))[0]?.content).toBe('after')

    const removed = await rpc('session/updateQueue', { request: { sessionId: S, itemId: 'item_edit', action: 'remove' } })
    expect(removed.result).toEqual({ ok: true, value: { accepted: true } })
    expect(await queueRows(S)).toEqual([])

    // 没有这一项时是一个明确的失败码，而不是悄悄成功。
    const missing = await rpc('session/updateQueue', { request: { sessionId: S, itemId: 'item_edit', action: 'remove' } })
    expect(missing.result.ok).toBe(false)
    expect(missing.result.error?.code).toBe('session/queue-item-not-found')
  })
})
