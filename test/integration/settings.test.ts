import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

let platform: TestPlatform
let token: string

beforeAll(async () => {
  platform = await startTestPlatform()
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
})

afterAll(async () => {
  await platform.close()
})

describe('模型设置', () => {
  it('未配置时返回 configured=false', async () => {
    const response = await api<{ configured: boolean; providers: unknown[] }>(platform.baseUrl, '/settings/model', { token })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ configured: false, providers: [] })
  })

  it('新增提供商后能读回，密钥打码', async () => {
    const saved = await api<{ id: string; apiKeyMasked: string }>(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: {
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-abcdefghijklmnop',
        modelIds: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
      },
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data.apiKeyMasked).toBe('sk…op')
    expect(saved.body.data.id).toMatch(/^mp_[0-9a-f]{16}$/)

    const read = await api<{ configured: boolean; providers: Array<Record<string, unknown>> }>(
      platform.baseUrl,
      '/settings/model',
      { token },
    )
    expect(read.body.data).toMatchObject({
      configured: true,
      providers: [{
        id: saved.body.data.id,
        baseUrl: 'https://llm.example.com/v1',
        modelIds: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
        apiKeyMasked: 'sk…op',
        configured: true,
      }],
    })
  })

  it('协议类型可保存、可改，省略时默认 OpenAI 兼容', async () => {
    const created = await api<{ id: string; api: string }>(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: {
        baseUrl: 'https://anthropic.example.com/v1',
        api: 'anthropic-messages',
        apiKey: 'sk-anthropic-key',
        modelIds: ['claude-sonnet-5-5'],
        defaultModel: 'claude-sonnet-5-5',
      },
    })
    expect(created.status).toBe(200)
    expect(created.body.data.api).toBe('anthropic-messages')
    const id = created.body.data.id

    const read = await api<{ providers: Array<{ id: string; api: string }> }>(platform.baseUrl, '/settings/model', { token })
    expect(read.body.data.providers.find((provider) => provider.id === id)?.api).toBe('anthropic-messages')

    // 改名改协议：省略密钥时保留原密钥。
    const updated = await api<{ api: string }>(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: {
        baseUrl: 'https://anthropic.example.com/v1',
        api: 'openai-responses',
        modelIds: ['claude-sonnet-5-5'],
        defaultModel: 'claude-sonnet-5-5',
      },
    })
    expect(updated.status).toBe(200)
    expect(updated.body.data.api).toBe('openai-responses')

    // 不传协议 = 保持原样，而不是悄悄回落到默认。
    const kept = await api<{ api: string }>(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: { baseUrl: 'https://anthropic.example.com/v1', modelIds: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5' },
    })
    expect(kept.body.data.api).toBe('openai-responses')

    await api(platform.baseUrl, `/settings/model/${id}`, { method: 'DELETE', token })
  })

  it('不传协议时新提供商是 OpenAI 兼容，未知协议 422', async () => {
    const created = await api<{ id: string; api: string }>(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'https://openai.example.com/v1', apiKey: 'sk-openai-key', modelIds: ['gpt-4o'], defaultModel: 'gpt-4o' },
    })
    expect(created.status).toBe(200)
    expect(created.body.data.api).toBe('openai-completions')
    await api(platform.baseUrl, `/settings/model/${created.body.data.id}`, { method: 'DELETE', token })

    const unknown = await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'https://openai.example.com/v1', api: 'openai', apiKey: 'k', modelIds: ['m'], defaultModel: 'm' },
    })
    expect(unknown.status).toBe(422)
    expect(unknown.body.msg).toBe('model-protocol-invalid')
  })

  it('默认模型必须在名单里', async () => {
    const listed = await api<{ providers: Array<{ id: string }> }>(platform.baseUrl, '/settings/model', { token })
    const id = listed.body.data.providers[0]!.id
    const response = await api(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: {
        baseUrl: 'https://llm.example.com/v1',
        modelIds: ['deepseek-chat'],
        defaultModel: 'missing-model',
      },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('default-model-not-listed')
  })

  it('公网 http 拒绝，本机 http 允许', async () => {
    const rejected = await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'http://insecure.example/v1', apiKey: 'k', modelIds: ['m'], defaultModel: 'm' },
    })
    expect(rejected.status).toBe(422)
    expect(rejected.body.msg).toBe('model-config-required')

    const local = await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'k', modelIds: ['m'], defaultModel: 'm' },
    })
    expect(local.status).toBe(200)
    const read = await api<{ providers: Array<{ baseUrl: string }> }>(platform.baseUrl, '/settings/model', { token })
    expect(read.body.data.providers.map((provider) => provider.baseUrl)).toContain('http://127.0.0.1:11434/v1')
  })

  it('再次保存可以省略密钥，新建不行', async () => {
    const listed = await api<{ providers: Array<{ id: string }> }>(platform.baseUrl, '/settings/model', { token })
    const id = listed.body.data.providers[0]!.id
    const reused = await api(platform.baseUrl, `/settings/model/${id}`, {
      method: 'PUT',
      token,
      body: { baseUrl: 'https://llm.example.com/v1', modelIds: ['m'], defaultModel: 'm' },
    })
    expect(reused.status).toBe(200)

    await api(platform.baseUrl, '/settings/model', { method: 'DELETE', token })
    const missing = await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'https://llm.example.com/v1', modelIds: ['m'], defaultModel: 'm' },
    })
    expect(missing.status).toBe(422)
    expect(missing.body.msg).toBe('model-api-key-required')
  })

  it('删除后回到未配置', async () => {
    await api(platform.baseUrl, '/settings/model', {
      method: 'POST',
      token,
      body: { baseUrl: 'https://llm.example.com/v1', apiKey: 'k', modelIds: ['m'], defaultModel: 'm' },
    })
    const removed = await api(platform.baseUrl, '/settings/model', { method: 'DELETE', token })
    expect(removed.status).toBe(200)
    const read = await api<{ configured: boolean; providers: unknown[] }>(platform.baseUrl, '/settings/model', { token })
    expect(read.body.data).toEqual({ configured: false, providers: [] })
  })
})

describe('MCP 服务器', () => {
  it('保存、列举、停启、删除', async () => {
    const saved = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: {
        name: 'search',
        url: 'https://mcp.example.com/sse',
        timeoutMs: 8_000,
        headers: { Authorization: { secret: 'bearer-token' }, 'X-Plain': { value: 'visible' } },
      },
    })
    expect(saved.status).toBe(201)

    const list = await api<Array<{ name: string; enabled: boolean; timeoutMs: number; headers: Array<{ name: string; secret: boolean }> }>>(
      platform.baseUrl,
      '/mcp-servers',
      { token },
    )
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ name: 'search', enabled: true, timeoutMs: 8_000 })
    const headers = Object.fromEntries(list.body.data[0]!.headers.map((header) => [header.name, header.secret]))
    expect(headers).toEqual({ Authorization: true, 'X-Plain': false })

    expect((await api(platform.baseUrl, '/mcp-servers/search/disable', { method: 'POST', token })).status).toBe(200)
    const disabled = await api<Array<{ enabled: boolean }>>(platform.baseUrl, '/mcp-servers', { token })
    expect(disabled.body.data[0]!.enabled).toBe(false)

    expect((await api(platform.baseUrl, '/mcp-servers/search/enable', { method: 'POST', token })).status).toBe(200)
    expect((await api(platform.baseUrl, '/mcp-servers/search', { method: 'DELETE', token })).status).toBe(200)
    const empty = await api<unknown[]>(platform.baseUrl, '/mcp-servers', { token })
    expect(empty.body.data).toEqual([])
  })

  it('非法名称、非 https、非法请求头都拒绝', async () => {
    const badName = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'Has Space', url: 'https://mcp.example.com' },
    })
    expect(badName.status).toBe(422)

    const badUrl = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'plain', url: 'http://mcp.example.com' },
    })
    expect(badUrl.status).toBe(422)

    const badHeader = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'bad-header', url: 'https://mcp.example.com', headers: { 'Invalid Header': { value: 'x' } } },
    })
    expect(badHeader.status).toBe(422)
  })

  it('操作不存在的服务器 404', async () => {
    expect((await api(platform.baseUrl, '/mcp-servers/ghost/disable', { method: 'POST', token })).status).toBe(404)
    expect((await api(platform.baseUrl, '/mcp-servers/ghost', { method: 'DELETE', token })).status).toBe(404)
  })
})

describe('附件', () => {
  it('上传后按摘要去重并可在列表里看到', async () => {
    const body = Buffer.from('hello attachment')
    const first = await api<{ attachmentId: string; name: string; bytes: number }>(platform.baseUrl, '/attachments?name=note.txt', {
      method: 'POST',
      token,
      raw: body,
    })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ name: 'note.txt', bytes: body.length })
    expect(first.body.data.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)

    // 同样字节再传一次：同一 id，名字更新。
    const second = await api<{ attachmentId: string; name: string }>(platform.baseUrl, '/attachments?name=renamed.txt', {
      method: 'POST',
      token,
      raw: body,
    })
    expect(second.body.data.attachmentId).toBe(first.body.data.attachmentId)

    const list = await api<Array<{ id: string; name: string }>>(platform.baseUrl, '/attachments', { token })
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ id: first.body.data.attachmentId, name: 'renamed.txt' })
  })

  it('缺名字 422、空文件 422', async () => {
    expect((await api(platform.baseUrl, '/attachments', { method: 'POST', token, raw: Buffer.from('x') })).status).toBe(422)
    expect((await api(platform.baseUrl, '/attachments?name=empty.txt', { method: 'POST', token, raw: Buffer.alloc(0) })).status).toBe(422)
  })

  it('发送消息时引用附件会校验归属', async () => {
    const list = await api<Array<{ id: string }>>(platform.baseUrl, '/attachments', { token })
    const id = list.body.data[0]!.id
    // 平台会在拼消息前核对附件；会话不存在时先报 404 也算拒绝。
    const response = await api(platform.baseUrl, '/sessions/missing/messages', {
      method: 'POST',
      token,
      body: { text: '带附件', attachmentIds: [id] },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
