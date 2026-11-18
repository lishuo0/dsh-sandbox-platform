import { randomBytes } from 'node:crypto'
import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import type { Db, Querier } from '../../kernel/db.js'
import {
  WORKSPACE_GUEST_ROOT,
  workspaceGuest,
  workspaceHost,
  workspaceObjectKey,
  workspacePrefix,
  workspaceVolume,
} from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { asBool } from '../../kernel/row.js'
import { insertWorkspaceGroupRefs, resolveGroupSelection } from '../groups/service.js'

export interface Workspace {
  id: string
  name: string
  volumeName: string | null
  state: string
  /** 成员没指定工作区时，会话落到这块上。 */
  isDefault: boolean
}

/** 工作区选中的一条技能 / MCP，按名字和作用域引用。 */
export interface WorkspaceSelectionRef {
  name: string
  scope: 'private' | 'public'
}

export interface WorkspaceSelection {
  skills: WorkspaceSelectionRef[]
  mcpServers: WorkspaceSelectionRef[]
}

/** 列表和创建返回的工作区，带上明确配置过的选择。 */
export interface WorkspaceDetail extends Workspace {
  /** false = 没配置过，脑沿用「全部启用」。 */
  selectionConfigured: boolean
  skills: WorkspaceSelectionRef[]
  mcpServers: WorkspaceSelectionRef[]
}

export const DEFAULT_WORKSPACE_NAME = '默认工作区'

export async function listWorkspaces(db: Querier, userId: string): Promise<WorkspaceDetail[]> {
  const rows = await db.query(
    `SELECT id, name, volume_name, state, is_default, selection_configured
       FROM dsh_workspaces WHERE user_id = $1 ORDER BY is_default DESC, last_active_at DESC`,
    [userId],
  )
  const workspaces = rows.rows.flatMap((row) => {
    const workspace = mapWorkspace(row)
    return workspace
      ? [{
          ...workspace,
          selectionConfigured: asBool((row as { selection_configured?: unknown }).selection_configured),
          skills: [] as WorkspaceSelectionRef[],
          mcpServers: [] as WorkspaceSelectionRef[],
        }]
      : []
  })
  if (workspaces.length === 0) return []
  const selected = await selectionsOf(db, userId)
  return workspaces.map((workspace) => {
    const found = selected.get(workspace.id)
    return found === undefined ? workspace : { ...workspace, ...found }
  })
}

export async function createWorkspace(
  db: Db,
  objects: ObjectStore,
  userId: string,
  name: string,
  selection?: WorkspaceSelection,
  groupIds?: { skill: readonly string[]; mcp: readonly string[] },
): Promise<WorkspaceDetail> {
  const trimmed = name.trim()
  if (!trimmed) throw new HttpError(422, 'name-required')
  const groups =
    groupIds === undefined
      ? undefined
      : {
          skill: await resolveGroupSelection(db, { id: userId }, 'skill', groupIds.skill),
          mcp: await resolveGroupSelection(db, { id: userId }, 'mcp', groupIds.mcp),
        }
  const explicit = selection !== undefined || groups !== undefined
  const merged =
    selection === undefined && groups === undefined
      ? undefined
      : {
          skills: [...(selection?.skills ?? []), ...(groups?.skill.refs ?? [])],
          mcpServers: [...(selection?.mcpServers ?? []), ...(groups?.mcp.refs ?? [])],
        }
  const resolved = merged === undefined ? undefined : await requireSelection(db, userId, merged)
  return await db.transaction(async (tx) => {
    const workspace = await insertWorkspace(tx, objects, userId, trimmed, false, explicit)
    if (resolved !== undefined) await insertSelection(tx, workspace.id, resolved)
    if (groups !== undefined) {
      await insertWorkspaceGroupRefs(tx, 'skill', workspace.id, groups.skill.groupIds)
      await insertWorkspaceGroupRefs(tx, 'mcp', workspace.id, groups.mcp.groupIds)
    }
    return {
      ...workspace,
      selectionConfigured: explicit,
      skills: resolved?.skills ?? [],
      mcpServers: resolved?.mcpServers ?? [],
    }
  })
}

/** 单块工作区的详情，形状和列表项一致。 */
export async function getWorkspaceDetail(db: Querier, userId: string, id: string): Promise<WorkspaceDetail> {
  const rows = await db.query(
    `SELECT id, name, volume_name, state, is_default, selection_configured
       FROM dsh_workspaces WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  const row = rows.rows[0]
  const workspace = mapWorkspace(row)
  if (!workspace) throw new HttpError(404, 'not-found')
  const selected = (await selectionsOf(db, userId)).get(id)
  return {
    ...workspace,
    selectionConfigured: asBool((row as { selection_configured?: unknown }).selection_configured),
    skills: selected?.skills ?? [],
    mcpServers: selected?.mcpServers ?? [],
  }
}

/**
 * 解析请求里的 `skills` / `mcpServers`。
 *
 * 两个字段都没出现时返回 undefined（老客户端：沿用全部启用）；只要出现一个，
 * 这次创建就是「明确配置」，缺的那个按空列表处理。
 */
export function selectionFrom(input: { skills?: unknown; mcpServers?: unknown }): WorkspaceSelection | undefined {
  if (input.skills === undefined && input.mcpServers === undefined) return undefined
  return { skills: refsOf(input.skills), mcpServers: refsOf(input.mcpServers) }
}

async function requireSelection(db: Querier, userId: string, selection: WorkspaceSelection): Promise<WorkspaceSelection> {
  const skills = dedupe(selection.skills)
  const mcpServers = dedupe(selection.mcpServers)
  for (const ref of skills) await requireRef(db, userId, 'dsh_skills', 'name', ref)
  for (const ref of mcpServers) await requireRef(db, userId, 'dsh_mcp_servers', 'server_name', ref)
  return { skills, mcpServers }
}

/** 只允许引用自己看得见的 Skill / MCP：私有必须归自己，公开必须存在。 */
async function requireRef(
  db: Querier,
  userId: string,
  table: 'dsh_skills' | 'dsh_mcp_servers',
  nameColumn: 'name' | 'server_name',
  ref: WorkspaceSelectionRef,
): Promise<void> {
  const rows = await db.query(
    `SELECT 1 FROM ${table}
      WHERE ${nameColumn} = $1 AND scope = $2 AND ($2 = 'public' OR user_id = $3)`,
    [ref.name, ref.scope, userId],
  )
  if (rows.rows.length === 0) throw new HttpError(422, 'invalid-selection')
}

async function insertSelection(db: Querier, workspaceId: string, selection: WorkspaceSelection): Promise<void> {
  for (const ref of selection.skills) {
    await db.query(
      `INSERT INTO dsh_workspace_skills (workspace_id, skill_name, skill_scope) VALUES ($1, $2, $3)`,
      [workspaceId, ref.name, ref.scope],
    )
  }
  for (const ref of selection.mcpServers) {
    await db.query(
      `INSERT INTO dsh_workspace_mcp_servers (workspace_id, server_name, server_scope) VALUES ($1, $2, $3)`,
      [workspaceId, ref.name, ref.scope],
    )
  }
}

async function selectionsOf(
  db: Querier,
  userId: string,
): Promise<Map<string, { skills: WorkspaceSelectionRef[]; mcpServers: WorkspaceSelectionRef[] }>> {
  const selected = new Map<string, { skills: WorkspaceSelectionRef[]; mcpServers: WorkspaceSelectionRef[] }>()
  const entry = (workspaceId: string) => {
    const found = selected.get(workspaceId)
    if (found !== undefined) return found
    const created = { skills: [] as WorkspaceSelectionRef[], mcpServers: [] as WorkspaceSelectionRef[] }
    selected.set(workspaceId, created)
    return created
  }
  const skills = await db.query<{ workspace_id: string; skill_name: string; skill_scope: 'private' | 'public' }>(
    `SELECT s.workspace_id, s.skill_name, s.skill_scope
       FROM dsh_workspace_skills s JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE w.user_id = $1
      ORDER BY s.skill_name, s.skill_scope`,
    [userId],
  )
  for (const row of skills.rows) {
    entry(row.workspace_id).skills.push({ name: row.skill_name, scope: row.skill_scope })
  }
  const mcps = await db.query<{ workspace_id: string; server_name: string; server_scope: 'private' | 'public' }>(
    `SELECT m.workspace_id, m.server_name, m.server_scope
       FROM dsh_workspace_mcp_servers m JOIN dsh_workspaces w ON w.id = m.workspace_id
      WHERE w.user_id = $1
      ORDER BY m.server_name, m.server_scope`,
    [userId],
  )
  for (const row of mcps.rows) {
    entry(row.workspace_id).mcpServers.push({ name: row.server_name, scope: row.server_scope })
  }
  return selected
}

function refsOf(value: unknown): WorkspaceSelectionRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(422, 'invalid-selection')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) throw new HttpError(422, 'invalid-selection')
    const name = (item as { name?: unknown }).name
    const scope = (item as { scope?: unknown }).scope
    if (typeof name !== 'string' || name.trim() === '' || (scope !== 'private' && scope !== 'public')) {
      throw new HttpError(422, 'invalid-selection')
    }
    return { name: name.trim(), scope }
  })
}

function dedupe(refs: readonly WorkspaceSelectionRef[]): WorkspaceSelectionRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.scope}:${ref.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 成员的默认工作区：每个成员最多一块，名称固定为「默认工作区」。
 *
 * 客户端建的会话不带工作区；没有工作区，脑上的沙箱注册表就找不到这条会话属于
 * 哪台沙箱（`dsh_sessions.workspace_id` 为空时 `SessionDirectory.owner()` 返回空），
 * 第一轮读取技能就会失败。没有默认块时按普通工作区建一块（随机 id，不抢用户手建的工作区）。
 */
export async function ensureDefaultWorkspace(db: Querier, objects: ObjectStore, userId: string): Promise<Workspace> {
  const found = await defaultWorkspaceOf(db, userId)
  if (found !== undefined) return found
  try {
    return await insertWorkspace(db, objects, userId, DEFAULT_WORKSPACE_NAME, true)
  } catch (error) {
    // 并发下另一次调用抢先建了默认块：唯一索引挡住第二条插入，重查即可。
    if (!isUniqueViolation(error)) throw error
    const raced = await defaultWorkspaceOf(db, userId)
    if (raced !== undefined) return raced
    throw error
  }
}

/** 把成员的某块工作区设成默认；原来的默认块被清掉，成员始终最多一块默认。 */
export async function setDefaultWorkspace(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const owned = await tx.query(`SELECT id FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [id, userId])
    if (owned.rows.length === 0) throw new HttpError(404, 'not-found')
    await tx.query(`UPDATE dsh_workspaces SET is_default = false WHERE user_id = $1 AND is_default = true`, [userId])
    await tx.query(`UPDATE dsh_workspaces SET is_default = true WHERE id = $1 AND user_id = $2`, [id, userId])
  })
}

export async function updateWorkspace(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; archived?: boolean; default?: boolean },
): Promise<void> {
  const state = patch.archived === undefined ? null : patch.archived ? 'archived' : 'active'
  const result = await db.query(
    `UPDATE dsh_workspaces SET name = COALESCE($3, name), state = COALESCE($4, state) WHERE id = $1 AND user_id = $2`,
    [id, userId, patch.name?.trim() || null, state],
  )
  if (!result.rowCount) throw new HttpError(404, 'not-found')
  if (patch.default === true) await setDefaultWorkspace(db, userId, id)
}

/** 会话所属的工作区；记过就用记下的，没记过就落到成员的默认工作区。 */
export async function sessionWorkspace(
  db: Querier,
  objects: ObjectStore,
  userId: string,
  sessionId: string,
): Promise<Workspace> {
  const rows = await db.query(
    `SELECT w.id, w.name, w.volume_name, w.state, w.is_default
       FROM dsh_sessions s JOIN dsh_workspaces w ON w.id = s.workspace_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId],
  )
  const found = mapWorkspace(rows.rows[0])
  if (found !== undefined) return found
  const fallback = await ensureDefaultWorkspace(db, objects, userId)
  // 老数据可能还没挂工作区：这里直接补上，之后列表、沙箱路由都能看到归属。
  await db.query(
    `UPDATE dsh_sessions SET workspace_id = $2 WHERE id = $1 AND user_id = $3 AND workspace_id IS NULL`,
    [sessionId, fallback.id, userId],
  )
  return fallback
}

/** 客户端点名的成员工作区；不是这个成员的就当作没指定。 */
export async function ownedWorkspace(db: Querier, userId: string, id: string): Promise<Workspace | undefined> {
  const rows = await db.query(
    `SELECT id, name, volume_name, state, is_default
       FROM dsh_workspaces WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return mapWorkspace(rows.rows[0])
}

export async function ownWorkspace(db: Querier, userId: string, id: string): Promise<Workspace> {
  const workspace = await ownedWorkspace(db, userId, id)
  if (!workspace) throw new HttpError(404, 'not-found')
  return workspace
}

async function defaultWorkspaceOf(db: Querier, userId: string): Promise<Workspace | undefined> {
  const rows = await db.query(
    `SELECT id, name, volume_name, state, is_default
       FROM dsh_workspaces WHERE user_id = $1 AND is_default = true LIMIT 1`,
    [userId],
  )
  return mapWorkspace(rows.rows[0])
}

async function insertWorkspace(
  db: Querier,
  objects: ObjectStore,
  userId: string,
  name: string,
  isDefault: boolean,
  selectionConfigured = false,
): Promise<Workspace> {
  const id = `ws_${randomBytes(12).toString('hex')}`
  const guestRoot = workspaceGuest()
  const volumeName = workspaceVolume(id)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name, is_default, selection_configured)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, userId, name, workspaceHost(userId, id), guestRoot, volumeName, isDefault, selectionConfigured],
  )
  if (objects.enabled()) await objects.put(`${workspaceObjectKey(id, guestRoot)}/.keep`, Buffer.from(''))
  return { id, name, volumeName, state: 'active', isDefault }
}

/**
 * 删除一块工作区，并把它的会话转交给成员的默认工作区。
 *
 * 会话必须始终挂在某块工作区上：先清掉默认标记（否则删掉默认块后没有替补）、
 * 再确保有一块默认工作区、把会话移过去，最后才删工作区。
 */
export async function deleteWorkspace(
  db: Db,
  objects: ObjectStore,
  userId: string,
  id: string,
): Promise<void> {
  // 归属先判：不能让一个成员用别人的工作区 id 触发对象前缀清理。
  const owned = await db.query(`SELECT id FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [id, userId])
  if (owned.rows.length === 0) throw new HttpError(404, 'not-found')
  // 再清工作卷里的对象。删掉行之后就没法再枚举这块前缀了，留下的是谁也读不到、
  // 也不会再被回收的孤儿数据；先删数据、成功后才删行，失败时工作区仍然在。
  await purgePrefix(objects, workspacePrefix(id))
  await db.transaction(async (tx) => {
    const rows = await tx.query(`SELECT id, is_default FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [id, userId])
    const target = rows.rows[0] as { id: string; is_default: unknown } | undefined
    if (target === undefined) throw new HttpError(404, 'not-found')
    if (asBool(target.is_default)) {
      await tx.query(`UPDATE dsh_workspaces SET is_default = false WHERE id = $1 AND user_id = $2`, [id, userId])
    }
    const fallback = await ensureDefaultWorkspace(tx, objects, userId)
    if (fallback.id !== id) {
      await tx.query(
        `UPDATE dsh_sessions SET workspace_id = $2 WHERE workspace_id = $1 AND user_id = $3`,
        [id, fallback.id, userId],
      )
    }
    // SQLite 不保证开启外键级联，显式清掉选择行。
    await tx.query(`DELETE FROM dsh_workspace_skills WHERE workspace_id = $1`, [id])
    await tx.query(`DELETE FROM dsh_workspace_mcp_servers WHERE workspace_id = $1`, [id])
    await tx.query(`DELETE FROM dsh_workspaces WHERE id = $1 AND user_id = $2`, [id, userId])
  })
}

/**
 * 清空一个对象前缀下的所有对象。
 *
 * 对象存储按目录前缀分页（1000 条一页），删完一页后要再看一次，直到前缀下
 * 一个文件都不剩；`truncated` 只是本页被截断，不代表已经删完。
 */
export async function purgePrefix(objects: ObjectStore, prefix: string): Promise<void> {
  const page = await objects.list(prefix)
  for (const file of page.files) await objects.delete(file.key)
  for (const directory of page.directories) await purgePrefix(objects, directory)
  if (page.truncated) await purgePrefix(objects, prefix)
}

/**
 * 给所有还没挂工作区的老会话补上成员的默认工作区。
 *
 * 平台启动时跑一次，避免历史数据在列表、工作区投影里消失。
 */
export async function backfillSessionWorkspaces(db: Db, objects: ObjectStore): Promise<void> {
  const rows = await db.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM dsh_sessions WHERE workspace_id IS NULL`,
  )
  for (const row of rows.rows) {
    const workspace = await ensureDefaultWorkspace(db, objects, row.user_id)
    await db.query(
      `UPDATE dsh_sessions SET workspace_id = $2 WHERE user_id = $1 AND workspace_id IS NULL`,
      [row.user_id, workspace.id],
    )
  }
}

export async function listFiles(objects: ObjectStore, workspace: Workspace, requested: string) {
  const prefix = confine(workspace, requested || WORKSPACE_GUEST_ROOT)
  const page = await objects.list(prefix)
  const root = `${prefix}/`
  return {
    path: requested || WORKSPACE_GUEST_ROOT,
    truncated: page.truncated,
    entries: [
      ...page.directories.map((dir) => ({ name: leaf(dir, root), type: 'directory' as const })),
      ...page.files.map((file) => ({ name: leaf(file.key, root), type: 'file' as const, size: file.size })),
    ].filter((entry) => entry.name !== ''),
  }
}

export async function readFile(objects: ObjectStore, workspace: Workspace, requested: string) {
  if (!requested.trim()) throw new HttpError(422, 'path-required')
  const key = confine(workspace, requested)
  const body = await objects.get(key)
  if (!body) throw new HttpError(404, 'not-found')
  return { path: requested, bytes: body.length, content: body.toString('utf8') }
}

export async function writeFile(objects: ObjectStore, workspace: Workspace, requested: string, body: Buffer, contentType: string) {
  if (workspace.state === 'archived') throw new HttpError(409, 'workspace-archived')
  const key = confine(workspace, requested)
  await objects.put(key, body, contentType)
  return { path: requested, bytes: body.length }
}

function confine(workspace: Workspace, requested: string): string {
  try {
    return workspaceObjectKey(workspace.id, requested)
  } catch {
    throw new HttpError(422, 'path-outside-workspace')
  }
}

function leaf(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length).replace(/\/$/, '') : key
}

function mapWorkspace(row: unknown): Workspace | undefined {
  if (!row || typeof row !== 'object') return undefined
  const value = row as {
    id: string
    name: string
    volume_name: string | null
    state: string
    is_default?: unknown
  }
  return {
    id: value.id,
    name: value.name,
    volumeName: value.volume_name,
    state: value.state,
    isDefault: asBool(value.is_default),
  }
}
