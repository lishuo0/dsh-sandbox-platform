import { createHash } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { fileObjectKey } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'

export async function saveAttachment(
  db: Querier,
  objects: ObjectStore,
  userId: string,
  name: string,
  mediaType: string,
  body: Buffer,
) {
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  if (!body.length) throw new HttpError(422, 'empty-file')
  const safe = name.replace(/\\/g, '/').split('/').at(-1)?.trim() || 'file'
  if (safe === '.' || safe === '..') throw new HttpError(422, 'invalid-name')
  const digest = createHash('sha256').update(body).digest('hex')
  const id = `sha256:${digest}`
  await objects.put(fileObjectKey(digest), body, mediaType)
  await db.query(
    `INSERT INTO dsh_attachments (id, user_id, name, media_type, bytes, object_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, id) DO UPDATE SET name = $3, media_type = $4, bytes = $5`,
    [id, userId, safe, mediaType, body.length, fileObjectKey(digest)],
  )
  return { attachmentId: id, name: safe, mediaType, bytes: body.length }
}

export async function listAttachments(db: Querier, userId: string) {
  const rows = await db.query(
    `SELECT id, name, media_type, bytes, created_at FROM dsh_attachments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  )
  return rows.rows
}

/** 核对附件属于这个用户，并写成消息里的引用。字节留在共享存储。 */
export async function noteFor(db: Querier, userId: string, ids: string[]): Promise<string> {
  if (!ids.length) return ''
  const rows = await db.query(`SELECT id, name FROM dsh_attachments WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, ids])
  if (rows.rowCount !== ids.length) throw new HttpError(404, 'attachment-not-found')
  const lines = rows.rows.map((row) => `- ${(row as { name: string }).name} ${(row as { id: string }).id}`)
  return `\n\n[attachments]\n${lines.join('\n')}`
}
