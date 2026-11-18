import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  sessionWorkspace,
  setDefaultWorkspace,
} from '../../src/modules/workspaces/service.js'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

let platform: TestPlatform
let token: string
let workspaceId: string
let guestRoot: string

beforeAll(async () => {
  platform = await startTestPlatform()
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  const created = await api<{ id: string; volumeName: string }>(platform.baseUrl, '/workspaces', {
    method: 'POST',
    token,
    body: { name: '我的工作区' },
  })
  workspaceId = created.body.data.id
  guestRoot = '/desk'
})

afterAll(async () => {
  await platform.close()
})

describe('工作区', () => {
  it('创建返回沙箱路径与卷名，并在对象存储落下 .keep', async () => {
    expect(workspaceId).toMatch(/^ws_[0-9a-f]+$/)
    expect(guestRoot).toBe('/desk')
    const rooted = await api<{ id: string; volumeName: string; state: string; name: string }>(
      platform.baseUrl,
      '/workspaces',
      { token },
    )
    expect(rooted.body.data[0]).toMatchObject({
      id: workspaceId,
      name: '我的工作区',
      volumeName: `desk-${workspaceId}`,
      state: 'active',
    })
    expect(existsSync(join(platform.storageDir, 'desks', workspaceId, '.keep'))).toBe(true)
  })

  it('缺名字 422', async () => {
    const response = await api(platform.baseUrl, '/workspaces', { method: 'POST', token, body: { name: '  ' } })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('name-required')
  })

  it('写入、读取文本文件', async () => {
    const wrote = await api<{ path: string; bytes: number }>(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: `${guestRoot}/notes/today.md`, content: '# 今天\n完成测试' },
    })
    expect(wrote.status).toBe(201)
    expect(wrote.body.data.path).toBe(`${guestRoot}/notes/today.md`)

    const read = await api<{ content: string; bytes: number }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(`${guestRoot}/notes/today.md`)}`,
      { token },
    )
    expect(read.body.data.content).toBe('# 今天\n完成测试')
    expect(read.body.data.bytes).toBe(Buffer.byteLength('# 今天\n完成测试'))
  })

  it('列出文件与目录', async () => {
    const listing = await api<{ path: string; entries: Array<{ name: string; type: string }> }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(`${guestRoot}/notes`)}`,
      { token },
    )
    expect(listing.body.data.entries).toEqual(
      expect.arrayContaining([{ name: 'today.md', type: 'file', size: expect.any(Number) }]),
    )
  })

  it('二进制上传按名字落到目录', async () => {
    const uploaded = await api<{ path: string; bytes: number }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(`${guestRoot}/notes`)}&name=blob.bin`,
      { method: 'POST', token, raw: Buffer.from([0, 1, 2, 3]) },
    )
    expect(uploaded.status).toBe(201)
    expect(uploaded.body.data).toMatchObject({ bytes: 4 })

    const listing = await api<{ entries: Array<{ name: string; size: number }> }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(`${guestRoot}/notes`)}`,
      { token },
    )
    expect(listing.body.data.entries).toEqual(
      expect.arrayContaining([{ name: 'blob.bin', type: 'file', size: 4 }]),
    )
  })

  it('越出工作区的路径被拒绝', async () => {
    const response = await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: '/etc/passwd', content: 'x' },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('path-outside-workspace')

    const traversal = await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: `${guestRoot}/../../escape.txt`, content: 'x' },
    })
    expect(traversal.status).toBe(422)
  })

  it('上传名字不能带路径分隔符', async () => {
    const response = await api(platform.baseUrl, `/workspaces/${workspaceId}/files?name=a/b`, {
      method: 'POST',
      token,
      raw: Buffer.from('x'),
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('invalid-name')
  })

  it('改名、归档后禁止写入', async () => {
    expect(
      (await api(platform.baseUrl, `/workspaces/${workspaceId}`, { method: 'PATCH', token, body: { name: '改名了' } })).status,
    ).toBe(200)

    expect(
      (await api(platform.baseUrl, `/workspaces/${workspaceId}`, { method: 'PATCH', token, body: { archived: true } })).status,
    ).toBe(200)

    const write = await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, {
      method: 'PUT',
      token,
      body: { path: `${guestRoot}/late.txt`, content: 'x' },
    })
    expect(write.status).toBe(409)
    expect(write.body.msg).toBe('workspace-archived')

    await api(platform.baseUrl, `/workspaces/${workspaceId}`, { method: 'PATCH', token, body: { archived: false } })
  })

  it('别人的工作区 404', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'dave', password: 'dave-password-1234' },
    })
    const dave = await login(platform.baseUrl, 'dave', 'dave-password-1234')
    const response = await api(platform.baseUrl, `/workspaces/${workspaceId}/files`, { token: dave })
    expect(response.status).toBe(404)
  })
})

describe('默认工作区', () => {
  const admin = (): string => platform.config.auth.adminUsername

  it('没建过就自动建一块「默认工作区」，重复取不会多建', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'erin', password: 'erin-password-1234' },
    })
    const users = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, ['erin'])
    const erin = users.rows[0]?.id
    if (erin === undefined) throw new Error('没有找到 erin')

    const first = await ensureDefaultWorkspace(platform.db, platform.deps.objects, erin)
    expect(first.id).toMatch(/^ws_[0-9a-f]{24}$/)
    expect(first.name).toBe('默认工作区')
    expect(first.isDefault).toBe(true)
    expect(first.volumeName).toBe(`desk-${first.id}`)

    const again = await ensureDefaultWorkspace(platform.db, platform.deps.objects, erin)
    expect(again.id).toBe(first.id)
    const rows = await platform.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dsh_workspaces WHERE user_id = $1`,
      [erin],
    )
    expect(Number(rows.rows[0]?.n)).toBe(1)
  })

  it('默认工作区是单独一块，不抢成员手动建的工作区', async () => {
    const fixed = await ensureDefaultWorkspace(platform.db, platform.deps.objects, admin())
    // beforeAll 里手建的是随机 id 的工作区，默认工作区另建一块。
    expect(fixed.id).not.toBe(workspaceId)
    const manual = await platform.db.query<{ is_default: unknown }>(
      `SELECT is_default FROM dsh_workspaces WHERE id = $1`,
      [workspaceId],
    )
    expect(Number(manual.rows[0]?.is_default)).toBe(0)
  })

  it('可以把另一块设成默认，成员始终只有一块默认', async () => {
    const users = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, ['erin'])
    const erin = users.rows[0]?.id
    if (erin === undefined) throw new Error('没有找到 erin')
    const before = await ensureDefaultWorkspace(platform.db, platform.deps.objects, erin)
    const other = await createWorkspace(platform.db, platform.deps.objects, erin, '手建的工作区')

    await setDefaultWorkspace(platform.db, erin, other.id)
    const defaults = await platform.db.query<{ id: string }>(
      `SELECT id FROM dsh_workspaces WHERE user_id = $1 AND is_default = true`,
      [erin],
    )
    expect(defaults.rows.map((row) => row.id)).toEqual([other.id])
    expect((await ensureDefaultWorkspace(platform.db, platform.deps.objects, erin)).id).toBe(other.id)

    // 设回去，避免影响其它用例对 erin 默认块名的假设。
    await setDefaultWorkspace(platform.db, erin, before.id)
    const restored = await platform.db.query<{ id: string }>(
      `SELECT id FROM dsh_workspaces WHERE user_id = $1 AND is_default = true`,
      [erin],
    )
    expect(restored.rows.map((row) => row.id)).toEqual([before.id])
  })

  it('PATCH default 走接口切换默认工作区', async () => {
    const before = await ensureDefaultWorkspace(platform.db, platform.deps.objects, admin())
    const created = await api<{ id: string }>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '接口切换' },
    })
    const switched = await api(platform.baseUrl, `/workspaces/${created.body.data.id}`, {
      method: 'PATCH',
      token,
      body: { default: true },
    })
    expect(switched.status).toBe(200)
    const list = await api<Array<{ id: string; isDefault: boolean }>>(platform.baseUrl, '/workspaces', { token })
    expect(list.body.data.filter((workspace) => workspace.isDefault).map((workspace) => workspace.id)).toEqual([
      created.body.data.id,
    ])

    // 设回去，保持其它用例对默认块的假设。
    await setDefaultWorkspace(platform.db, admin(), before.id)
  })

  it('sessionWorkspace 优先用会话记录的工作区，没记过才落默认', async () => {
    const owned = 's_0123456789abcdef0123456789abcdef'
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client')`,
      [owned, admin(), workspaceId],
    )
    expect((await sessionWorkspace(platform.db, platform.deps.objects, admin(), owned)).id).toBe(workspaceId)

    const loose = 's_fedcba9876543210fedcba9876543210'
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ($1, $2, '', 'client')`,
      [loose, admin()],
    )
    const fallback = await sessionWorkspace(platform.db, platform.deps.objects, admin(), loose)
    expect(fallback.isDefault).toBe(true)
    expect(fallback.name).toBe('默认工作区')
    const bound = await platform.db.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1`,
      [loose],
    )
    expect(bound.rows[0]?.workspace_id).toBe(fallback.id)
  })

  it('删除工作区时把会话转到默认工作区，并清掉工作卷里的对象', async () => {
    const created = await createWorkspace(platform.db, platform.deps.objects, admin(), '待删除')
    const sessionId = 's_delete_moves_session'
    await platform.db.query(
      `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, '', 'client')`,
      [sessionId, admin(), created.id],
    )
    await platform.deps.objects.put(`desks/${created.id}/uploads/${sessionId}/a.txt`, Buffer.from('a'))
    await platform.deps.objects.put(`desks/${created.id}/.dsh/memory/nested/b.md`, Buffer.from('b'))

    await deleteWorkspace(platform.db, platform.deps.objects, admin(), created.id)
    const moved = await platform.db.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM dsh_sessions WHERE id = $1`,
      [sessionId],
    )
    const fallback = await ensureDefaultWorkspace(platform.db, platform.deps.objects, admin())
    expect(moved.rows[0]?.workspace_id).toBe(fallback.id)
    const existing = await platform.db.query(`SELECT id FROM dsh_workspaces WHERE id = $1`, [created.id])
    expect(existing.rows.length).toBe(0)
    const left = await platform.deps.objects.list(`desks/${created.id}`)
    expect(left.files).toEqual([])
    expect(await platform.deps.objects.get(`desks/${created.id}/uploads/${sessionId}/a.txt`)).toBeUndefined()
    expect(await platform.deps.objects.get(`desks/${created.id}/.dsh/memory/nested/b.md`)).toBeUndefined()
  })

  it('别人的工作区删不掉，对象也一个不动', async () => {
    const otherUser = 'u_other_workspace'
    await platform.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ($1, '别人', 'x')`, [otherUser])
    const created = await createWorkspace(platform.db, platform.deps.objects, otherUser, '别人的')
    await platform.deps.objects.put(`desks/${created.id}/secret.txt`, Buffer.from('secret'))

    await expect(deleteWorkspace(platform.db, platform.deps.objects, admin(), created.id))
      .rejects.toMatchObject({ status: 404 })
    expect((await platform.db.query(`SELECT id FROM dsh_workspaces WHERE id = $1`, [created.id])).rows.length).toBe(1)
    expect(await platform.deps.objects.get(`desks/${created.id}/secret.txt`)).toEqual(Buffer.from('secret'))
  })

  it('所有工作区共用 /desk，文件仍落在各自的对象前缀下', async () => {
    const other = await createWorkspace(platform.db, platform.deps.objects, admin(), '第二块')
    expect(other.id).not.toBe(workspaceId)
    expect(other.name).toBe('第二块')
    expect(existsSync(join(platform.storageDir, 'desks', other.id, '.keep'))).toBe(true)
    await api(platform.baseUrl, `/workspaces/${other.id}/files`, {
      method: 'PUT',
      token,
      body: { path: '/desk/same.txt', content: 'second' },
    })
    const first = await api<{ content: string }>(
      platform.baseUrl,
      `/workspaces/${workspaceId}/files/content?path=${encodeURIComponent('/desk/same.txt')}`,
      { token },
    )
    expect(first.status).toBe(404)
    const second = await api<{ content: string }>(
      platform.baseUrl,
      `/workspaces/${other.id}/files/content?path=${encodeURIComponent('/desk/same.txt')}`,
      { token },
    )
    expect(second.body.data.content).toBe('second')
  })
})

describe('工作区选择 Skills / MCP', () => {
  interface WorkspaceDetail {
    id: string
    selectionConfigured: boolean
    skills: Array<{ name: string; scope: string }>
    mcpServers: Array<{ name: string; scope: string }>
  }

  beforeAll(async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'ws-private-skill', description: '仅本工作区用', skillMd: '# 私有\n', scope: 'private' },
    })
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'ws-public-skill', description: '全员技能', skillMd: '# 公开\n', scope: 'public' },
    })
    await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'ws-private-mcp', url: 'https://mcp.example.com/private', scope: 'private' },
    })
    await api(platform.baseUrl, '/mcp-servers', {
      method: 'POST',
      token,
      body: { name: 'ws-public-mcp', url: 'https://mcp.example.com/public', scope: 'public' },
    })
  })

  it('创建时保存选中的 Skill / MCP，并在列表里带回来', async () => {
    const created = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: {
        name: '带选择的',
        skills: [
          { name: 'ws-private-skill', scope: 'private' },
          { name: 'ws-public-skill', scope: 'public' },
        ],
        mcpServers: [{ name: 'ws-public-mcp', scope: 'public' }],
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({
      selectionConfigured: true,
      skills: [
        { name: 'ws-private-skill', scope: 'private' },
        { name: 'ws-public-skill', scope: 'public' },
      ],
      mcpServers: [{ name: 'ws-public-mcp', scope: 'public' }],
    })

    const rows = await platform.db.query(
      `SELECT skill_name, skill_scope FROM dsh_workspace_skills WHERE workspace_id = $1 ORDER BY skill_name`,
      [created.body.data.id],
    )
    expect(rows.rows).toEqual([
      { skill_name: 'ws-private-skill', skill_scope: 'private' },
      { skill_name: 'ws-public-skill', skill_scope: 'public' },
    ])
    const servers = await platform.db.query(
      `SELECT server_name, server_scope FROM dsh_workspace_mcp_servers WHERE workspace_id = $1`,
      [created.body.data.id],
    )
    expect(servers.rows).toEqual([{ server_name: 'ws-public-mcp', server_scope: 'public' }])

    const list = await api<WorkspaceDetail[]>(platform.baseUrl, '/workspaces', { token })
    expect(list.body.data.find((workspace) => workspace.id === created.body.data.id)).toMatchObject({
      selectionConfigured: true,
      skills: expect.arrayContaining([{ name: 'ws-private-skill', scope: 'private' }]),
      mcpServers: [{ name: 'ws-public-mcp', scope: 'public' }],
    })
  })

  it('明确一个都不选：配置过但列表为空', async () => {
    const created = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '什么都不接', skills: [], mcpServers: [] },
    })
    expect(created.body.data).toMatchObject({ selectionConfigured: true, skills: [], mcpServers: [] })
  })

  it('不带选择字段的老客户端：没有配置过，脑沿用全部启用', async () => {
    const created = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '老客户端' },
    })
    expect(created.body.data).toMatchObject({ selectionConfigured: false, skills: [], mcpServers: [] })
  })

  it('引用了不存在的条目 422', async () => {
    const response = await api(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '坏选择', skills: [{ name: 'no-such-skill', scope: 'private' }], mcpServers: [] },
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('invalid-selection')
    const rows = await platform.db.query(`SELECT id FROM dsh_workspaces WHERE name = '坏选择'`)
    expect(rows.rows.length).toBe(0)
  })

  it('引用别人的私有 Skill 被拒绝，公开的可以', async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'frank', password: 'frank-password-1234' },
    })
    const frank = await login(platform.baseUrl, 'frank', 'frank-password-1234')
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token: frank,
      body: { name: 'frank-skill', description: 'frank 的', skillMd: '# frank\n', scope: 'private' },
    })

    const denied = await api(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '借别人的', skills: [{ name: 'frank-skill', scope: 'private' }], mcpServers: [] },
    })
    expect(denied.status).toBe(422)
    expect(denied.body.msg).toBe('invalid-selection')

    const allowed = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: { name: '用公开的', skills: [{ name: 'ws-public-skill', scope: 'public' }], mcpServers: [] },
    })
    expect(allowed.status).toBe(201)
    expect(allowed.body.data.skills).toEqual([{ name: 'ws-public-skill', scope: 'public' }])
  })

  it('删除工作区时清掉选择行', async () => {
    const created = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: {
        name: '删掉带选择的',
        skills: [{ name: 'ws-private-skill', scope: 'private' }],
        mcpServers: [{ name: 'ws-private-mcp', scope: 'private' }],
      },
    })
    const workspace = created.body.data.id
    await deleteWorkspace(platform.db, platform.deps.objects, platform.config.auth.adminUsername, workspace)
    const skills = await platform.db.query(`SELECT 1 FROM dsh_workspace_skills WHERE workspace_id = $1`, [workspace])
    const servers = await platform.db.query(`SELECT 1 FROM dsh_workspace_mcp_servers WHERE workspace_id = $1`, [workspace])
    expect(skills.rows.length).toBe(0)
    expect(servers.rows.length).toBe(0)
  })

  it('删掉 Skill / MCP 时一并清掉引用它的选择行', async () => {
    const created = await api<WorkspaceDetail>(platform.baseUrl, '/workspaces', {
      method: 'POST',
      token,
      body: {
        name: '删除来源',
        skills: [{ name: 'ws-public-skill', scope: 'public' }],
        mcpServers: [{ name: 'ws-public-mcp', scope: 'public' }],
      },
    })
    expect(created.status).toBe(201)

    await api(platform.baseUrl, '/skills/ws-public-skill?scope=public', { method: 'DELETE', token })
    await api(platform.baseUrl, '/mcp-servers/ws-public-mcp?scope=public', { method: 'DELETE', token })

    const skills = await platform.db.query(
      `SELECT 1 FROM dsh_workspace_skills WHERE workspace_id = $1 AND skill_name = 'ws-public-skill'`,
      [created.body.data.id],
    )
    const servers = await platform.db.query(
      `SELECT 1 FROM dsh_workspace_mcp_servers WHERE workspace_id = $1 AND server_name = 'ws-public-mcp'`,
      [created.body.data.id],
    )
    expect(skills.rows.length).toBe(0)
    expect(servers.rows.length).toBe(0)
  })
})
