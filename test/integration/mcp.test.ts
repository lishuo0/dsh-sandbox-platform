import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseServers, type McpRow } from '../../../dsh-sandbox-brain/packages/dsh-user-mcp/src/index.ts'
import { open } from '../../src/kernel/seal.js'
import { decodeKey } from '../../src/config.js'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * MCP 服务器：公开 / 私有作用域、详情与编辑。
 *
 * 私有行只有 owner 能看能改；公开行所有成员可读、只有管理员可改。
 * 密钥写进 dsh_user_credentials，config 里只留 `cred:mcp/<server>/<header>` 引用。
 */

let platform: TestPlatform
let token: string
let memberToken: string

beforeAll(async () => {
  platform = await startTestPlatform()
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  await api(platform.baseUrl, '/admin/users', {
    method: 'POST',
    token,
    body: { username: 'grace', password: 'grace-password-1234' },
  })
  memberToken = await login(platform.baseUrl, 'grace', 'grace-password-1234')
})

afterAll(async () => {
  await platform.close()
})

interface McpView {
  name: string
  url: string
  scope: string
  enabled: boolean
  timeoutMs: number | null
  headers: Array<{ name: string; secret?: boolean; value?: string }>
  ownerId: string
  ownerDisplayName: string
  mine: boolean
}

function configOf(value: unknown): { headers?: Record<string, string>; toolCallTimeoutMs?: number } {
  return typeof value === 'string' ? JSON.parse(value) : (value as { headers?: Record<string, string> })
}

describe('MCP 服务器', () => {
  it('保存私有 MCP：行、超时、明文 header 和密钥引用都落库', async () => {
    const response = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: {
        name: 'my-search',
        url: 'https://mcp.example.com/search',
        timeoutMs: 45_000,
        headers: {
          'X-Env': { value: 'prod' },
          Authorization: { secret: 'Bearer super-secret' },
        },
      },
    })
    expect(response.status).toBe(201)
    expect(response.body.data).toEqual({ name: 'my-search', scope: 'private' })

    const rows = await platform.db.query(
      `SELECT user_id, server_name, transport, target, config, scope, enabled FROM dsh_mcp_servers WHERE server_name = 'my-search'`,
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      user_id: 'admin',
      server_name: 'my-search',
      transport: 'streamable-http',
      target: 'https://mcp.example.com/search',
      scope: 'private',
    })
    const config = configOf(rows.rows[0]!.config)
    expect(config).toEqual({
      headers: { 'X-Env': 'prod', Authorization: 'cred:mcp/my-search/Authorization' },
      toolCallTimeoutMs: 45_000,
    })

    const credentials = await platform.db.query<{ user_id: string; ciphertext: Buffer | Uint8Array | string }>(
      `SELECT user_id, ciphertext FROM dsh_user_credentials WHERE kind = 'mcp-header' AND name = 'my-search/Authorization'`,
    )
    expect(credentials.rows).toHaveLength(1)
    expect(credentials.rows[0]!.user_id).toBe('admin')
    const cipher = credentials.rows[0]!.ciphertext
    const opened = open(decodeKey(platform.config.credentialsKey), Buffer.from(cipher as Uint8Array))
    expect(opened).toBe('Bearer super-secret')
  })

  it('详情把密钥标成 secret，把明文 header 原样返回', async () => {
    const detail = await api<McpView>(platform.baseUrl, '/mcp-servers/my-search', { token })
    expect(detail.status).toBe(200)
    expect(detail.body.data).toMatchObject({
      name: 'my-search',
      url: 'https://mcp.example.com/search',
      scope: 'private',
      enabled: true,
      timeoutMs: 45_000,
      ownerId: 'admin',
      mine: true,
    })
    expect(detail.body.data.ownerDisplayName).toBeTruthy()
    expect(detail.body.data.headers).toEqual(
      expect.arrayContaining([
        { name: 'X-Env', secret: false, value: 'prod' },
        { name: 'Authorization', secret: true },
      ]),
    )
  })

  it('列表只给本人和公开行', async () => {
    const mine = await api<McpView[]>(platform.baseUrl, '/mcp-servers', { token })
    expect(mine.body.data).toEqual([expect.objectContaining({ name: 'my-search', scope: 'private' })])

    const other = await api<McpView[]>(platform.baseUrl, '/mcp-servers', { token: memberToken })
    expect(other.body.data).toEqual([])
    const hidden = await api(platform.baseUrl, '/mcp-servers/my-search', { token: memberToken })
    expect(hidden.status).toBe(404)
  })

  it('keepSecret 保留原密钥，不重填也能改 URL', async () => {
    const updated = await api(platform.baseUrl, '/mcp-servers/my-search', {
      method: 'PUT',
      token,
      body: {
        url: 'https://mcp.example.com/search-v2',
        timeoutMs: 60_000,
        headers: { 'X-Env': { value: 'staging' }, Authorization: { keepSecret: true } },
      },
    })
    expect(updated.status).toBe(200)

    const rows = await platform.db.query(`SELECT target, config FROM dsh_mcp_servers WHERE server_name = 'my-search'`)
    expect(rows.rows[0]!.target).toBe('https://mcp.example.com/search-v2')
    expect(configOf(rows.rows[0]!.config)).toEqual({
      headers: { 'X-Env': 'staging', Authorization: 'cred:mcp/my-search/Authorization' },
      toolCallTimeoutMs: 60_000,
    })

    const detail = await api<McpView>(platform.baseUrl, '/mcp-servers/my-search', { token })
    expect(detail.body.data.timeoutMs).toBe(60_000)
    expect(detail.body.data.headers).toEqual(
      expect.arrayContaining([
        { name: 'X-Env', secret: false, value: 'staging' },
        { name: 'Authorization', secret: true },
      ]),
    )
  })

  it('keepSecret 对没有密钥的 header 报 422', async () => {
    const response = await api(platform.baseUrl, '/mcp-servers/my-search', {
      method: 'PUT',
      token,
      body: { url: 'https://mcp.example.com/search-v2', headers: { 'X-New-Secret': { keepSecret: true } } },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('missing-secret')
  })

  it('名字、URL、header 名非法时 422', async () => {
    const badName = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'Bad Name', url: 'https://mcp.example.com/x' },
    })
    expect(badName.status).toBe(422)
    expect(badName.body.msg).toBe('invalid-name')

    const badUrl = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'plain-http', url: 'http://mcp.example.com/x' },
    })
    expect(badUrl.status).toBe(422)
    expect(badUrl.body.msg).toBe('invalid-url')

    const badHeader = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'bad-header', url: 'https://mcp.example.com/x', headers: { 'X Y': { value: 'v' } } },
    })
    expect(badHeader.status).toBe(422)
    expect(badHeader.body.msg).toBe('invalid-header')
  })

  it('公开 MCP：管理员可写，成员只读，所有人都能看到', async () => {
    const created = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'shared-tools', url: 'https://mcp.example.com/shared', scope: 'public' },
    })
    expect(created.status).toBe(201)

    const visible = await api<McpView[]>(platform.baseUrl, '/mcp-servers', { token: memberToken })
    expect(visible.body.data).toEqual([
      expect.objectContaining({ name: 'shared-tools', scope: 'public', mine: false }),
    ])
    const detail = await api<McpView>(platform.baseUrl, '/mcp-servers/shared-tools?scope=public', {
      token: memberToken,
    })
    expect(detail.status).toBe(200)
    expect(detail.body.data.ownerId).toBe('admin')

    const denied = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token: memberToken,
      body: { name: 'member-public', url: 'https://mcp.example.com/x', scope: 'public' },
    })
    expect(denied.status).toBe(403)
    expect(denied.body.msg).toBe('admin-only')
    const put = await api(platform.baseUrl, '/mcp-servers/shared-tools?scope=public', {
      method: 'PUT',
      token: memberToken,
      body: { url: 'https://mcp.example.com/hacked' },
    })
    expect(put.status).toBe(403)
    const remove = await api(platform.baseUrl, '/mcp-servers/shared-tools?scope=public', {
      method: 'DELETE',
      token: memberToken,
    })
    expect(remove.status).toBe(403)
  })

  it('私有和公开同名的第二行被拒绝', async () => {
    const created = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'shadowed', url: 'https://mcp.example.com/public', scope: 'public' },
    })
    expect(created.status).toBe(201)
    const conflict = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'shadowed', url: 'https://mcp.example.com/private' },
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body.msg).toBe('name-taken')
  })

  it('停用、启用和删除都按 scope 定位；删除会清掉该服务器的密钥', async () => {
    await api(platform.baseUrl, '/mcp-servers/my-search/disable', { method: 'POST', token })
    let detail = await api<McpView>(platform.baseUrl, '/mcp-servers/my-search', { token })
    expect(detail.body.data.enabled).toBe(false)

    await api(platform.baseUrl, '/mcp-servers/my-search/enable', { method: 'POST', token })
    detail = await api<McpView>(platform.baseUrl, '/mcp-servers/my-search', { token })
    expect(detail.body.data.enabled).toBe(true)

    const removed = await api(platform.baseUrl, '/mcp-servers/my-search', { method: 'DELETE', token })
    expect(removed.status).toBe(200)
    const rows = await platform.db.query(`SELECT 1 FROM dsh_mcp_servers WHERE server_name = 'my-search'`)
    expect(rows.rows).toHaveLength(0)
    const credentials = await platform.db.query(
      `SELECT 1 FROM dsh_user_credentials WHERE kind = 'mcp-header' AND name LIKE 'my-search/%'`,
    )
    expect(credentials.rows).toHaveLength(0)
    const again = await api(platform.baseUrl, '/mcp-servers/my-search', { method: 'DELETE', token })
    expect(again.status).toBe(404)
  })

  it('公开服务器只有管理员能停用或删除', async () => {
    const disable = await api(platform.baseUrl, '/mcp-servers/shared-tools/disable?scope=public', {
      method: 'POST',
      token: memberToken,
    })
    expect(disable.status).toBe(403)

    const remove = await api(platform.baseUrl, '/mcp-servers/shared-tools?scope=public', {
      method: 'DELETE',
      token,
    })
    expect(remove.status).toBe(200)
    const rows = await platform.db.query(`SELECT 1 FROM dsh_mcp_servers WHERE server_name = 'shared-tools'`)
    expect(rows.rows).toHaveLength(0)
  })

  it('私有和公开并存：平台列表和脑侧查询/选择都同时拿到', async () => {
    const created = [
      await api(platform.baseUrl, '/mcp-servers', {
        method: 'POST',
        token: memberToken,
        body: { name: 'mine-docs', url: 'https://mcp.example.com/mine' },
      }),
      await api(platform.baseUrl, '/mcp-servers', {
        method: 'POST',
        token,
        body: { name: 'team-docs', url: 'https://mcp.example.com/team', scope: 'public' },
      }),
    ]
    expect(created.map((response) => response.status)).toEqual([201, 201])

    // 平台自己的列表：成员看到「自己的私有 + 管理员的公开」，看不到管理员的私有行。
    const listed = await api<McpView[]>(platform.baseUrl, '/mcp-servers', { token: memberToken })
    const listedPair = listed.body.data
      .filter((server) => server.name === 'mine-docs' || server.name === 'team-docs')
      .sort((left, right) => left.name.localeCompare(right.name))
    expect(listedPair).toEqual([
      expect.objectContaining({ name: 'mine-docs', scope: 'private', ownerId: 'grace', mine: true }),
      expect.objectContaining({ name: 'team-docs', scope: 'public', ownerId: 'admin', mine: false }),
    ])

    // 脑侧原样跑 dsh-user-mcp 的 SQL，再接 chooseServers，确认两条都能挂。
    const rows = await platform.db.query<McpRow>(
      `SELECT user_id, server_name, transport, target, config, scope
         FROM dsh_mcp_servers
        WHERE enabled = true AND (user_id = $1 OR scope = 'public')
        ORDER BY server_name`,
      ['grace'],
    )
    expect(rows.rows.some((row) => row.user_id === 'admin' && row.scope === 'private')).toBe(false)

    const chosen = chooseServers(rows.rows)
      .filter((row) => row.server_name === 'mine-docs' || row.server_name === 'team-docs')
      .map((row) => ({ name: row.server_name, user: row.user_id, scope: row.scope, target: row.target }))
    expect(chosen).toEqual([
      { name: 'mine-docs', user: 'grace', scope: 'private', target: 'https://mcp.example.com/mine' },
      { name: 'team-docs', user: 'admin', scope: 'public', target: 'https://mcp.example.com/team' },
    ])
  })
})
