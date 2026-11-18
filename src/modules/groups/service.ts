import { randomBytes } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Db, Querier } from '../../kernel/db.js'
import { asNumber } from '../../kernel/row.js'

/**
 * 技能 / MCP 分组。
 *
 * 分组是平台自己的组织方式：成员（技能或 MCP）用 group_id 归属到分组，
 * 工作区选分组时把成员展开进 `dsh_workspace_skills` / `dsh_workspace_mcp_servers`，
 * 脑仍然只读那两张选择表，不需要认识分组。
 */

export type GroupKind = 'skill' | 'mcp'
export type GroupVisibility = 'private' | 'public'

interface KindTables {
  groups: string
  refs: string
  members: string
  /** 成员表里的名字列。 */
  memberName: string
  /** 视图里的成员计数字段，和参考实现的命名一致。 */
  countKey: string
  selection: string
  selectionName: string
  selectionScope: string
}

const TABLES: Record<GroupKind, KindTables> = {
  skill: {
    groups: 'dsh_skill_groups',
    refs: 'dsh_workspace_skill_groups',
    members: 'dsh_skills',
    memberName: 'name',
    countKey: 'skill_count',
    selection: 'dsh_workspace_skills',
    selectionName: 'skill_name',
    selectionScope: 'skill_scope',
  },
  mcp: {
    groups: 'dsh_mcp_groups',
    refs: 'dsh_workspace_mcp_groups',
    members: 'dsh_mcp_servers',
    memberName: 'server_name',
    countKey: 'server_count',
    selection: 'dsh_workspace_mcp_servers',
    selectionName: 'server_name',
    selectionScope: 'server_scope',
  },
}

interface GroupRow {
  id: string
  user_id: string
  display_name: string
  name: string
  description: string
  visibility: GroupVisibility
  member_count: unknown
  created_at: string
  updated_at: string
}

export interface GroupInput {
  name?: unknown
  description?: unknown
  visibility?: unknown
}

interface Actor {
  id: string
  role?: string
}

const COLUMNS = `g.id, g.user_id, u.display_name, g.name, g.description, g.visibility,
                 g.created_at, g.updated_at`

/** 列表默认只看自己的分组；`available=1` 时附带别人公开的分组。 */
export async function listGroups(db: Querier, viewerId: string, kind: GroupKind, includePublic: boolean) {
  const tables = TABLES[kind]
  const rows = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM ${tables.members} m WHERE m.group_id = g.id) AS member_count
       FROM ${tables.groups} g JOIN dsh_users u ON u.id = g.user_id
      WHERE g.user_id = $1${includePublic ? " OR g.visibility = 'public'" : ''}
      ORDER BY g.visibility, g.name, g.id`,
    [viewerId],
  )
  return rows.rows.map((row) => viewOf(kind, row as unknown as GroupRow))
}

export async function getGroup(db: Querier, user: Actor, kind: GroupKind, id: string) {
  return viewOf(kind, await requireVisible(db, user, kind, id))
}

export async function createGroup(db: Querier, user: Actor, kind: GroupKind, input: GroupInput) {
  const name = nameOf(input.name)
  const visibility = visibilityOf(input.visibility) ?? 'private'
  // 公开分组会出现在所有成员的列表里，属于全局命名空间；和技能 / MCP 的 public
  // 作用域一样只允许管理员创建。
  if (visibility === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const tables = TABLES[kind]
  const id = `grp_${randomBytes(12).toString('hex')}`
  await db.query(
    `INSERT INTO ${tables.groups} (id, user_id, name, description, visibility)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, user.id, name, description, visibility],
  )
  return await getGroup(db, user, kind, id)
}

export async function updateGroup(db: Querier, user: Actor, kind: GroupKind, id: string, input: GroupInput) {
  const current = await requireOwned(db, user, kind, id)
  const name = input.name === undefined ? current.name : nameOf(input.name)
  const visibility = input.visibility === undefined ? current.visibility : visibilityOf(input.visibility)
  if (visibility === undefined) throw new HttpError(422, 'invalid-visibility')
  if (visibility === 'public' && current.visibility !== 'public' && user.role !== 'admin') {
    throw new HttpError(403, 'admin-only')
  }
  // 空描述沿用原值，和参考实现的 PATCH 语义一致。
  const description =
    typeof input.description === 'string' && input.description.trim() !== ''
      ? input.description.trim()
      : current.description
  if (current.visibility === 'public' && visibility === 'private') {
    // 别人的工作区还在引用时不能收回可见性，否则他们的选择会悄悄失效。
    if ((await otherWorkspaceRefs(db, kind, id, user.id)) > 0) throw new HttpError(422, 'group-in-use')
  }
  await db.query(
    `UPDATE ${TABLES[kind].groups}
        SET name = $3, description = $4, visibility = $5, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, user.id, name, description, visibility],
  )
  return await getGroup(db, user, kind, id)
}

export async function deleteGroup(db: Db, user: Actor, kind: GroupKind, id: string): Promise<void> {
  await requireOwned(db, user, kind, id)
  if ((await otherWorkspaceRefs(db, kind, id, user.id, true)) > 0) throw new HttpError(422, 'group-in-use')
  const tables = TABLES[kind]
  await db.transaction(async (tx) => {
    // 成员本身在成员自己的空间里，删分组只解除归属，不删技能 / server。
    await tx.query(`UPDATE ${tables.members} SET group_id = NULL WHERE group_id = $1`, [id])
    await tx.query(`DELETE FROM ${tables.refs} WHERE group_id = $1`, [id])
    await tx.query(`DELETE FROM ${tables.groups} WHERE id = $1 AND user_id = $2`, [id, user.id])
  })
}

/** 工作区选中的分组。 */
export async function listWorkspaceGroups(
  db: Querier,
  kind: GroupKind,
  workspaceId: string,
) {
  const tables = TABLES[kind]
  const rows = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM ${tables.members} m WHERE m.group_id = g.id) AS member_count
       FROM ${tables.refs} r
       JOIN ${tables.groups} g ON g.id = r.group_id
       JOIN dsh_users u ON u.id = g.user_id
      WHERE r.workspace_id = $1
      ORDER BY g.name, g.id`,
    [workspaceId],
  )
  return rows.rows.map((row) => viewOf(kind, row as unknown as GroupRow))
}

/**
 * 替换工作区选中的分组，同时把成员展开成工作区的直接选择。
 *
 * 分组是「选择」的唯一来源：设置分组会覆盖之前逐条选的技能 / MCP，
 * 和参考实现的 PUT 语义一致。
 */
export async function setWorkspaceGroups(
  db: Db,
  user: Actor,
  kind: GroupKind,
  workspaceId: string,
  groupIds: readonly string[],
) {
  const tables = TABLES[kind]
  const unique = [...new Set(groupIds.map((id) => id.trim()).filter((id) => id !== ''))]
  for (const id of unique) await requireVisible(db, user, kind, id)
  const configured = db.dialect === 'sqlite' ? 1 : true
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM ${tables.refs} WHERE workspace_id = $1`, [workspaceId])
    for (const id of unique) {
      await tx.query(`INSERT INTO ${tables.refs} (workspace_id, group_id) VALUES ($1, $2)`, [workspaceId, id])
    }
    await tx.query(`DELETE FROM ${tables.selection} WHERE workspace_id = $1`, [workspaceId])
    await tx.query(
      `INSERT INTO ${tables.selection} (workspace_id, ${tables.selectionName}, ${tables.selectionScope})
       SELECT DISTINCT $1, m.${tables.memberName}, m.scope
         FROM ${tables.members} m
         JOIN ${tables.refs} r ON r.group_id = m.group_id
        WHERE r.workspace_id = $1`,
      [workspaceId],
    )
    // 工作区归属已在上层判定过；这里再带一次 user_id，任何新增调用点都绕不过去。
    await tx.query(
      `UPDATE dsh_workspaces SET selection_configured = $2 WHERE id = $1 AND user_id = $3`,
      [workspaceId, configured, user.id],
    )
  })
  return await listWorkspaceGroups(db, kind, workspaceId)
}

/** 创建/更新成员时校验分组归属：只能挂自己看得见的分组。 */
export async function requireGroupForMember(
  db: Querier,
  user: Actor,
  kind: GroupKind,
  groupId: string,
): Promise<{ id: string; visibility: GroupVisibility }> {
  const row = await requireVisible(db, user, kind, groupId)
  return { id: row.id, visibility: row.visibility }
}

/** 工作区请求里带的分组 id，展开成直接选择；两个字段都没出现时返回 undefined。 */
export async function resolveGroupSelection(
  db: Querier,
  user: Actor,
  kind: GroupKind,
  groupIds: readonly string[],
) {
  const unique = [...new Set(groupIds.map((id) => id.trim()).filter((id) => id !== ''))]
  for (const id of unique) await requireVisible(db, user, kind, id)
  if (unique.length === 0) return { groupIds: unique, refs: [] as { name: string; scope: GroupVisibility }[] }
  const tables = TABLES[kind]
  const placeholders = unique.map((_, index) => `$${index + 1}`).join(', ')
  const rows = await db.query<{ name: string; scope: GroupVisibility }>(
    `SELECT DISTINCT m.${tables.memberName} AS name, m.scope
       FROM ${tables.members} m
      WHERE m.group_id IN (${placeholders})
      ORDER BY m.${tables.memberName}, m.scope`,
    unique,
  )
  return { groupIds: unique, refs: rows.rows }
}

export async function insertWorkspaceGroupRefs(
  db: Querier,
  kind: GroupKind,
  workspaceId: string,
  groupIds: readonly string[],
): Promise<void> {
  for (const id of groupIds) {
    await db.query(`INSERT INTO ${TABLES[kind].refs} (workspace_id, group_id) VALUES ($1, $2)`, [workspaceId, id])
  }
}

async function requireVisible(db: Querier, user: Actor, kind: GroupKind, id: string): Promise<GroupRow> {
  const tables = TABLES[kind]
  const rows = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM ${tables.members} m WHERE m.group_id = g.id) AS member_count
       FROM ${tables.groups} g JOIN dsh_users u ON u.id = g.user_id
      WHERE g.id = $1`,
    [id],
  )
  const row = rows.rows[0] as unknown as GroupRow | undefined
  if (row === undefined) throw new HttpError(404, 'not-found')
  if (row.user_id !== user.id && row.visibility !== 'public') throw new HttpError(404, 'not-found')
  return row
}

async function requireOwned(db: Querier, user: Actor, kind: GroupKind, id: string): Promise<GroupRow> {
  const row = await requireVisible(db, user, kind, id)
  if (row.user_id !== user.id) throw new HttpError(404, 'not-found')
  return row
}

/** 引用了这个分组的工作区数；`anyUser=false` 时只数别人的。 */
async function otherWorkspaceRefs(
  db: Querier,
  kind: GroupKind,
  id: string,
  userId: string,
  anyUser = false,
): Promise<number> {
  const rows = await db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n
       FROM ${TABLES[kind].refs} r JOIN dsh_workspaces w ON w.id = r.workspace_id
      WHERE r.group_id = $1${anyUser ? '' : ' AND w.user_id <> $2'}`,
    anyUser ? [id] : [id, userId],
  )
  return asNumber(rows.rows[0]?.n)
}

function viewOf(kind: GroupKind, row: GroupRow) {
  return {
    id: row.id,
    owner_user_id: row.user_id,
    owner_display_name: row.display_name,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    [TABLES[kind].countKey]: asNumber(row.member_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function nameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || [...name].length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(422, 'invalid-group-name')
  }
  return name
}

function visibilityOf(value: unknown): GroupVisibility | undefined {
  if (value === undefined) return undefined
  if (value !== 'private' && value !== 'public') throw new HttpError(422, 'invalid-visibility')
  return value
}
