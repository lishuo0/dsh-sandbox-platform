import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { posix } from 'node:path'
import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { WORKSPACE_GUEST_ROOT, fileObjectKey, workspaceObjectKey, workspacePrefix } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { safeUploadName } from '../workspaces/upload.js'
import { ownSession, requireActive } from './service.js'

/** 单个图片附件预览的上限。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** 签名下载地址的有效期。地址本身是 bearer 凭据，和登录态绑在一起，不设太长。 */
const SIGNED_TTL_SECONDS = 24 * 3600
const WS_PREFIX = 'ws:'
const SHA_PREFIX = 'sha256:'

/** 按魔数认图片，避免扩展名和实际字节不一致。 */
export function sniffImageType(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return ''
}

/**
 * 会话文件上传：字节写进工作区的 `uploads/<sessionId>/` 前缀。
 * 工作区前缀就是沙箱工作卷（`/desk`）的存储面，脑在沙箱里直接能看到。
 */
export async function uploadSessionFile(
  db: Querier,
  objects: ObjectStore,
  credentialsKey: Buffer,
  userId: string,
  sessionId: string,
  name: string,
  contentType: string,
  bytes: Buffer,
) {
  const session = await ownSession(db, userId, sessionId)
  requireActive(session)
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  const clean = safeUploadName(name)
  if (clean === undefined) throw new HttpError(422, 'invalid-name')
  if (bytes.byteLength === 0) throw new HttpError(422, 'empty-file')
  // 扩展名不可信；图片按字节定类型，其余沿用上传时的 Content-Type。
  const mediaType = sniffImageType(bytes) || contentType.split(';')[0]?.trim() || 'application/octet-stream'
  const relative = posix.join('uploads', sessionId, clean)
  const key = workspaceObjectKey(session.workspaceId, posix.join(WORKSPACE_GUEST_ROOT, relative))
  await objects.put(key, bytes, mediaType)
  return {
    path: relative,
    sandboxPath: posix.join(WORKSPACE_GUEST_ROOT, relative),
    url: signedUploadUrl(credentialsKey, userId, session.workspaceId, key),
    bytes: bytes.byteLength,
  }
}

function signedUploadUrl(credentialsKey: Buffer, userId: string, workspaceId: string, key: string): string {
  const expires = Math.floor(Date.now() / 1000) + SIGNED_TTL_SECONDS
  const query = new URLSearchParams({
    w: workspaceId,
    k: key,
    e: String(expires),
    sig: signUpload(credentialsKey, userId, workspaceId, key, expires),
  })
  return `/dsh-api/platform/v1/files?${query.toString()}`
}

/** 签名覆盖成员 id：地址只对签发它的那个成员有效，转发出去也换不成别人的数据。 */
function signUpload(credentialsKey: Buffer, userId: string, workspaceId: string, key: string, expires: number): string {
  return createHmac('sha256', credentialsKey)
    .update(`${userId}\n${workspaceId}\n${key}\n${expires}`)
    .digest('hex')
}

/** 校验签名后返回对象字节；任何一项不成立都按未找到处理，不泄漏键名。 */
export async function readSignedUpload(
  objects: ObjectStore,
  credentialsKey: Buffer,
  userId: string,
  input: { workspaceId: string; key: string; expires: string; signature: string },
) {
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  const expires = Number(input.expires)
  if (!Number.isSafeInteger(expires) || Math.floor(Date.now() / 1000) > expires) throw new HttpError(404, 'not-found')
  const expected = signUpload(credentialsKey, userId, input.workspaceId, input.key, expires)
  const given = input.signature.trim()
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new HttpError(404, 'not-found')
  }
  if (!input.key.startsWith(`${workspacePrefix(input.workspaceId)}/`)) throw new HttpError(404, 'not-found')
  const data = await objects.get(input.key)
  if (data === undefined) throw new HttpError(404, 'not-found')
  return { data, mediaType: sniffImageType(data) || 'application/octet-stream' }
}

/**
 * 会话日志里引用的图片附件。
 * `ws:` 指向工作卷里的文件，`sha256:` 指向附件存储里的规范化对象。
 */
export async function sessionImageAttachment(
  db: Querier,
  objects: ObjectStore,
  userId: string,
  sessionId: string,
  attachmentId: string,
) {
  const session = await ownSession(db, userId, sessionId)
  requireActive(session)
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  const id = attachmentId.trim()
  if (id.startsWith(SHA_PREFIX)) {
    // 对象本身是全局内容寻址的，归属在 `dsh_attachments` 行上；只凭摘要读到的是
    // 任何成员上传过的字节，必须先确认这个附件记在当前成员名下。
    await requireOwnedAttachment(db, userId, id)
    return sha256Payload(objects, id)
  }
  if (id.startsWith(WS_PREFIX)) {
    return workspacePayload(objects, session.workspaceId, id)
  }
  throw new HttpError(422, 'invalid-attachment-id')
}

async function requireOwnedAttachment(db: Querier, userId: string, attachmentId: string): Promise<void> {
  const rows = await db.query(
    `SELECT 1 FROM dsh_attachments WHERE user_id = $1 AND id = $2`,
    [userId, attachmentId],
  )
  if (rows.rows.length === 0) throw new HttpError(404, 'not-found')
}

async function sha256Payload(objects: ObjectStore, attachmentId: string) {
  const digest = attachmentId.slice(SHA_PREFIX.length)
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new HttpError(422, 'invalid-attachment-id')
  const data = await objects.get(fileObjectKey(digest))
  if (data === undefined) throw new HttpError(404, 'not-found')
  if (createHash('sha256').update(data).digest('hex') !== digest) throw new HttpError(422, 'attachment-corrupt')
  return payload(attachmentId, data)
}

async function workspacePayload(objects: ObjectStore, workspaceId: string, attachmentId: string) {
  const encoded = attachmentId.slice(WS_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new HttpError(422, 'invalid-attachment-id')
  const absolute = Buffer.from(encoded, 'base64url').toString('utf8')
  if (!absolute.startsWith(`${WORKSPACE_GUEST_ROOT}/`)) throw new HttpError(422, 'invalid-attachment-id')
  let key: string
  try {
    key = workspaceObjectKey(workspaceId, absolute)
  } catch {
    throw new HttpError(422, 'invalid-attachment-id')
  }
  const data = await objects.get(key)
  if (data === undefined) throw new HttpError(404, 'not-found')
  return payload(attachmentId, data, posix.basename(absolute))
}

function payload(attachmentId: string, data: Buffer, name = '') {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new HttpError(422, 'attachment-too-large')
  const mediaType = sniffImageType(data)
  if (mediaType === '') throw new HttpError(422, 'not-an-image')
  return {
    attachment: {
      attachmentId,
      mediaType,
      bytes: data.byteLength,
      ...(name === '' ? {} : { name }),
    },
    data: data.toString('base64'),
  }
}
