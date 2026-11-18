import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { migrate } from '../../src/kernel/db.js'
import { createObjectStore, type ObjectStore } from '../../src/kernel/objects.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  listWorkspaceGroups,
  setWorkspaceGroups,
  updateGroup,
} from '../../src/modules/groups/service.js'
import { saveMcp } from '../../src/modules/mcp/service.js'
import { saveSkill } from '../../src/modules/skills/service.js'
import { createWorkspace } from '../../src/modules/workspaces/service.js'

/**
 * 分组是平台自己的组织方式：分组成员用的是 `group_id`，工作区选分组时
 * 展开进脑已经认识的选择表。测试都落在本地对象目录，不碰宿主机工作区。
 */

let dir: string
let db: SqliteDb
let objects: ObjectStore

const ME = { id: 'u1', role: 'member' }
const OTHER = { id: 'u2', role: 'member' }
/** 公开分组是全局命名空间，只有管理员能建。 */
const ADMIN = { id: 'u3', role: 'admin' }

function localConfig(storageDir: string): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir: storageDir },
  } as unknown as AppConfig
}

async function seedWorkspace(id: string, userId: string, name = id): Promise<void> {
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, is_default)
     VALUES ($1, $2, $3, $4, '/desk', false)`,
    [id, userId, name, `/tmp/${id}`],
  )
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-groups-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  objects = createObjectStore(localConfig(join(dir, 'objects')))
  await db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES
       ('u1', '一', 'x'), ('u2', '二', 'x'), ('u3', '三', 'x')`,
  )
  await seedWorkspace('w1', 'u1')
  await seedWorkspace('w2', 'u2')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('分组 CRUD', () => {
  it('创建分组默认私有，名字必填', async () => {
    const group = await createGroup(db, ME, 'skill', { name: '前端' })
    expect(group).toMatchObject({
      owner_user_id: 'u1',
      owner_display_name: '一',
      name: '前端',
      visibility: 'private',
      skill_count: 0,
    })
    expect(group.id).toMatch(/^grp_[0-9a-f]{24}$/)

    await expect(createGroup(db, ME, 'skill', { name: '   ' })).rejects.toMatchObject({ code: 'invalid-group-name' })
    await expect(createGroup(db, ME, 'skill', {})).rejects.toMatchObject({ code: 'invalid-group-name' })
    await expect(createGroup(db, ME, 'skill', { name: 'x', visibility: 'shared' })).rejects.toMatchObject({
      code: 'invalid-visibility',
    })
  })

  it('公开分组只允许管理员创建和发布', async () => {
    await expect(createGroup(db, ME, 'skill', { name: '想公开', visibility: 'public' })).rejects.toMatchObject({
      status: 403,
      code: 'admin-only',
    })

    const own = await createGroup(db, ME, 'skill', { name: '私有' })
    await expect(updateGroup(db, ME, 'skill', own.id, { visibility: 'public' })).rejects.toMatchObject({
      status: 403,
      code: 'admin-only',
    })
    expect((await updateGroup(db, ME, 'skill', own.id, { name: '还是私有' })).visibility).toBe('private')

    const open = await createGroup(db, ADMIN, 'skill', { name: '公开', visibility: 'public' })
    expect((await updateGroup(db, ADMIN, 'skill', open.id, { description: '管理员改' })).visibility).toBe('public')
  })

  it('列表默认只看自己的，available=1 才带别人公开的分组', async () => {
    const mine = await createGroup(db, ME, 'skill', { name: '我的' })
    const publicGroup = await createGroup(db, ADMIN, 'skill', { name: '公开', visibility: 'public' })
    await createGroup(db, OTHER, 'skill', { name: '别人的私有' })

    const own = await listGroups(db, 'u1', 'skill', false)
    expect(own.map((group) => group.id)).toEqual([mine.id])

    const available = await listGroups(db, 'u1', 'skill', true)
    expect(available.map((group) => group.id).sort()).toEqual([mine.id, publicGroup.id].sort())
  })

  it('别人私有的分组查不到，公开的能查', async () => {
    const hidden = await createGroup(db, OTHER, 'skill', { name: '隐藏' })
    const open = await createGroup(db, ADMIN, 'skill', { name: '开放', visibility: 'public' })
    await expect(getGroup(db, ME, 'skill', hidden.id)).rejects.toMatchObject({ status: 404 })
    expect((await getGroup(db, ME, 'skill', open.id)).visibility).toBe('public')
    expect((await listGroups(db, 'u1', 'skill', true)).map((group) => group.id)).toEqual([open.id])
  })

  it('只有创建者能改；空描述沿用原值', async () => {
    const group = await createGroup(db, ADMIN, 'skill', { name: '原名', description: '原描述', visibility: 'public' })
    await expect(updateGroup(db, ME, 'skill', group.id, { name: '偷改' })).rejects.toMatchObject({ status: 404 })

    const renamed = await updateGroup(db, ADMIN, 'skill', group.id, { name: '新名', description: '  ' })
    expect(renamed).toMatchObject({ name: '新名', description: '原描述', visibility: 'public' })
  })

  it('别人的工作区还引用着时，不能把公开分组收成私有', async () => {
    const group = await createGroup(db, ADMIN, 'skill', { name: '共享', visibility: 'public' })
    await setWorkspaceGroups(db, ME, 'skill', 'w1', [group.id])

    await expect(
      updateGroup(db, ADMIN, 'skill', group.id, { visibility: 'private' }),
    ).rejects.toMatchObject({ code: 'group-in-use' })

    await setWorkspaceGroups(db, ME, 'skill', 'w1', [])
    const closed = await updateGroup(db, ADMIN, 'skill', group.id, { visibility: 'private' })
    expect(closed.visibility).toBe('private')
  })

  it('删分组只解除成员归属，不删技能；工作区还在引用时拒绝', async () => {
    const group = await createGroup(db, ME, 'skill', { name: '待删' })
    await saveSkill(db, objects, ME, {
      name: 'alpha',
      description: '技能',
      skillMd: '# alpha',
      scope: 'private',
      groupId: group.id,
    })
    const before = await db.query(`SELECT group_id FROM dsh_skills WHERE name = 'alpha'`)
    expect((before.rows[0] as { group_id: string }).group_id).toBe(group.id)

    await setWorkspaceGroups(db, ME, 'skill', 'w1', [group.id])
    await expect(deleteGroup(db, ME, 'skill', group.id)).rejects.toMatchObject({ code: 'group-in-use' })

    await setWorkspaceGroups(db, ME, 'skill', 'w1', [])
    await deleteGroup(db, ME, 'skill', group.id)
    const after = await db.query(`SELECT group_id FROM dsh_skills WHERE name = 'alpha'`)
    expect((after.rows[0] as { group_id: string | null }).group_id).toBeNull()
    await expect(getGroup(db, ME, 'skill', group.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('工作区选分组', () => {
  it('技能分组展开成工作区直接选择，并标记已配置', async () => {
    const group = await createGroup(db, ME, 'skill', { name: '前端' })
    await saveSkill(db, objects, ME, {
      name: 'alpha',
      description: '技能',
      skillMd: '# alpha',
      scope: 'private',
      groupId: group.id,
    })
    await saveSkill(db, objects, ME, {
      name: 'beta',
      description: '技能',
      skillMd: '# beta',
      scope: 'private',
    })

    const selected = await setWorkspaceGroups(db, ME, 'skill', 'w1', [group.id])
    expect(selected.map((item) => item.id)).toEqual([group.id])

    const rows = await db.query<{ skill_name: string }>(
      `SELECT skill_name FROM dsh_workspace_skills WHERE workspace_id = 'w1'`,
    )
    expect(rows.rows).toEqual([{ skill_name: 'alpha' }])
    const workspace = await db.query(`SELECT selection_configured FROM dsh_workspaces WHERE id = 'w1'`)
    expect(Number((workspace.rows[0] as { selection_configured: unknown }).selection_configured)).toBe(1)
    expect((await listWorkspaceGroups(db, 'skill', 'w1')).map((item) => item.id)).toEqual([group.id])
  })

  it('重新选分组会覆盖上一次的直接选择', async () => {
    const first = await createGroup(db, ME, 'skill', { name: '一' })
    const second = await createGroup(db, ME, 'skill', { name: '二' })
    await saveSkill(db, objects, ME, {
      name: 'alpha',
      description: '技能',
      skillMd: '# alpha',
      scope: 'private',
      groupId: first.id,
    })
    await saveSkill(db, objects, ME, {
      name: 'beta',
      description: '技能',
      skillMd: '# beta',
      scope: 'private',
      groupId: second.id,
    })

    await db.query(
      `INSERT INTO dsh_workspace_skills (workspace_id, skill_name, skill_scope) VALUES ('w1', '手动选的', 'private')`,
    )
    await setWorkspaceGroups(db, ME, 'skill', 'w1', [first.id])
    await setWorkspaceGroups(db, ME, 'skill', 'w1', [second.id])

    const rows = await db.query<{ skill_name: string }>(
      `SELECT skill_name FROM dsh_workspace_skills WHERE workspace_id = 'w1' ORDER BY skill_name`,
    )
    expect(rows.rows.map((row) => row.skill_name)).toEqual(['beta'])
  })

  it('MCP 分组用 server_count 并展开到 MCP 选择表', async () => {
    const group = await createGroup(db, ME, 'mcp', { name: '搜索' })
    await saveMcp(db, Buffer.alloc(32, 1), ME, {
      name: 'search',
      url: 'https://mcp.example.com/sse',
      scope: 'private',
      groupId: group.id,
    })
    const view = await getGroup(db, ME, 'mcp', group.id)
    expect(view.server_count).toBe(1)

    await setWorkspaceGroups(db, ME, 'mcp', 'w1', [group.id])
    const rows = await db.query<{ server_name: string }>(
      `SELECT server_name FROM dsh_workspace_mcp_servers WHERE workspace_id = 'w1'`,
    )
    expect(rows.rows).toEqual([{ server_name: 'search' }])
  })

  it('选别人私有的分组会被当成不存在', async () => {
    const hidden = await createGroup(db, OTHER, 'skill', { name: '隐藏' })
    await expect(setWorkspaceGroups(db, ME, 'skill', 'w1', [hidden.id])).rejects.toMatchObject({ status: 404 })
  })
})

describe('成员挂分组', () => {
  it('技能可以挂自己的分组，公开技能只能挂公开分组', async () => {
    const priv = await createGroup(db, ME, 'skill', { name: '私有组' })
    const open = await createGroup(db, ADMIN, 'skill', { name: '公开组', visibility: 'public' })

    await saveSkill(db, objects, ME, {
      name: 'alpha',
      description: '技能',
      skillMd: '# alpha',
      scope: 'private',
      groupId: priv.id,
    })
    const saved = await db.query(`SELECT group_id FROM dsh_skills WHERE name = 'alpha' AND scope = 'private'`)
    expect((saved.rows[0] as { group_id: string }).group_id).toBe(priv.id)

    await expect(
      saveSkill(db, objects, { id: 'u1', role: 'admin' }, {
        name: 'open-skill',
        description: '技能',
        skillMd: '# open',
        scope: 'public',
        groupId: priv.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid-group' })

    await saveSkill(db, objects, { id: 'u1', role: 'admin' }, {
      name: 'open-skill',
      description: '技能',
      skillMd: '# open',
      scope: 'public',
      groupId: open.id,
    })
    const publicRow = await db.query(`SELECT group_id FROM dsh_skills WHERE name = 'open-skill' AND scope = 'public'`)
    expect((publicRow.rows[0] as { group_id: string }).group_id).toBe(open.id)
  })

  it('挂别人的私有分组当成不存在', async () => {
    const hidden = await createGroup(db, OTHER, 'skill', { name: '隐藏' })
    await expect(
      saveSkill(db, objects, ME, {
        name: 'alpha',
        description: '技能',
        skillMd: '# alpha',
        scope: 'private',
        groupId: hidden.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('创建工作区时带分组', () => {
  it('分组展开进选择表并记下引用', async () => {
    const group = await createGroup(db, ME, 'skill', { name: '前端' })
    await saveSkill(db, objects, ME, {
      name: 'alpha',
      description: '技能',
      skillMd: '# alpha',
      scope: 'private',
      groupId: group.id,
    })

    const workspace = await createWorkspace(db, objects, 'u1', '按组创建', undefined, {
      skill: [group.id],
      mcp: [],
    })
    expect(workspace.selectionConfigured).toBe(true)
    expect(workspace.skills).toEqual([{ name: 'alpha', scope: 'private' }])

    const refs = await db.query<{ group_id: string }>(
      `SELECT group_id FROM dsh_workspace_skill_groups WHERE workspace_id = $1`,
      [workspace.id],
    )
    expect(refs.rows).toEqual([{ group_id: group.id }])
  })
})
