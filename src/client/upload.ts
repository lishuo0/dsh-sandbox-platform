/**
 * `POST P/upload`：浏览器附件的字节直传。
 *
 * 官方 `dsh-client-file-upload` 的 `postRaw` 用 `__DSH_FILE_UPLOAD__.fetch`
 * 把 `File`/`Blob` 原样 POST 过来（查询串 `sessionId` + `name`，图片再加
 * `mediaType`）。平台把字节写进当前会话所属工作区的 `uploads/<sessionId>/`
 * 前缀——那是沙箱工作卷的存储面，不经脑、也不碰宿主目录。
 *
 * 回包沿用上传传输的契约：HTTP 200 + `{ok:true,value}` 或 `{ok:false,error}`，
 * 这样浏览器能拿到结构化的错误码；只有认人失败才回 401。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from '../kernel/db.js'
import { HttpError } from '../kernel/errors.js'
import type { ObjectStore } from '../kernel/objects.js'
import { sniffImageType, uploadSessionFile } from '../modules/sessions/attachment.js'

/** 单次直传上限，与工作区文件上传一致。 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

export interface SessionUploadDeps {
  readonly db: Db
  readonly objects: ObjectStore
  readonly credentialsKey: Buffer
  readonly userId: string
}

/** 平台上传面；非 `P/upload` 路径返回 false。 */
export async function handleSessionUpload(
  deps: SessionUploadDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/dsh-api/platform/v1/upload') return false
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return true
  }
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const name = url.searchParams.get('name') ?? ''
  const wantsImage = url.searchParams.get('mediaType') !== null
  if (sessionId === '' || name === '') {
    reply(res, 200, { ok: false, error: { code: 'session/id-invalid', message: 'An upload needs a session and a file name.', details: {} } })
    return true
  }
  const read = await readBody(req, MAX_UPLOAD_BYTES)
  if (!read.ok) {
    reply(res, 200, {
      ok: false,
      error: read.reason === 'too-large'
        ? { code: 'session/attachment-invalid', message: `A single upload is limited to ${MAX_UPLOAD_BYTES} bytes.`, details: { reason: 'too-large' } }
        : { code: 'session/attachment-invalid', message: 'The upload was interrupted; try again.', details: { reason: 'incomplete' } },
    })
    return true
  }
  const mediaType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim()
  try {
    const stored = await uploadSessionFile(
      deps.db,
      deps.objects,
      deps.credentialsKey,
      deps.userId,
      sessionId,
      name,
      mediaType === '' ? 'application/octet-stream' : mediaType,
      read.body,
    )
    const attachmentId = `ws:${Buffer.from(stored.sandboxPath).toString('base64url')}`
    if (!wantsImage) {
      reply(res, 200, {
        ok: true,
        value: { receiptId: `upload_${randomUUID()}`, file: { attachmentId, name, bytes: stored.bytes } },
      })
      return true
    }
    const image = imageSize(read.body)
    if (image === undefined) {
      reply(res, 200, {
        ok: false,
        error: { code: 'session/attachment-invalid', message: 'The image could not be read.', details: { reason: 'unreadable-image' } },
      })
      return true
    }
    reply(res, 200, {
      ok: true,
      value: {
        receiptId: `upload_${randomUUID()}`,
        image: { attachmentId, mediaType: image.mediaType, bytes: stored.bytes, width: image.width, height: image.height, name },
      },
    })
    return true
  } catch (error) {
    const http = error instanceof HttpError ? error : undefined
    reply(res, 200, {
      ok: false,
      error: {
        code: http?.code ?? 'session/attachment-invalid',
        message: http?.code ?? 'The file could not be stored.',
        details: {},
      },
    })
    return true
  }
}

type ReadResult = { ok: true; body: Buffer } | { ok: false; reason: 'too-large' | 'incomplete' }

async function readBody(req: IncomingMessage, limit: number): Promise<ReadResult> {
  const declared = Number(req.headers['content-length'] ?? '')
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too-large' }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += part.byteLength
      if (total > limit) {
        req.destroy()
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(part)
    }
  } catch {
    return { ok: false, reason: 'incomplete' }
  }
  if (Number.isFinite(declared) && declared !== total) return { ok: false, reason: 'incomplete' }
  return { ok: true, body: Buffer.concat(chunks) }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

interface ImageSize {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  width: number
  height: number
}

/** 从图片头里读尺寸；四种可上传类型之外或数据残缺时返回 undefined。 */
export function imageSize(bytes: Buffer): ImageSize | undefined {
  const mediaType = sniffImageType(bytes)
  if (mediaType === 'image/png') {
    if (bytes.length < 24) return undefined
    return { mediaType, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mediaType === 'image/gif') {
    if (bytes.length < 10) return undefined
    return { mediaType, width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (mediaType === 'image/jpeg') return jpegSize(bytes)
  if (mediaType === 'image/webp') return webpSize(bytes)
  return undefined
}

function jpegSize(bytes: Buffer): ImageSize | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 独立标记没有长度字段。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (sof) {
      if (offset + 9 > bytes.length) return undefined
      return { mediaType: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

function webpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 30) return undefined
  const chunk = bytes.subarray(12, 16).toString('latin1')
  const width = (value: number): number => value + 1
  if (chunk === 'VP8 ') {
    if (bytes.subarray(23, 26).toString('latin1') !== '\x9d\x01\x2a') return undefined
    return {
      mediaType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = bytes.readUInt32LE(21)
    return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    const low = bytes.readUIntLE(24, 3)
    const high = bytes.readUIntLE(27, 3)
    return { mediaType: 'image/webp', width: width(low), height: width(high) }
  }
  return undefined
}
