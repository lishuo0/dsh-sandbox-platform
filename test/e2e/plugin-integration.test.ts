import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { startClientHost, type ClientHost } from '../../src/client/host.js'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import { startHttp } from '../../src/kernel/http.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import {
  freePort,
  startTestPlatform,
  type TestPlatform,
} from '../helpers/app.js'
import { createTestDatabase, type TestDatabase } from '../helpers/pg.js'

/**
 * genui 与 dsh-context 的浏览器半都通过平台交付。
 *
 * genui 的 `.js` 懒加载资产走专用路由；context 的 `P/context/*`（页面侧的旧
 * `api/dsh-context/*` 由传输垫片改写）由平台直接应答，不转给脑。这里同时盯住
 * 多用户隔离和启动图。
 */

const OWNED = 's_0123456789abcdef0123456789abcdef'
const OTHER = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OWNED_WS = 'ws_0123456789abcdef01234567'
const OTHER_WS = 'ws_aaaaaaaaaaaaaaaaaaaaaaaa'

let platform: TestPlatform
let database: TestDatabase
let client: ClientHost
let brain: Server
let server: Server
let baseUrl: string
let cookie: string
let otherCookie: string
let userId = ''
const brainHits: string[] = []

function event(seq: number, usage: { input: number; cacheRead?: number; cacheWrite?: number; output: number }): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: Date.UTC(2026, 10, 1, 12, 0, seq),
    data: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${seq} 轮` }],
        source: { kind: 'model', provider: 'user', model: 'deepseek-chat' },
      },
      usage: {
        inputTokens: usage.input,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
        outputTokens: usage.output,
        totalTokens: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + usage.output,
      },
    },
  })
}

async function context(path: string, body: unknown, who = cookie): Promise<{
  status: number
  headers: Headers
  body: Record<string, unknown>
}> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/context/${path}`, {
    method: 'POST',
    headers: { cookie: who, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> }
}

beforeAll(async () => {
  database = await createTestDatabase(['platform', 'brain'])
  platform = await startTestPlatform({ database })
  client = await startClientHost()

  brain = createServer((req, res) => {
    brainHits.push(req.url ?? '')
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
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

  const admin = await platform.db.query<{ id: string }>(
    `SELECT id FROM dsh_users WHERE id = $1`,
    [platform.config.auth.adminUsername],
  )
  const found = admin.rows[0]?.id
  if (found === undefined) throw new Error('没有找到管理员')
  userId = found
  cookie = `${PLATFORM_COOKIE}=${signToken(
    platform.config.auth.tokenSecret,
    userId,
    platform.config.auth.tokenTtlHours,
  )}`

  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other', 'other', 'x')`,
    [],
  )
  otherCookie = `${PLATFORM_COOKIE}=${signToken(
    platform.config.auth.tokenSecret,
    'u_other',
    platform.config.auth.tokenTtlHours,
  )}`

  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name) VALUES
       ($1, $2, '我的工作区', '/tmp/owned', '/desk', 'owned'),
       ($3, 'u_other', '别人的工作区', '/tmp/other', '/desk', 'other')`,
    [OWNED_WS, userId, OTHER_WS],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES
       ($1, $2, $3, '我的会话'), ($4, 'u_other', $5, '别人的会话')`,
    [OWNED, userId, OWNED_WS, OTHER, OTHER_WS],
  )

  await platform.db.query(
    `INSERT INTO dsh_session_headers (session_id, header, next_seq) VALUES ($1, $2, $3)`,
    [OWNED, '{}', 5],
  )
  await platform.db.query(
    `INSERT INTO dsh_session_events (session_id, seq, event) VALUES
       ($1, 1, $2), ($1, 2, $3), ($1, 3, $4)`,
    [
      OWNED,
      event(1, { input: 100, cacheRead: 50, output: 10 }),
      JSON.stringify({ type: 'user/message', seq: 2, time: 1, data: { content: [] } }),
      event(3, { input: 200, cacheRead: 30, output: 20 }),
    ],
  )

  const at = new Date().toISOString()
  await platform.db.query(
    `INSERT INTO dsh_usage_steps
       (session_id, seq, user_id, workspace_id, at, provider, model,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, amount)
     VALUES
       ($1, 1, $2, $3, $4, 'user', 'deepseek-chat', 100, 50, 0, 10, 0.001),
       ($1, 3, $2, $3, $4, 'user', 'deepseek-chat', 200, 30, 0, 20, 0.002),
       ($5, 1, 'u_other', $6, $4, 'user', 'deepseek-chat', 900, 0, 0, 90, 0.009)`,
    [OWNED, userId, OWNED_WS, at, OTHER, OTHER_WS],
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

describe('genui 懒加载资产', () => {
  it('白名单脚本以 JS 类型和长缓存交付', async () => {
    const response = await fetch(`${baseUrl}/plugins/@changfenhuang/dsh-genui/assets/mermaid.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await response.text()).length).toBeGreaterThan(1000)
  })

  it('HEAD 只回头，不接管其他方法', async () => {
    const head = await fetch(`${baseUrl}/plugins/@changfenhuang/dsh-genui/assets/echarts-core.js`, {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await fetch(`${baseUrl}/plugins/@changfenhuang/dsh-genui/assets/mermaid.js`, {
      method: 'POST',
    })
    expect(post.status).toBe(405)
  })

  it('目录穿越、子目录、非白名单一律 404', async () => {
    for (const path of [
      '/plugins/@changfenhuang/dsh-genui/assets/..%2Fclient.js',
      '/plugins/@changfenhuang/dsh-genui/assets/nested/mermaid.js',
      '/plugins/@changfenhuang/dsh-genui/assets/standalone.js',
      '/plugins/@changfenhuang/dsh-genui/assets/mermaid.css',
    ]) {
      const response = await fetch(`${baseUrl}${path}`)
      expect(response.status, path).toBe(404)
    }
  })

  it('启动图带上 genui 和 context 两个浏览器半', async () => {
    const response = await fetch(`${baseUrl}/`, { headers: { cookie } })
    const html = await response.text()
    expect(html).toContain('@changfenhuang/dsh-genui')
    expect(html).toContain('dsh-context')
  })
})

describe('dsh-context 平台端点', () => {
  it('version / fleet / balance 返回形状合法的空结果，且不转给脑', async () => {
    const version = await context('version', {})
    expect(version.status).toBe(200)
    expect(version.headers.get('cache-control')).toBe('no-store')
    expect(version.body).toMatchObject({
      ok: true,
      value: { ready: true, failed: false, current: null },
    })

    const fleet = await context('fleet', { sessionId: OWNED })
    expect(fleet.body).toMatchObject({ ok: true, value: { messages: [], truncated: false } })

    const balance = await context('balance', {})
    expect(balance.body).toMatchObject({ ok: true, value: { isAvailable: false, balances: [] } })

    expect(brainHits.some((hit) => hit.includes('dsh-context'))).toBe(false)
  })

  it('overview 的汇总、七天柱和会话卡只统计当前成员', async () => {
    const summary = await context('overview', { part: 'summary' })
    expect(summary.body.ok).toBe(true)
    const value = summary.body.value as Record<string, unknown>
    expect(typeof value.revision).toBe('string')
    expect(value.pricingReady).toBe(false)
    expect(value.summary).toMatchObject({
      sessions: 1,
      sessionsTotal: 1,
      sessionsArchived: 0,
      tokens: 410,
      turns: 2,
      usageSessions: 1,
    })

    const days = await context('overview', { part: 'days' })
    const bars = (days.body.value as { days: Array<{ key: string; tokens: number }> }).days
    expect(bars).toHaveLength(7)
    expect(bars.at(-1)?.tokens).toBe(410)

    const page = await context('overview', { part: 'page', page: 0 })
    const cards = (page.body.value as {
      page: { items: Array<Record<string, unknown>>; total: number; count: number }
    }).page
    expect(cards.total).toBe(1)
    expect(cards.count).toBe(20)
    expect(cards.items).toHaveLength(1)
    expect(cards.items[0]).toMatchObject({
      id: OWNED,
      title: '我的会话',
      tokens: 410,
      turns: 2,
      total: 230,
      model: 'deepseek-chat',
    })
    expect(Number(cards.items[0]?.costUsd)).toBeCloseTo(0.003, 10)
  })

  it('detail 给出上下文大小、逐轮序列和可重放事件', async () => {
    const response = await context('detail', { sessionId: OWNED })
    expect(response.body.ok).toBe(true)
    const value = response.body.value as {
      rev: number
      head: Record<string, unknown>
      events: Array<{ type: string }>
    }
    expect(value.rev).toBe(4)
    expect(value.head).toMatchObject({
      current: { total: 230, user: 230 },
      counts: { turns: 2, steps: 2 },
      detailRev: 4,
      model: 'deepseek-chat',
      provider: 'user',
      generatedAnswerTokens: 20,
    })
    const requests = value.head.requests as Array<{ seq: number; prompt: number }>
    expect(requests.map((point) => point.seq)).toEqual([1, 3])
    expect(requests.map((point) => point.prompt)).toEqual([150, 230])
    expect(value.events.map((item) => item.type)).toEqual(['assistant/message', 'assistant/message'])

    const headOnly = await context('detail', { sessionId: OWNED, head: true })
    const head = (headOnly.body.value as { head: Record<string, unknown> }).head
    expect(head).toMatchObject({ current: { total: 230 } })
  })

  it('facts 按块读取，未知块进 missing', async () => {
    const response = await context('facts', {
      sessionId: OWNED,
      parts: ['head', 'series', 'events', 'nodes', 'mystery'],
    })
    const value = response.body.value as Record<string, unknown>
    expect(value).toMatchObject({ rev: 4, live: true })
    expect((value.parts as Record<string, unknown>).nodes).toEqual({
      nodes: [], archive: [], droppedNodes: 0,
    })
    expect((value.parts as Record<string, unknown>).series).toHaveLength(2)
    expect(value.missing).toEqual(['mystery'])
  })

  it('heads 只返回当前成员名下的会话', async () => {
    const response = await context('heads', { ids: [OWNED, OTHER] })
    const value = response.body.value as Record<string, { head: Record<string, unknown> }>
    expect(Object.keys(value)).toEqual([OWNED])
    expect(value[OWNED]?.head).toMatchObject({ current: { total: 230 } })
  })

  it('别人的 sessionId 不泄露，统一回 ok:false', async () => {
    for (const endpoint of ['detail', 'facts', 'delta', 'commands', 'attachment', 'skills']) {
      const response = await context(endpoint, { sessionId: OTHER })
      expect(response.status, endpoint).toBe(200)
      expect(response.body, endpoint).toMatchObject({
        ok: false,
        error: { code: 'context/session-not-found' },
      })
    }
  })

  it('另一个成员只看到自己的数字', async () => {
    const summary = await context('overview', { part: 'summary' }, otherCookie)
    const value = summary.body.value as { summary: { tokens: number; sessions: number } }
    expect(value.summary.tokens).toBe(990)
    expect(value.summary.sessions).toBe(1)

    const page = await context('overview', { part: 'page' }, otherCookie)
    const cards = (page.body.value as { page: { items: Array<{ id: string }> } }).page
    expect(cards.items.map((item) => item.id)).toEqual([OTHER])

    const detail = await context('detail', { sessionId: OWNED }, otherCookie)
    expect(detail.body).toMatchObject({ ok: false })
  })

  it('backfill 触发一次投影后立刻返回', async () => {
    const response = await context('backfill', {})
    expect(response.body).toEqual({ ok: true, value: {} })
  })

  it('非 POST 和未知端点都有明确响应', async () => {
    const wrongMethod = await fetch(`${baseUrl}/dsh-api/platform/v1/context/version`, { headers: { cookie } })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const unknown = await context('nope', {})
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({
      ok: false,
      error: { code: 'context/unknown-endpoint' },
    })
  })
})
