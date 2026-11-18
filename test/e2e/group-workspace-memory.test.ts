import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signToken } from '../../src/kernel/tokens.js'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 技能 / MCP 分组、工作区详情、工作区记忆的端到端行为。
 *
 * 分组是平台自己的接口：工作区选分组后展开进 `dsh_workspace_skills` /
 * `dsh_workspace_mcp_servers`，脑只读这两张选择表。记忆是平台按对象前缀读
 * 工作卷里的 Markdown，两个成员之间互不可见。
 */

const OTHER = 'other'
const OTHER_ADMIN = 'other_admin'

let platform: TestPlatform
let token: string
let otherToken: string
let otherAdminToken: string
/** 管理员的成员 id（就是登录名）。 */
let adminId: string

beforeAll(async () => {
  platform = await startTestPlatform()
  adminId = platform.config.auth.adminUsername
  token = await login(platform.baseUrl, adminId, platform.config.auth.adminPassword)
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role) VALUES ($1, '另一个成员', 'x', 'member')`,
    [OTHER],
  )
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role) VALUES ($1, '另一个管理员', 'x', 'admin')`,
    [OTHER_ADMIN],
  )
  otherToken = signToken(platform.config.auth.tokenSecret, OTHER, 24)
  otherAdminToken = signToken(platform.config.auth.tokenSecret, OTHER_ADMIN, 24)
})

afterAll(async () => {
  await platform.close()
})

interface GroupView {
  id: string
  name: string
  description: string
  visibility: string
  skill_count?: number
  server_count?: number
}

describe('技能分组', () => {
  it('CRUD 与成员挂载', async () => {
    const created = await api<GroupView>(platform.baseUrl, '/skill-groups', {
      method: 'POST',
      token,
      body: { name: '前端', description: '前端相关技能' },
    })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ name: '前端', visibility: 'private', skill_count: 0 })
    const groupId = created.body.data.id

    for (const name of ['alpha', 'beta']) {
      const saved = await api(platform.baseUrl, '/skills', {
        method: 'POST',
        token,
        body: { name, description: `${name} 技能`, skillMd: `# ${name}`, groupId },
      })
      expect(saved.status).toBe(201)
    }
    const skillList = await api<Array<{ name: string; group_id: string | null }>>(platform.baseUrl, '/skills', { token })
    expect(skillList.body.data.map((skill) => skill.group_id)).toEqual([groupId, groupId])

    const listed = await api<GroupView[]>(platform.baseUrl, '/skill-groups', { token })
    expect(listed.body.data).toEqual([expect.objectContaining({ id: groupId, skill_count: 2 })])

    const renamed = await api<GroupView>(platform.baseUrl, `/skill-groups/${groupId}`, {
      method: 'PATCH',
      token,
      body: { name: '前端二组' },
    })
    expect(renamed.body.data).toMatchObject({ name: '前端二组', description: '前端相关技能' })

    const removed = await api(platform.baseUrl, `/skill-groups/${groupId}`, { method: 'DELETE', token })
    expect(removed.status).toBe(200)
    expect(removed.body.data).toEqual({ deleted: true })
    const after = await api(platform.baseUrl, '/skills', { token })
    expect((after.body.data as Array<{ group_id: string | null }>).every((skill) => skill.group_id === null)).toBe(true)
  })

  it('公开分组只允许管理员创建，出现在 available 列表里但只有创建者能改', async () => {
    const denied = await api(platform.baseUrl, '/skill-groups', {
      method: 'POST',
      token: otherToken,
      body: { name: '共享组', visibility: 'public' },
    })
    expect(denied.status).toBe(403)
    expect(denied.body.msg).toBe('admin-only')

    const created = await api<GroupView>(platform.baseUrl, '/skill-groups', {
      method: 'POST',
      token: otherAdminToken,
      body: { name: '共享组', visibility: 'public' },
    })
    expect(created.status).toBe(201)
    const groupId = created.body.data.id

    const own = await api<GroupView[]>(platform.baseUrl, '/skill-groups', { token })
    expect(own.body.data.map((group) => group.id)).not.toContain(groupId)
    const available = await api<GroupView[]>(platform.baseUrl, '/skill-groups?available=1', { token })
    expect(available.body.data.map((group) => group.id)).toContain(groupId)

    // 另一个管理员也不是创建者，同样改不了。
    for (const [method, path] of [
      ['PATCH', `/skill-groups/${groupId}`],
      ['DELETE', `/skill-groups/${groupId}`],
    ] as const) {
      const response = await api(platform.baseUrl, path, { method, token, body: { name: 'x' } })
      expect(response.status).toBe(404)
    }
  })

  it('工作区选分组后展开成直接选择', async () => {
    const group = await api<GroupView>(platform.baseUrl, '/skill-groups', {
      method: 'POST',
      token,
      body: { name: '展开组' },
    })
    const groupId = group.body.data.id
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'alpha', description: 'a', skillMd: '# a', groupId },
    })
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'beta', description: 'b', skillMd: '# b', groupId },
    })

    const workspace = await api<{ id: string; skills: Array<{ name: string; scope: string }>; selectionConfigured: boolean }>(
      platform.baseUrl,
      '/workspaces',
      { method: 'POST', token, body: { name: '分组工作区', skillGroupIds: [groupId] } },
    )
    expect(workspace.status).toBe(201)
    expect(workspace.body.data.selectionConfigured).toBe(true)
    expect(workspace.body.data.skills).toEqual([
      { name: 'alpha', scope: 'private' },
      { name: 'beta', scope: 'private' },
    ])
    const workspaceId = workspace.body.data.id

    const detail = await api<{ id: string; skills: unknown[] }>(platform.baseUrl, `/workspaces/${workspaceId}`, { token })
    expect(detail.body.data).toMatchObject({ id: workspaceId, selectionConfigured: true })
    expect(detail.body.data.skills).toHaveLength(2)

    const groups = await api<GroupView[]>(platform.baseUrl, `/workspaces/${workspaceId}/skill-groups`, { token })
    expect(groups.body.data.map((item) => item.id)).toEqual([groupId])

    const cleared = await api<GroupView[]>(platform.baseUrl, `/workspaces/${workspaceId}/skill-groups`, {
      method: 'PUT',
      token,
      body: { groupIds: [] },
    })
    expect(cleared.body.data).toEqual([])
    const empty = await api<{ skills: unknown[] }>(platform.baseUrl, `/workspaces/${workspaceId}`, { token })
    expect(empty.body.data.skills).toEqual([])

    const invalid = await api(platform.baseUrl, `/workspaces/${workspaceId}/skill-groups`, {
      method: 'PUT',
      token,
      body: { groupIds: [1] },
    })
    expect(invalid.status).toBe(422)
  })
})

describe('MCP 分组', () => {
  it('CRUD 与工作区展开', async () => {
    const created = await api<GroupView>(platform.baseUrl, '/mcp-groups', {
      method: 'POST',
      token,
      body: { name: '工具组' },
    })
    expect(created.status).toBe(201)
    const groupId = created.body.data.id

    const saved = await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'search', url: 'https://mcp.example.com/sse', groupId },
    })
    expect(saved.status).toBe(201)
    const listed = await api<GroupView[]>(platform.baseUrl, '/mcp-groups', { token })
    expect(listed.body.data.map((group) => group.server_count)).toEqual([1])

    const workspace = await api<{ id: string; mcpServers: Array<{ name: string }> }>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '工具工作区', mcpGroupIds: [groupId] },
    })
    expect(workspace.body.data.mcpServers).toEqual([{ name: 'search', scope: 'private' }])

    const assigned = await api<GroupView[]>(platform.baseUrl, `/workspaces/${workspace.body.data.id}/mcp-groups`, {
      method: 'PUT',
      token,
      body: { groupIds: [groupId] },
    })
    expect(assigned.body.data.map((item) => item.id)).toEqual([groupId])
  })
})

describe('工作区记忆', () => {
  let workspaceId: string

  beforeAll(async () => {
    const created = await api<{ id: string }>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '记忆工作区' },
    })
    workspaceId = created.body.data.id
    await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: '/desk/.dsh/memory/MEMORY.md', content: '# 工作区记忆\n' },
    })
    await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: {
        path: '/desk/.dsh/memory/documents/index.json',
        content: JSON.stringify({
          documents: [{ id: 'd1', title: '部署', status: 'active', filename: 'deploy.md' }],
        }),
      },
    })
    await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: '/desk/.dsh/memory/documents/active/deploy.md', content: '# 部署步骤\n' },
    })
  })

  it('读工作区记忆和文档', async () => {
    const memory = await api<{
      workspace_id: string
      available: boolean
      memory: { content: string } | null
      documents: Array<{ id: string; title: string }>
    }>(platform.baseUrl, `/workspaces/${workspaceId}/memory`, { token })
    expect(memory.body.data).toMatchObject({ workspace_id: workspaceId, available: true })
    expect(memory.body.data.memory?.content).toBe('# 工作区记忆\n')
    expect(memory.body.data.documents).toEqual([expect.objectContaining({ id: 'd1', title: '部署' })])

    const document = await api<{ content: string; title: string }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/memory/documents/d1`,
      { token },
    )
    expect(document.body.data).toMatchObject({ title: '部署', content: '# 部署步骤\n' })

    const missing = await api(platform.baseUrl, `/workspaces/${workspaceId}/memory/documents/nope`, { token })
    expect(missing.status).toBe(404)
  })

  it('别人的工作区记忆读不到', async () => {
    const memory = await api(platform.baseUrl, `/workspaces/${workspaceId}/memory`, { token: otherToken })
    expect(memory.status).toBe(404)
    const document = await api(platform.baseUrl, `/workspaces/${workspaceId}/memory/documents/d1`, { token: otherToken })
    expect(document.status).toBe(404)
  })

  it('个人记忆只返回自己的文件', async () => {
    await platform.deps.objects.put(`members/${adminId}/personal/偏好.md`, Buffer.from('# 偏好\n'), 'text/markdown')
    await platform.deps.objects.put(`members/${OTHER}/personal/secret.md`, Buffer.from('别人的'), 'text/markdown')

    const mine = await api<{ files: Array<{ name: string; content: string }> }>(platform.baseUrl, '/me/memory', { token })
    expect(mine.body.data.files).toEqual([
      expect.objectContaining({ name: '偏好.md', content: '# 偏好\n' }),
    ])

    const theirs = await api<{ files: Array<{ name: string }> }>(platform.baseUrl, '/me/memory', { token: otherToken })
    expect(theirs.body.data.files.map((file) => file.name)).toEqual(['secret.md'])
  })
})
