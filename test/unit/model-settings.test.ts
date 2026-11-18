import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { modelCatalog } from '../../src/modules/models/catalog.js'
import { createProvider, listProviders } from '../../src/modules/models/service.js'
import {
  clearModelApiKey,
  maskModelKey,
  modelApiKeyStatus,
  normalizeModelApiKey,
  setModelApiKey,
  tokenPlanStatus,
} from '../../src/modules/models/settings.js'

/**
 * 成员级模型 Key 和 TokenPlan：Key 加密落库、只回脱敏值；
 * TokenPlan 只读集团接口，失败按字段各自报错。
 */

let dir: string
let db: SqliteDb
let key: Buffer

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir: join(dir, 'objects') },
    ...overrides,
  } as unknown as AppConfig
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-model-settings-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  key = randomBytes(32)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('模型 API Key', () => {
  it('未配置时只回 configured=false', async () => {
    expect(await modelApiKeyStatus(db, key, 'u1')).toEqual({ configured: false })
    expect(await modelApiKeyStatus(db, key, 'u2')).toEqual({ configured: false })
  })

  it('保存后回脱敏值，库里是密文', async () => {
    const status = await setModelApiKey(db, key, 'u1', ' sk-abcdefgh12345678 ')
    expect(status).toEqual({ configured: true, masked: 'sk-a****5678' })
    expect(await modelApiKeyStatus(db, key, 'u1')).toEqual(status)

    const rows = await db.query<{ ciphertext: Buffer }>(`SELECT ciphertext FROM dsh_user_credentials WHERE user_id = 'u1'`)
    expect(rows.rows).toHaveLength(1)
    const blob = Buffer.from(rows.rows[0]!.ciphertext)
    expect(blob.includes(Buffer.from('sk-abcdefgh12345678'))).toBe(false)
    // 另一个成员看不到。
    expect(await modelApiKeyStatus(db, key, 'u2')).toEqual({ configured: false })
  })

  it('重复保存是覆盖，删除后回到未配置', async () => {
    await setModelApiKey(db, key, 'u1', 'first-key-123456')
    const replaced = await setModelApiKey(db, key, 'u1', 'second-key-abcdef')
    expect(replaced.masked).toBe('seco****cdef')

    expect(await clearModelApiKey(db, 'u1')).toEqual({ configured: false })
    expect(await modelApiKeyStatus(db, key, 'u1')).toEqual({ configured: false })
    expect(await clearModelApiKey(db, 'u1')).toEqual({ configured: false })
  })

  it('空值、空白和控制字符都拒绝', async () => {
    expect(() => normalizeModelApiKey('')).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
    expect(() => normalizeModelApiKey('   ')).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
    expect(() => normalizeModelApiKey('a b')).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
    expect(() => normalizeModelApiKey('a\nb')).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
    expect(() => normalizeModelApiKey(123)).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
    expect(() => normalizeModelApiKey('x'.repeat(4097))).toThrowError(expect.objectContaining({ code: 'invalid-api-key' }))
  })

  it('脱敏规则', () => {
    expect(maskModelKey('')).toBe('')
    expect(maskModelKey('short')).toBe('****')
    expect(maskModelKey('12345678')).toBe('****')
    expect(maskModelKey('123456789')).toBe('1234****6789')
  })
})

describe('TokenPlan', () => {
  it('没配 Key 时提示先配置，不请求上游', async () => {
    const call = vi.fn()
    const status = await tokenPlanStatus(db, key, config({ tokenPlan: { apiBaseUrl: 'https://plan.example.com' } }), 'u1', {
      fetch: call,
    })
    expect(call).not.toHaveBeenCalled()
    expect(status).toMatchObject({
      configured: false,
      catalog: [],
      catalogError: '请先配置 API Key。',
      balanceError: '请先配置 API Key。',
    })
    expect(status).not.toHaveProperty('apiKeyMask')
  })

  it('配了 Key 但部署没配接口时按字段报错', async () => {
    await setModelApiKey(db, key, 'u1', 'tp-key-123456')
    const status = await tokenPlanStatus(db, key, config(), 'u1', { fetch: vi.fn() })
    expect(status.configured).toBe(true)
    expect(status.apiKeyMask).toBe('tp-k****3456')
    expect(status.catalogError).toBe('当前部署未配置 TokenPlan 接口。')
    expect(status.balanceError).toBe('当前部署未配置 TokenPlan 接口。')
  })

  it('拉取目录和额度，带上渠道头和 Bearer', async () => {
    await setModelApiKey(db, key, 'u1', 'tp-key-123456')
    const call = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      const headers = init?.headers as Record<string, string>
      expect(headers['api-key']).toBe('tp-key-123456')
      expect(headers.authorization).toBe('Bearer tp-key-123456')
      if (target.includes('/v1/token-plan/models')) {
        expect(target).toContain('channel=deepseek')
        expect(headers['x-agent-channel']).toBe('deepseek')
        return jsonResponse({
          data: [
            {
              id: 'deepseek-chat',
              name: 'DeepSeek Chat',
              context_window: 128000,
              max_output_tokens: 8192,
              is_recommended: true,
            },
            { id: 'bad-entry-missing-nothing' },
            { name: '没有 id' },
          ],
        })
      }
      return jsonResponse({
        data: {
          limit: 100,
          used: 25,
          remaining: 75,
          usage_ratio: 0.25,
          cycle_start: '2026-11-01T00:00:00Z',
          cycle_end: '2026-12-01T00:00:00Z',
          reset: '2026-12-01T00:00:00Z',
        },
      })
    })

    const status = await tokenPlanStatus(
      db,
      key,
      config({
        tokenPlan: {
          apiBaseUrl: 'https://plan.example.com/',
          channel: 'deepseek',
          defaultModel: 'deepseek-chat',
          applyUrl: 'https://plan.example.com/apply',
        },
      }),
      'u1',
      { fetch: call as unknown as typeof fetch },
    )

    expect(call).toHaveBeenCalledTimes(2)
    expect(status.catalog).toEqual([
      expect.objectContaining({
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        model: 'deepseek-chat',
        recommended: true,
        contextWindow: 128000,
        maxTokens: 8192,
        input: ['text', 'image'],
      }),
      expect.objectContaining({ id: 'bad-entry-missing-nothing', name: 'bad-entry-missing-nothing' }),
    ])
    expect(status.balance).toMatchObject({ limit: 100, used: 25, remaining: 75, usageRatio: 0.25, resetAt: '2026-12-01T00:00:00Z' })
    expect(status.catalogFetchedAt).toBeTruthy()
    expect(status.balanceFetchedAt).toBeTruthy()
    expect(status.defaultModel).toBe('deepseek-chat')
    expect(status.applyUrl).toBe('https://plan.example.com/apply')
    expect(status.catalogError).toBeUndefined()
    expect(status.balanceError).toBeUndefined()
  })

  it('上游错误回显 key 时脱敏并截断', async () => {
    await setModelApiKey(db, key, 'u1', 'tp-key-123456')
    const errorBody = `无效 key tp-key-123456 ${'x'.repeat(500)}`
    const call = vi.fn(async () => jsonResponse({ message: errorBody }, 401))
    const status = await tokenPlanStatus(
      db,
      key,
      config({ tokenPlan: { apiBaseUrl: 'https://plan.example.com' } }),
      'u1',
      { fetch: call as unknown as typeof fetch },
    )
    expect(status.catalogError).not.toContain('tp-key-123456')
    expect(status.catalogError).toContain('[redacted]')
    expect(status.catalogError!.length).toBeLessThanOrEqual(320)
    expect(status.balanceError).toBe(status.catalogError)
  })

  it('额度失败不影响目录', async () => {
    await setModelApiKey(db, key, 'u1', 'tp-key-123456')
    const call = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/models')) return jsonResponse({ data: [{ id: 'm1' }] })
      return new Response('not json', { status: 502 })
    })
    const status = await tokenPlanStatus(
      db,
      key,
      config({ tokenPlan: { apiBaseUrl: 'https://plan.example.com' } }),
      'u1',
      { fetch: call as unknown as typeof fetch },
    )
    expect(status.catalog.map((model) => model.id)).toEqual(['m1'])
    expect(status.catalogError).toBeUndefined()
    expect(status.balanceError).toBe('HTTP 502')
  })
})

describe('模型目录', () => {
  it('没有配好密钥的提供商就是空目录', async () => {
    expect(await modelCatalog(db, key, 'u1')).toEqual({ routableProviders: [], groups: [], failures: [] })
  })

  it('每个配好的提供商一组，默认取第一个的默认模型', async () => {
    const first = await createProvider(db, key, 'u1', {
      displayName: '官方',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-first-123456',
      modelIds: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
    })
    const second = await createProvider(db, key, 'u1', {
      baseUrl: 'https://api.other.com',
      apiKey: 'sk-second-123456',
      modelIds: ['other-model'],
      defaultModel: 'other-model',
    })

    const catalog = await modelCatalog(db, key, 'u1')
    expect(catalog.default).toEqual({ provider: first.id, model: 'deepseek-chat' })
    expect(catalog.routableProviders).toEqual([first.id, second.id])
    expect(catalog.groups).toEqual([
      { id: first.id, name: '官方', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'deepseek-reasoner', name: 'deepseek-reasoner' }] },
      { id: second.id, name: 'api.other.com', models: [{ id: 'other-model', name: 'other-model' }] },
    ])
    // 另一个成员看不到。
    expect(await modelCatalog(db, key, 'u2')).toEqual({ routableProviders: [], groups: [], failures: [] })
    expect((await listProviders(db, key, 'u1')).providers).toHaveLength(2)
  })
})
