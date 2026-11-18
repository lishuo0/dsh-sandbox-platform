/**
 * 页面上传工作区文件：字节写进该工作区的对象前缀（`desks/{id}`）。
 *
 * `/desk` 就是这块前缀的挂载点，所以沙箱不用参与写入；平台写完，文件直接
 * 出现在文件树和预览里。上传只新增、不覆盖：重名按 `name (1).ext` 顺延，
 * 由对象存储的原子新增保证并发下也不会互相替换。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Db } from '../../kernel/db.js'
import { WORKSPACE_GUEST_ROOT, workspaceObjectKey } from '../../kernel/layout.js'
import { ObjectExistsError, type ObjectStore } from '../../kernel/objects.js'
import { sessionWorkspace } from './service.js'

/** 单个文件的上限；再大就该走对象存储的直传而不是同步上传。 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** 重名顺延的尝试次数。 */
const MAX_RENAME_ATTEMPTS = 100

export interface UploadContext {
  db: Db
  objects: ObjectStore
  userId: string
}

export interface UploadValue {
  /** 沙箱内的绝对路径，和文件树里看到的一致。 */
  path: string
  /** 实际写入的文件名；重名顺延时与请求里的不同。 */
  name: string
  bytes: number
  requestedName: string
}

/** 拆出扩展名；点文件（`.env`）整体算主名。 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension: name.slice(dot) }
}

/** 第 `attempt` 次重试时的候选名；`0` 就是原名。 */
export function uploadCandidate(name: string, attempt: number): string {
  if (attempt === 0) return name
  const { stem, extension } = splitFileName(name)
  return `${stem} (${attempt})${extension}`
}

/** 浏览器给的文件名只留最后一段，带分隔符或空名直接拒绝。 */
export function safeUploadName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return undefined
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return undefined
  if (Buffer.byteLength(trimmed, 'utf8') > 255) return undefined
  return trimmed
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, error: { code, message, details: {} } })
}

export type UploadBody =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too-large' | 'incomplete' }

/**
 * 读原始请求体。超过上限立刻停；客户端取消或断线时不把半截字节写成文件。
 */
export async function readUploadBody(req: IncomingMessage, limit: number): Promise<UploadBody> {
  const header = req.headers['content-length']
  const declared = header === undefined ? undefined : Number(header)
  if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
    return { ok: false, reason: 'too-large' }
  }
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
    // 用户点了取消或网络断开：请求体没有传完。
    return { ok: false, reason: 'incomplete' }
  }
  if (declared !== undefined && Number.isFinite(declared) && declared !== total) {
    return { ok: false, reason: 'incomplete' }
  }
  return { ok: true, body: Buffer.concat(chunks) }
}

/**
 * 处理一次上传；会话必须属于当前成员，目录必须在工作卷里。
 * @param context - 数据库、对象存储与当前成员。
 * @param req - 原始字节请求；查询参数带 `sessionId`、`dir`、`name`。
 * @param res - 平台响应。
 */
export async function handleWorkspaceUpload(
  context: UploadContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') {
    fail(res, 400, 'workspace-file/session-required', 'A session id is required.')
    return
  }
  const owned = await context.db.query<{ id: string }>(
    `SELECT id FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, context.userId],
  )
  if (owned.rows.length === 0) {
    fail(res, 404, 'workspace-file/session-not-found', 'The session was not found.')
    return
  }
  const requestedName = safeUploadName(url.searchParams.get('name') ?? '')
  if (requestedName === undefined) {
    fail(res, 422, 'workspace-file/invalid-name', 'The uploaded file needs a plain file name.')
    return
  }
  const read = await readUploadBody(req, MAX_UPLOAD_BYTES)
  if (!read.ok) {
    // 取消上传时连接通常已经断了，没必要再往死连接写响应。
    if (res.destroyed) return
    if (read.reason === 'too-large') {
      fail(res, 413, 'workspace-file/too-large', `A single upload is limited to ${MAX_UPLOAD_BYTES} bytes.`)
    } else {
      fail(res, 400, 'workspace-file/incomplete', 'The upload was interrupted; try again.')
    }
    return
  }
  const body = read.body

  const workspace = await sessionWorkspace(context.db, context.objects, context.userId, sessionId)
  const requestedDir = (url.searchParams.get('dir') ?? '').trim()
  const directory = requestedDir === '' ? WORKSPACE_GUEST_ROOT : requestedDir.replace(/\/+$/u, '')
  let prefix: string
  try {
    prefix = workspaceObjectKey(workspace.id, directory)
  } catch {
    fail(res, 422, 'workspace-file/outside-workspace', 'The upload directory is outside the workspace.')
    return
  }

  const mediaType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim()
  try {
    for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
      const candidate = uploadCandidate(requestedName, attempt)
      try {
        await context.objects.put(
          `${prefix}/${candidate}`,
          body,
          mediaType === '' ? 'application/octet-stream' : mediaType,
          { ifAbsent: true },
        )
        const value: UploadValue = {
          path: `${directory}/${candidate}`,
          name: candidate,
          bytes: body.byteLength,
          requestedName,
        }
        send(res, 200, { ok: true, value })
        return
      } catch (error) {
        if (!(error instanceof ObjectExistsError)) throw error
      }
    }
    fail(res, 409, 'workspace-file/name-conflict', 'Too many files share this name.')
  } catch {
    fail(res, 500, 'workspace-file/write-failed', 'The file could not be stored.')
  }
}
