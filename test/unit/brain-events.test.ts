import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { BrainClient } from '../../src/brain/client.js'

/**
 * 脑的事件日志回放。
 *
 * 脑的 `session/event` 是先广播、后按批落库；平台读库可能暂时落后。浏览器
 * journal 又要求每页严格结束在请求的 cursor 上，所以落后时必须从
 * `GET /brain/v1/sessions/{id}/events?after=N` 补齐。这里只验请求形状与
 * 回放/截断语义。
 */

let server: ReturnType<typeof createServer>
let baseUrl: string
let requests: string[] = []
let respond: (url: URL, res: ServerResponse) => void = () => undefined

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    respond(url, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('服务器没起来')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function config(): AppConfig {
  return {
    brain: { baseUrl, appId: 'platform', appKey: 'app-key' },
    aliyun: { oss: { bucket: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '' } },
  } as unknown as AppConfig
}

const call = { userId: 'u1', workspaceId: 'w1', sessionId: 's1' }

describe('脑的事件回放', () => {
  it('从 after 开始回放到日志末尾，带上表面元数据', async () => {
    requests = []
    respond = (_url, res) => {
      sse(res, [
        { cursor: 4 },
        { seq: 2, type: 'user/message', data: { text: 'hi' }, surfaceOp: 'append' },
        { seq: 3, type: 'assistant/message', data: { text: 'yo' }, surfaceOp: 'append', sourceEventSeqs: [2] },
        { seq: 4, type: 'turn/end', data: { turn: 1 }, ignorable: true },
        { replayed: 3, after: 4 },
      ])
      res.end()
    }
    const backlog = await new BrainClient(config()).eventBacklog({ ...call, after: 1 })
    expect(requests).toEqual(['/brain/v1/sessions/s1/events?after=1'])
    expect(backlog?.cursor).toBe(4)
    expect(backlog?.events.map(event => event.seq)).toEqual([2, 3, 4])
    expect(backlog?.events[1]).toMatchObject({ surfaceOp: 'append', sourceEventSeqs: [2] })
    expect(backlog?.events[2]?.ignorable).toBe(true)
  })

  it('until 是包含上界，到了就停，不读后面的实时段', async () => {
    respond = (_url, res) => {
      sse(res, [
        { cursor: 9 },
        { seq: 0, type: 'turn/start', data: {} },
        { seq: 1, type: 'user/message', data: {} },
        { seq: 2, type: 'assistant/message', data: {} },
        { seq: 3, type: 'turn/end', data: {} },
      ])
      // 故意不结束响应：未到 until 时调用方会一直等，到了必须自己断开。
    }
    const backlog = await new BrainClient(config()).eventBacklog({ ...call, after: -1, until: 2 })
    expect(backlog?.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(backlog?.cursor).toBe(9)
  })

  it('单次回放被 pageSize 截断时从断点重连续读', async () => {
    requests = []
    respond = (url, res) => {
      const after = Number(url.searchParams.get('after') ?? '-1')
      if (after < 1) {
        sse(res, [
          { cursor: 3 },
          { seq: 0, type: 'turn/start', data: {} },
          { seq: 1, type: 'user/message', data: {} },
          { replayed: 2, after: 1 },
        ])
      } else {
        sse(res, [
          { cursor: 3 },
          { seq: 2, type: 'assistant/message', data: {} },
          { seq: 3, type: 'turn/end', data: {} },
          { replayed: 2, after: 3 },
        ])
      }
      res.end()
    }
    const backlog = await new BrainClient(config()).eventBacklog({ ...call, after: -1 })
    expect(requests).toEqual([
      '/brain/v1/sessions/s1/events?after=-1',
      '/brain/v1/sessions/s1/events?after=1',
    ])
    expect(backlog?.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
    expect(backlog?.cursor).toBe(3)
  })

  it('脑上没有这条会话时返回 undefined，调用方退回数据库', async () => {
    respond = (_url, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'session-not-found' } }))
    }
    await expect(new BrainClient(config()).eventBacklog({ ...call, after: 0 })).resolves.toBeUndefined()
  })
})
