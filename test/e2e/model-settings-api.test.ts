import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signToken } from '../../src/kernel/tokens.js'
import { api, freePort, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 设置与模型接口：成员级模型 Key、TokenPlan 目录/额度、模型目录、
 * 预设目录。TokenPlan 和脑都用本地假服务，验的是平台自己的收口和脱敏。
 */

const OTHER = 'other'
const PLAN_KEY = 'tp-secret-12345678'

let platform: TestPlatform
let token: string
let otherToken: string
let plan: Server
let brain: Server
let planRequests: Array<{ url: string; headers: IncomingMessage['headers'] }>

beforeAll(async () => {
  planRequests = []
  plan = createServer((req, res) => {
    planRequests.push({ url: req.url ?? '', headers: req.headers })
    reply(res, req.url?.includes('/models')
      ? {
          data: [
            {
              id: 'deepseek-chat',
              name: 'DeepSeek Chat',
              context_window: 128000,
              max_output_tokens: 8192,
              is_recommended: true,
            },
          ],
        }
      : { data: { limit: 100, used: 10, remaining: 90, usage_ratio: 0.1, reset: '2026-12-01T00:00:00Z' } })
  })
  brain = createServer((req, res) => {
    if (req.url === '/brain/v1/presets') {
      reply(res, { presets: [{ id: 'platform', name: 'Platform' }] })
      return
    }
    if (req.url === '/brain/v1/permission-presets') {
      reply(res, { error: { code: 'not-supported', message: 'no permission presets' } }, 501)
      return
    }
    reply(res, { error: { code: 'not-found', message: 'no route' } }, 404)
  })
  const [planPort, brainPort] = await Promise.all([listen(plan), listen(brain)])
  platform = await startTestPlatform({
    brainBaseUrl: `http://127.0.0.1:${brainPort}`,
    config: {
      tokenPlan: {
        apiBaseUrl: `http://127.0.0.1:${planPort}`,
        channel: 'deepseek',
        defaultModel: 'deepseek-chat',
        applyUrl: 'https://plan.example.com/apply',
      },
    },
  })
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role) VALUES ($1, '另一个成员', 'x', 'member')`,
    [OTHER],
  )
  otherToken = signToken(platform.config.auth.tokenSecret, OTHER, 24)
})

afterAll(async () => {
  await platform.close()
  await Promise.all([close(plan), close(brain)])
})

function reply(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address !== 'string' ? address.port : 0)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('模型 API Key', () => {
  it('设置、读取、删除都只回脱敏值', async () => {
    const empty = await api<{ configured: boolean }>(platform.baseUrl, '/settings/model-api-key', { token })
    expect(empty.body.data).toEqual({ configured: false })

    const saved = await api<{ configured: boolean; masked: string }>(platform.baseUrl, '/settings/model-api-key', {
      method: 'PUT',
      token,
      body: { api_key: PLAN_KEY },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data).toEqual({ configured: true, masked: 'tp-s****5678' })
    expect(saved.text).not.toContain(PLAN_KEY)

    const status = await api<{ configured: boolean; masked: string }>(platform.baseUrl, '/settings/model-api-key', { token })
    expect(status.body.data).toEqual(saved.body.data)

    const rows = await platform.db.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1`,
      [platform.config.auth.adminUsername],
    )
    expect(Buffer.from(rows.rows[0]!.ciphertext).includes(Buffer.from(PLAN_KEY))).toBe(false)

    const cleared = await api<{ configured: boolean }>(platform.baseUrl, '/settings/model-api-key', {
      method: 'DELETE',
      token,
    })
    expect(cleared.body.data).toEqual({ configured: false })
  })

  it('空 key 拒绝，别人看不到我的配置', async () => {
    const invalid = await api(platform.baseUrl, '/settings/model-api-key', {
      method: 'PUT',
      token: otherToken,
      body: { api_key: '   ' },
    })
    expect(invalid.status).toBe(422)
    expect(invalid.body.msg).toBe('invalid-api-key')

    await api(platform.baseUrl, '/settings/model-api-key', {
      method: 'PUT',
      token,
      body: { api_key: PLAN_KEY },
    })
    const theirs = await api<{ configured: boolean }>(platform.baseUrl, '/settings/model-api-key', { token: otherToken })
    expect(theirs.body.data).toEqual({ configured: false })
  })
})

describe('TokenPlan', () => {
  it('拉目录和额度，带渠道头和成员 key', async () => {
    planRequests = []
    const status = await api<{
      configured: boolean
      apiKeyMask: string
      catalog: Array<Record<string, unknown>>
      balance: Record<string, unknown>
      defaultModel: string
      applyUrl: string
    }>(platform.baseUrl, '/settings/token-plan', { token })

    expect(status.body.data).toMatchObject({
      configured: true,
      apiKeyMask: 'tp-s****5678',
      defaultModel: 'deepseek-chat',
      applyUrl: 'https://plan.example.com/apply',
    })
    expect(status.body.data.catalog).toEqual([
      expect.objectContaining({ id: 'deepseek-chat', name: 'DeepSeek Chat', recommended: true, contextWindow: 128000 }),
    ])
    expect(status.body.data.balance).toMatchObject({ limit: 100, used: 10, remaining: 90 })
    expect(planRequests).toHaveLength(2)
    const catalogCall = planRequests.find((call) => call.url.includes('/v1/token-plan/models'))!
    expect(catalogCall.url).toContain('channel=deepseek')
    expect(catalogCall.headers['api-key']).toBe(PLAN_KEY)
    expect(catalogCall.headers.authorization).toBe(`Bearer ${PLAN_KEY}`)
    expect(catalogCall.headers['x-agent-channel']).toBe('deepseek')
  })

  it('refresh 重新请求上游', async () => {
    planRequests = []
    const refreshed = await api(platform.baseUrl, '/settings/token-plan/refresh', { method: 'POST', token })
    expect(refreshed.status).toBe(200)
    expect(planRequests).toHaveLength(2)
  })

  it('没配 key 的成员拿到提示而不是别人的额度', async () => {
    const theirs = await api<{ configured: boolean; catalogError: string }>(platform.baseUrl, '/settings/token-plan', {
      token: otherToken,
    })
    expect(theirs.body.data).toMatchObject({
      configured: false,
      catalogError: '请先配置 API Key。',
      balanceError: '请先配置 API Key。',
    })
  })
})

describe('模型目录与预设', () => {
  it('按成员的提供商拼目录', async () => {
    const before = await api<{ groups: unknown[] }>(platform.baseUrl, '/models', { token })
    expect(before.body.data.groups).toEqual([])

    const created = await api<{ id: string }>(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token: otherToken,
      body: {
        displayName: '官方',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-other-123456',
        modelIds: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
      },
    })
    expect(created.status).toBe(200)

    const catalog = await api<{
      default: { provider: string; model: string }
      routableProviders: string[]
      groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    }>(platform.baseUrl, '/models', { token: otherToken })
    expect(catalog.body.data.default).toEqual({ provider: created.body.data.id, model: 'deepseek-chat' })
    expect(catalog.body.data.routableProviders).toEqual([created.body.data.id])
    expect(catalog.body.data.groups).toEqual([
      { id: created.body.data.id, name: '官方', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
    ])
    // 别的成员看不到。
    const mine = await api<{ groups: unknown[] }>(platform.baseUrl, '/models', { token })
    expect(mine.body.data.groups).toEqual([])
  })

  it('预设目录走脑，脑没装能力时保留 501', async () => {
    const presets = await api<{ presets: Array<{ id: string }> }>(platform.baseUrl, '/presets', { token })
    expect(presets.body.data.presets).toEqual([{ id: 'platform', name: 'Platform' }])

    const permissions = await api(platform.baseUrl, '/permission-presets', { token })
    expect(permissions.status).toBe(501)
    expect(permissions.body.msg).toBe('not-supported')
  })
})
