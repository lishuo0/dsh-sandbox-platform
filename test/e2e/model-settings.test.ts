import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 设置 → 模型（平台自有页）的 HTTP 行为。
 *
 * 页面读写 `/settings/model` 的多提供商接口：`POST` 新增、`PUT /:id` 更新、
 * `DELETE /:id` 删一条、`DELETE` 清空。每个提供商的密钥单独进密文库，读回只给
 * 掩码；模型名单去空白、去重；删光配置后就不能再开会话（平台不在脑里保留
 * 成员凭据）。
 */

let platform: TestPlatform
let token = ''

const KEY = 'sk-test-abcdef123456'
const BASE = {
  baseUrl: 'https://llm.test/v1',
  apiKey: KEY,
  modelIds: ['deepseek-chat', 'deepseek-reasoner'],
  defaultModel: 'deepseek-chat',
}

interface ProviderView {
  id: string
  displayName: string
  baseUrl: string
  api: string
  modelIds: string[]
  defaultModel: string
  apiKeyMasked: string
  configured: boolean
}

interface ModelsPageView {
  configured: boolean
  providers: ProviderView[]
}

beforeAll(async () => {
  platform = await startTestPlatform()
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
})

afterAll(async () => {
  await platform.close()
})

async function page(): Promise<ModelsPageView> {
  const response = await api<ModelsPageView>(platform.baseUrl, '/settings/model', { token })
  expect(response.status).toBe(200)
  return response.body.data
}

describe('设置 → 模型', () => {
  it('未配置时是明确的空配置，不给假密钥', async () => {
    const response = await api<ModelsPageView>(platform.baseUrl, '/settings/model', { token })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ configured: false, providers: [] })
  })

  it('新增提供商后读回只给掩码，不回传密钥', async () => {
    const saved = await api<ProviderView>(platform.baseUrl, '/settings/model', { method: 'POST', token, body: BASE })
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({
      displayName: 'llm.test',
      baseUrl: BASE.baseUrl,
      api: 'openai-completions',
      modelIds: BASE.modelIds,
      defaultModel: 'deepseek-chat',
      apiKeyMasked: 'sk…56',
      configured: true,
    })
    expect(saved.body.data.id).toMatch(/^mp_[0-9a-f]{16}$/)
    expect(saved.body.data).not.toHaveProperty('apiKey')

    const read = await api<ModelsPageView>(platform.baseUrl, '/settings/model', { token })
    expect(read.body.data.configured).toBe(true)
    expect(read.body.data.providers).toHaveLength(1)
    expect(read.body.data.providers[0]?.id).toBe(saved.body.data.id)
    expect(read.text).not.toContain(KEY)

    // 密钥按提供商 id 各存一份密文，不是原文。
    const rows = await platform.db.query<{ ciphertext: unknown }>(
      `SELECT ciphertext FROM dsh_user_credentials
        WHERE user_id = $1 AND kind = 'model-api-key' AND name = $2`,
      [platform.config.auth.adminUsername, saved.body.data.id],
    )
    expect(rows.rows).toHaveLength(1)
    expect(String(rows.rows[0]?.ciphertext)).not.toContain(KEY)
  })

  it('更新提供商时不带密钥沿用已存密钥，可改显示名和默认模型', async () => {
    const before = await page()
    const id = before.providers[0]!.id

    const updated = await api<ProviderView>(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: {
        displayName: '主力模型',
        baseUrl: BASE.baseUrl,
        modelIds: BASE.modelIds,
        defaultModel: 'deepseek-reasoner',
      },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.data).toMatchObject({
      id,
      displayName: '主力模型',
      defaultModel: 'deepseek-reasoner',
      apiKeyMasked: 'sk…56',
      configured: true,
    })

    const read = await page()
    expect(read.providers[0]).toMatchObject({ id, displayName: '主力模型', defaultModel: 'deepseek-reasoner' })
  })

  it('名单去空白、去重、丢空项', async () => {
    const id = (await page()).providers[0]!.id
    const saved = await api(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: {
        ...BASE,
        modelIds: [' deepseek-chat ', 'deepseek-chat', '', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
      },
    })
    expect(saved.status).toBe(200)
    expect((await page()).providers[0]?.modelIds).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('默认模型不在名单里 422', async () => {
    const id = (await page()).providers[0]!.id
    const response = await api(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: { ...BASE, defaultModel: 'gpt-unknown' },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('default-model-not-listed')
  })

  it('公网 http、带账号密码、坏地址都拒绝；本机 http 放行', async () => {
    for (const baseUrl of ['http://llm.example.com/v1', 'https://user:pass@llm.test/v1', 'not-a-url']) {
      const response = await api(platform.baseUrl, '/settings/model', { method: 'POST', token, body: { ...BASE, baseUrl } })
      expect(response.status).toBe(422)
      expect(response.body.msg).toBe('model-config-required')
    }

    const local = await api<ProviderView>(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { ...BASE, baseUrl: 'http://127.0.0.1:8000/v1', displayName: '本地网关' },
    })
    expect(local.status).toBe(200)
    expect(local.body.data).toMatchObject({ displayName: '本地网关', baseUrl: 'http://127.0.0.1:8000/v1' })

    // 两个提供商并存，页面按新增顺序列出。
    const read = await page()
    expect(read.providers.map((provider) => provider.baseUrl)).toEqual(['https://llm.test/v1', 'http://127.0.0.1:8000/v1'])
  })

  it('首次新增没密钥 422', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'jack', password: 'jack-password-1234' },
    })
    const jack = await login(platform.baseUrl, 'jack', 'jack-password-1234')
    const response = await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token: jack,
      body: { baseUrl: BASE.baseUrl, modelIds: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('model-api-key-required')
  })

  it('删除单个提供商只删这一条；不存在的 id 404', async () => {
    const before = await page()
    expect(before.providers).toHaveLength(2)
    const [first, second] = before.providers

    const removed = await api(platform.baseUrl, `/settings/model/${first!.id}`, { method: 'DELETE', token })
    expect(removed.status).toBe(200)

    const read = await page()
    expect(read.providers.map((provider) => provider.id)).toEqual([second!.id])
    expect(read.configured).toBe(true)

    const missing = await api(platform.baseUrl, `/settings/model/mp_missing`, { method: 'DELETE', token })
    expect(missing.status).toBe(404)
    expect(missing.body.msg).toBe('provider-not-found')

    // 更新不存在的提供商同样 404。
    const ghost = await api(platform.baseUrl, '/settings/model/mp_missing', { method: 'PUT', token, body: BASE })
    expect(ghost.status).toBe(404)
    expect(ghost.body.msg).toBe('provider-not-found')
  })

  it('删除配置后回到未配置，并且不能再开会话', async () => {
    const removed = await api(platform.baseUrl, '/settings/model', { method: 'DELETE', token })
    expect(removed.status).toBe(200)

    const read = await api<ModelsPageView>(platform.baseUrl, '/settings/model', { token })
    expect(read.body.data).toEqual({ configured: false, providers: [] })

    const created = await api(platform.baseUrl, '/sessions', { method: 'POST', token, body: { title: '没模型' } })
    expect(created.status).toBe(422)
    expect(created.body.msg).toBe('model-config-required')
  })
})
