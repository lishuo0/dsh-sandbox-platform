import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { BrainClient } from '../../src/brain/client.js'

/**
 * 平台访问脑的文件接缝：只验请求形状（路径、方法、租户头、原始字节）
 * 和错误码透传。真正的沙箱读写由脑的 e2e 覆盖。
 */

interface Captured {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

let server: ReturnType<typeof createServer>
let baseUrl: string
let captured: Captured[] = []
let reply: { status: number; body: string } = { status: 200, body: '{}' }

function config(): AppConfig {
  return {
    brain: { baseUrl, appId: 'platform', appKey: 'app-key' },
    aliyun: { oss: { bucket: '', endpoint: '', region: '', accessKeyId: '', accessKeySecret: '' } },
  } as unknown as AppConfig
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
  res.writeHead(reply.status, { 'content-type': 'application/json' })
  res.end(reply.body)
}

beforeAll(async () => {
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('服务器没起来')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const call = { userId: 'u1', workspaceId: 'w1', sessionId: 's1' }

describe('文件接缝', () => {
  it('列表走 GET，带上租户头和路径参数', async () => {
    captured = []
    reply = { status: 200, body: JSON.stringify({ path: 'desk', entries: [], truncated: false }) }
    const result = await new BrainClient(config()).workspaceFiles({ ...call, search: 'path=desk' })
    expect(result).toEqual({ ok: true, value: { path: 'desk', entries: [], truncated: false } })
    expect(captured).toHaveLength(1)
    const [request] = captured
    expect(request?.method).toBe('GET')
    expect(request?.url).toBe('/brain/v1/sessions/s1/workspace-files?path=desk')
    expect(request?.headers['x-app-id']).toBe('platform')
    expect(request?.headers['x-app-key']).toBe('app-key')
    expect(request?.headers['x-dsh-user-id']).toBe('u1')
    expect(request?.headers['x-dsh-workspace-id']).toBe('w1')
    expect(request?.headers.sessionid).toBe('s1')
    expect(request?.headers['content-type']).toBeUndefined()
  })

  it('子动作拼在路径上，上传用 POST 发原始字节', async () => {
    captured = []
    reply = { status: 200, body: JSON.stringify({ name: 'a.txt', path: '/workspace-w1/a.txt', bytes: 3 }) }
    const bytes = Buffer.from('abc')
    const client = new BrainClient(config())
    await client.workspaceFiles({ ...call, action: 'content', search: 'path=a.txt' })
    await client.workspaceFiles({ ...call, action: 'upload', search: 'path=desk&name=a.txt', bytes })
    expect(captured.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /brain/v1/sessions/s1/workspace-files/content?path=a.txt',
      'POST /brain/v1/sessions/s1/workspace-files/upload?path=desk&name=a.txt',
    ])
    expect(captured[1]?.body).toEqual(bytes)
    expect(captured[1]?.headers['content-type']).toBeUndefined()
  })

  it('把脑的 error.code 交给调用方，而不是原始 JSON', async () => {
    captured = []
    reply = { status: 404, body: JSON.stringify({ error: { code: 'workspace-file/not-found', message: 'not found' } }) }
    const result = await new BrainClient(config()).workspaceFiles({ ...call, action: 'stat', search: 'path=missing' })
    expect(result).toEqual({ ok: false, status: 404, code: 'workspace-file/not-found' })
  })

  it('非 JSON 错误体保留原文前缀', async () => {
    reply = { status: 502, body: 'upstream exploded' }
    const result = await new BrainClient(config()).workspaceFiles({ ...call, search: '' })
    expect(result).toEqual({ ok: false, status: 502, code: 'upstream exploded' })
  })
})
