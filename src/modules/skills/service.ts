import { HttpError, isUniqueViolation } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { isSlug, privateSkillKey, publicSkillKey } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'

export type SkillScope = 'private' | 'public'

export async function listSkills(db: Querier, userId: string) {
  const rows = await db.query(
    `SELECT name, description, scope, enabled, revision, bytes, file_count, updated_at
       FROM dsh_skills
      WHERE user_id = $1 OR scope = 'public'
      ORDER BY scope, name`,
    [userId],
  )
  return rows.rows
}

export async function saveSkill(
  db: Querier,
  objects: ObjectStore,
  user: { id: string; role: string },
  input: { name: string; description: string; skillMd: string; scope: SkillScope },
): Promise<void> {
  if (!input.name || !input.description || !input.skillMd) throw new HttpError(422, 'skill-required')
  if (!isSlug(input.name)) throw new HttpError(422, 'invalid-skill-name')
  if (input.scope === 'public' && user.role !== 'admin') throw new HttpError(403, 'admin-only')
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  const bytes = Buffer.byteLength(input.skillMd)
  const key = input.scope === 'public' ? publicSkillKey(input.name) : privateSkillKey(user.id, input.name)
  await objects.put(key, Buffer.from(input.skillMd), 'text/markdown')
  if (input.scope === 'public') {
    const updated = await db.query(
      `UPDATE dsh_skills
          SET description = $2, bytes = $3, user_id = $4, revision = revision + 1, updated_at = now()
        WHERE scope = 'public' AND name = $1`,
      [input.name, input.description, bytes, user.id],
    )
    if (updated.rowCount) return
    try {
      await db.query(
        `INSERT INTO dsh_skills (user_id, name, description, scope, bytes, file_count) VALUES ($1, $2, $3, 'public', $4, 1)`,
        [user.id, input.name, input.description, bytes],
      )
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      throw new HttpError(409, 'name-taken')
    }
    return
  }
  const saved = await db.query(
    `INSERT INTO dsh_skills (user_id, name, description, scope, bytes, file_count)
     VALUES ($1, $2, $3, 'private', $4, 1)
     ON CONFLICT (user_id, name) DO UPDATE
       SET description = $3, bytes = $4, revision = dsh_skills.revision + 1, updated_at = now()
     WHERE dsh_skills.scope = 'private'`,
    [user.id, input.name, input.description, bytes],
  )
  if (!saved.rowCount) throw new HttpError(409, 'name-taken')
}

export async function setSkillEnabled(
  db: Querier,
  user: { id: string; role: string },
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
