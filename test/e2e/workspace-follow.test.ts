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
 * 浏览器工作区列表只靠 `P/sse/workspace/follow` 喂：收到 `baseline` 才从
 * pending 翻到 ready。这条流必须（1）由平台自己答、（2）只含当前成员的行、
 * （3）平台表变化后能推送 `replace` 增量。
 */

const ME = 'u_me'
const OTHER = 'u_other'

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let myCookie: string
/** 假脑收到的路径；follow 是平台数据，不该碰脑。 */
const brainPaths: string[] = []

beforeAll(async () => {
  platform = await startTestPlatform()
  const client: ClientHost = await startClientHost()

  brain = createServer((req, res) => {
    brainPaths.push(req.url ?? '')
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
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
  // 我：两块工作区（w2 手动排在前面），各一条会话；另有一条归档、一条置顶。
  for (const [id, order] of [['ws_a1', 2], ['ws_a2', 1]] as const) {
    await platform.db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, sort_order)
       VALUES ($1, $2, $3, '/tmp', '/desk', $4)`,
      [id, ME, id, order],
    )
  }
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ('ws_b1', $1, 'other', '/tmp', '/desk')`,
    [OTHER],
  )
  for (const [id, userId, workspaceId, status, pinnedAt] of [
    ['s_a1', ME, 'ws_a1', 'active', null],
    ['s_a2', ME, 'ws_a1', 'active', '2026-01-05T00:00:00.000Z'],
    ['s_a3', ME, 'ws_a2', 'active', null],
    ['s_a4', ME, 'ws_a1', 'archived', null],
    ['s_b1', OTHER, 'ws_b1', 'active', null],
  ]) {
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, status, pinned_at)
       VALUES ($1, $2, $3, '', $4, $5)`,
      [id, userId, workspaceId, status, pinnedAt],
    )
  }

  myCookie = `${PLATFORM_COOKIE}=${signToken(config.auth.tokenSecret, ME, config.auth.tokenTtlHours)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

interface FollowValue {
  items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>
  archivedSessionIds: string[]
  pinnedSessionIds: string[]
}

/**
 * 同一条流上连续取帧；`readSseUntil` 返回时会 cancel，读不到 baseline 之后的增量。
 */
async function openFrames(response: Response): Promise<{
  next(timeoutMs?: number): Promise<unknown>
  close(): Promise<void>
}> {
  if (response.body === null) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  const next = async (timeoutMs = 6_000): Promise<unknown> => {
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
        if (data !== '') return JSON.parse(data) as unknown
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

async function openFollow(signal: AbortSignal): Promise<Response> {
  return await openSse(baseUrl, 'workspace/follow', { args: {} }, { cookie: myCookie, signal })
}

describe('workspace/follow 由平台自己答', () => {
  it('第一帧 baseline 只含当前成员的工作区与会话，不碰脑', async () => {
    const before = brainPaths.length
    const controller = new AbortController()
    const response = await openFollow(controller.signal)
    expect(response.status).toBe(200)
    const frames = await openFrames(response)
    const frame = await frames.next() as { type: string; value: FollowValue }
    await frames.close()
    controller.abort()

    expect(frame.type).toBe('baseline')
    expect(frame.value.items.map((item) => item.workspaceId)).toEqual(['ws_a2', 'ws_a1'])
    expect(frame.value.items.every((item) => item.path === '/desk')).toBe(true)
    const sessions = frame.value.items.flatMap((item) => item.sessionIds)
    expect(sessions.sort()).toEqual(['s_a1', 's_a2', 's_a3'])
    expect(sessions).not.toContain('s_a4')
    expect(sessions).not.toContain('s_b1')
    expect(frame.value.archivedSessionIds).toEqual(['s_a4'])
    expect(frame.value.pinnedSessionIds).toEqual(['s_a2'])
    expect(brainPaths.length).toBe(before)
  })

  it('平台表变化后同一代内推送 replace 增量', async () => {
    const controller = new AbortController()
    const response = await openFollow(controller.signal)
    const frames = await openFrames(response)
    const baseline = await frames.next() as { type: string }
    expect(baseline.type).toBe('baseline')

    await platform.db.query(`UPDATE dsh_sessions SET status = 'archived', pinned_at = NULL WHERE id = 's_a2'`)
    const increment = await frames.next() as { type: string; value: FollowValue }
    await frames.close()
    controller.abort()

    expect(increment.type).toBe('replace')
    const sessions = increment.value.items.flatMap((item) => item.sessionIds)
    expect(sessions).not.toContain('s_a2')
    expect(increment.value.archivedSessionIds.sort()).toEqual(['s_a2', 's_a4'])
    expect(increment.value.pinnedSessionIds).toEqual([])

    // 复原，避免影响其它用例。
    await platform.db.query(`UPDATE dsh_sessions SET status = 'active', pinned_at = '2026-01-05T00:00:00.000Z' WHERE id = 's_a2'`)
  })

  it('unary 调用按「只走 SSE」拒绝，不转发给脑', async () => {
    const before = brainPaths.length
    const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/workspace/follow`, {
      method: 'POST',
      headers: { cookie: myCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'workspace/follow', payload: { args: {} } }),
    })
    expect(response.status).toBe(200)
    const frame = await response.json() as { result?: { ok?: boolean; error?: { code?: string } } }
    expect(frame.result?.ok).toBe(false)
    expect(frame.result?.error?.code).toBe('gateway/bad-request')
    expect(brainPaths.length).toBe(before)
  })

  it('未登录开流被拒', async () => {
    const controller = new AbortController()
    const response = await openSse(baseUrl, 'workspace/follow', { args: {} }, { signal: controller.signal })
    controller.abort()
    expect(response.status).toBe(401)
  })
})
