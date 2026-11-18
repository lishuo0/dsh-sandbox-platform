import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { isSkillFilePath, isSlug, skillDir, skillObjectKey } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { asBool, asNumber } from '../../kernel/row.js'
import { requireGroupForMember } from '../groups/service.js'

export type SkillScope = 'private' | 'public'

export interface SkillFile {
  path: string
  bytes: number
}

interface SkillRow {
  user_id: string
  display_name: string
  name: string
  description: string
  scope: SkillScope
  group_id: string | null
  enabled: unknown
  revision: unknown
  bytes: unknown
  file_count: unknown
  updated_at: string
}

interface Actor {
  id: string
  role: string
}

export async function listSkills(db: Querier, userId: string) {
  const rows = await db.query(
    `SELECT s.user_id, u.display_name, s.name, s.description, s.scope, s.group_id, s.enabled,
            s.revision, s.bytes, s.file_count, s.updated_at
       FROM dsh_skills s JOIN dsh_users u ON u.id = s.user_id
      WHERE s.user_id = $1 OR s.scope = 'public'
      ORDER BY s.scope, s.name`,
    [userId],
  )
  return rows.rows.map((row) => summaryOf(row as unknown as SkillRow, userId))
}

export async function getSkill(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
) {
  const row = await requireSkill(db, user, name, scope)
  return { ...summaryOf(row, user.id), files: await listSkillObjects(objects, skillDir(scope, row.user_id, name)) }
}

export async function saveSkill(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  input: { name: string; description: string; skillMd: string; scope: SkillScope; groupId?: string | null },
): Promise<void> {
  requireContent(input.description, input.skillMd)
  if (!isSlug(input.name)) throw new HttpError(422, 'invalid-skill-name')
  if (input.scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  if (input.scope === 'private') await assertNameFree(db, user.id, input.name)
  const groupId = await groupOf(db, user, input.scope, input.groupId)
  // 公开技能只有一个存放位置：已有行时沿用它的 owner。换 owner 会让已经写下的
  // 文件留在旧前缀里、新读路径全部 404，也等于把别人的内容搬到了自己名下。
  const owner = input.scope === 'public' ? await publicOwner(db, input.name) ?? user.id : user.id
  await objects.put(
    skillObjectKey(input.scope, owner, input.name, 'SKILL.md'),
    Buffer.from(input.skillMd),
    'text/markdown',
  )
  if (input.scope === 'public') {
    const updated = await db.query(
      `UPDATE dsh_skills
          SET description = $2, group_id = $3, revision = revision + 1, updated_at = now()
        WHERE scope = 'public' AND name = $1`,
      [input.name, input.description, groupId],
    )
    if (!updated.rowCount) {
      try {
        await db.query(
          `INSERT INTO dsh_skills (user_id, name, description, scope, group_id) VALUES ($1, $2, $3, 'public', $4)`,
          [owner, input.name, input.description, groupId],
        )
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        throw new HttpError(409, 'name-taken')
      }
    }
    await refreshStats(db, objects, { user_id: owner, name: input.name, scope: 'public' })
    return
  }
  const saved = await db.query(
    `INSERT INTO dsh_skills (user_id, name, description, scope, group_id)
     VALUES ($1, $2, $3, 'private', $4)
     ON CONFLICT (user_id, name) DO UPDATE
       SET description = $3, revision = dsh_skills.revision + 1, group_id = $4, updated_at = now()
     WHERE dsh_skills.scope = 'private'`,
    [user.id, input.name, input.description, groupId],
  )
  if (!saved.rowCount) throw new HttpError(409, 'name-taken')
  await refreshStats(db, objects, { user_id: user.id, name: input.name, scope: 'private' })
}

export async function updateSkill(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
  input: { description?: string; skillMd?: string; groupId?: string | null },
): Promise<void> {
  requireContent(input.description ?? '', input.skillMd ?? '')
  const row = await requireEditable(db, user, name, scope)
  const groupId = input.groupId === undefined ? row.group_id ?? null : await groupOf(db, user, scope, input.groupId)
  await objects.put(
    skillObjectKey(scope, row.user_id, name, 'SKILL.md'),
    Buffer.from(input.skillMd ?? ''),
    'text/markdown',
  )
  await db.query(
    `UPDATE dsh_skills SET description = $4, group_id = $5, revision = revision + 1, updated_at = now()
      WHERE user_id = $1 AND name = $2 AND scope = $3`,
    [row.user_id, name, scope, input.description, groupId],
  )
  await refreshStats(db, objects, row)
}

export async function deleteSkill(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
): Promise<void> {
  const row = await requireEditable(db, user, name, scope)
  for (const file of await listSkillObjects(objects, skillDir(scope, row.user_id, name))) {
    await objects.delete(skillObjectKey(scope, row.user_id, name, file.path))
  }
  const removed = await db.query(
    `DELETE FROM dsh_skills WHERE user_id = $1 AND name = $2 AND scope = $3`,
    [row.user_id, name, scope],
  )
  if (!removed.rowCount) throw new HttpError(404, 'not-found')
  await db.query(
    `DELETE FROM dsh_workspace_skills
      WHERE skill_name = $1 AND skill_scope = $2
        AND ($2 = 'public' OR workspace_id IN (SELECT id FROM dsh_workspaces WHERE user_id = $3))`,
    [name, scope, row.user_id],
  )
}

export async function readSkillFile(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
  path: string,
): Promise<{ body: Buffer; contentType: string }> {
  const row = await requireSkill(db, user, name, scope)
  requirePath(path)
  const body = await objects.get(skillObjectKey(scope, row.user_id, name, path))
  if (body === undefined) throw new HttpError(404, 'not-found')
  return { body, contentType: contentTypeOf(path) }
}

export async function writeSkillFile(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<{ bytes: number; file_count: number }> {
  const row = await requireEditable(db, user, name, scope)
  requirePath(path)
  if (path === 'SKILL.md') throw new HttpError(422, 'invalid-path')
  if (body.length > MAX_FILE_BYTES) throw new HttpError(413, 'file-too-large')
  const dir = skillDir(scope, row.user_id, name)
  const existing = await listSkillObjects(objects, dir)
  const total = existing.reduce((sum, file) => sum + (file.path === path ? 0 : file.bytes), 0) + body.length
  if (total > MAX_TOTAL_BYTES) throw new HttpError(422, 'skill-too-large')
  await objects.put(skillObjectKey(scope, row.user_id, name, path), body, contentType)
  return refreshStats(db, objects, row, true)
}

export async function removeSkillFile(
  db: Querier,
  objects: ObjectStore,
  user: Actor,
  name: string,
  scope: SkillScope,
  path: string,
): Promise<{ bytes: number; file_count: number }> {
  const row = await requireEditable(db, user, name, scope)
  requirePath(path)
  if (path === 'SKILL.md') throw new HttpError(422, 'invalid-path')
  const key = skillObjectKey(scope, row.user_id, name, path)
  if ((await objects.get(key)) === undefined) throw new HttpError(404, 'not-found')
  await objects.delete(key)
  return refreshStats(db, objects, row, true)
}

export async function setSkillEnabled(
  db: Querier,
  user: Actor,
  name: string,
  scope: SkillScope,
  enabled: boolean,
): Promise<void> {
  if (scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  const result = await db.query(
    `UPDATE dsh_skills SET enabled = $4, updated_at = now()
      WHERE name = $2 AND scope = $3 AND ($3 = 'public' OR user_id = $1)`,
    [user.id, name, scope, enabled],
  )
  if (!result.rowCount) throw new HttpError(404, 'not-found')
}

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function summaryOf(row: SkillRow, viewerId: string) {
  return {
    name: row.name,
    description: row.description,
    scope: row.scope,
    group_id: row.group_id ?? null,
    enabled: asBool(row.enabled),
    revision: asNumber(row.revision),
    bytes: asNumber(row.bytes),
    file_count: asNumber(row.file_count),
    updated_at: row.updated_at,
    owner_id: row.user_id,
    owner_display_name: row.display_name,
    mine: row.user_id === viewerId,
  }
}

/** 分组必须是调用者看得见的；公开技能只能挂公开分组。 */
async function groupOf(
  db: Querier,
  user: Actor,
  scope: SkillScope,
  groupId: string | null | undefined,
): Promise<string | null> {
  if (groupId === undefined || groupId === null || groupId.trim() === '') return null
  const group = await requireGroupForMember(db, user, 'skill', groupId.trim())
  if (scope === 'public' && group.visibility !== 'public') throw new HttpError(422, 'invalid-group')
  return group.id
}

async function requireSkill(db: Querier, user: Actor, name: string, scope: SkillScope): Promise<SkillRow> {
  const rows = await db.query(
    `SELECT s.user_id, u.display_name, s.name, s.description, s.scope, s.group_id, s.enabled,
            s.revision, s.bytes, s.file_count, s.updated_at
       FROM dsh_skills s JOIN dsh_users u ON u.id = s.user_id
      WHERE s.name = $1 AND s.scope = $2`,
    [name, scope],
  )
  const row = rows.rows[0] as unknown as SkillRow | undefined
  if (row === undefined) throw new HttpError(404, 'not-found')
  if (scope === 'private' && row.user_id !== user.id) throw new HttpError(404, 'not-found')
  return row
}

async function requireEditable(db: Querier, user: Actor, name: string, scope: SkillScope): Promise<SkillRow> {
  const row = await requireSkill(db, user, name, scope)
  if (scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  return row
}

function requireContent(description: string, skillMd: string): void {
  if (!description || !skillMd) throw new HttpError(422, 'skill-required')
}

function requirePath(path: string): void {
  if (!isSkillFilePath(path)) throw new HttpError(422, 'invalid-path')
}

/** 公开技能现有行的 owner；没有这行时返回 undefined。 */
async function publicOwner(db: Querier, name: string): Promise<string | undefined> {
  const rows = await db.query<{ user_id: string }>(
    `SELECT user_id FROM dsh_skills WHERE scope = 'public' AND name = $1`,
    [name],
  )
  return rows.rows[0]?.user_id
}

async function assertNameFree(db: Querier, userId: string, name: string): Promise<void> {
  const rows = await db.query(
    `SELECT 1 FROM dsh_skills WHERE user_id = $1 AND name = $2 AND scope = 'public'`,
    [userId, name],
  )
  if (rows.rows.length > 0) throw new HttpError(409, 'name-taken')
}

async function refreshStats(
  db: Querier,
  objects: ObjectStore,
  row: { user_id: string; name: string; scope: SkillScope },
  bumpRevision = false,
): Promise<{ bytes: number; file_count: number }> {
  const files = await listSkillObjects(objects, skillDir(row.scope, row.user_id, row.name))
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  await db.query(
    `UPDATE dsh_skills SET bytes = $4, file_count = $5,
            revision = revision + $6, updated_at = now()
      WHERE user_id = $1 AND name = $2 AND scope = $3`,
    [row.user_id, row.name, row.scope, bytes, files.length, bumpRevision ? 1 : 0],
  )
  return { bytes, file_count: files.length }
}

/** 递归列出技能目录下的文件（相对路径）。OSS 单页最多 1000 个，继续按子目录展开。 */
export async function listSkillObjects(objects: ObjectStore, dir: string): Promise<SkillFile[]> {
  const root = dir.replace(/\/+$/, '')
  const files: SkillFile[] = []
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const page = await objects.list(prefix)
    for (const file of page.files) {
      if (!file.key.startsWith(`${prefix}/`)) continue
      files.push({ path: file.key.slice(root.length + 1), bytes: file.size })
    }
    for (const child of page.directories) {
      await walk(child.replace(/\/+$/, ''), depth + 1)
    }
  }
  await walk(root, 0)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
}

function contentTypeOf(path: string): string {
  const index = path.lastIndexOf('.')
  const ext = index === -1 ? '' : path.slice(index + 1).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}
