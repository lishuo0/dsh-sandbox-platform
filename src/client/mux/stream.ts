/**
 * 平台会话实时面：SSE 直通 + 答复转发，平台是唯一授权边界。
 *
 * 顺序固定为「认路径 → 认人 → 认成员状态 → 认会话归属 → 才连脑」。
 * 任何一步失败都在响应头之前回 HTTP 状态码，绝不建立到脑的连接：跨成员
 * 访问不暴露存在性，也不允许"先转发再过滤"。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrainClient } from '../../brain/client.js'
import type { Db } from '../../kernel/db.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { sessionWorkspace } from '../../modules/workspaces/service.js'
import { answersSessionId, parseAnswer, sessionStreamId } from './protocol.js'

export interface SessionStreamRelayOptions {
  db: Db
  objects: ObjectStore
  brain: BrainClient
  /** 平台会话 cookie / bearer 解出的成员；只校验签名。 */
  resolveUser(req: IncomingMessage): string | undefined
  /** 成员是否仍可用（停用/删除后 token 在过期前也有效，必须回查）。 */
  isActiveUser(userId: string): Promise<boolean>
}

export interface SessionStreamRelay {
  /** 处理 SSE 下行；不是会话流路径时返回 false。 */
  handleStream(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>
  /** 处理答复上行；不是答复路径时返回 false。 */
  handleAnswer(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>
}

/** 最大答复体；answer 只该有几十字节。 */
const ANSWER_LIMIT = 64 * 1024

export function createSessionStreamRelay(options: SessionStreamRelayOptions): SessionStreamRelay {
  /** 认人 → 认成员状态 → 认会话归属；失败时自己写响应并返回 undefined。 */
  const authorize = async (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<{ userId: string; workspaceId: string } | undefined> => {
    const userId = options.resolveUser(req)
    if (userId === undefined || !(await options.isActiveUser(userId))) {
      fail(res, 401, 'unauthorized')
      return undefined
    }
    const owned = await options.db.query(
      `SELECT 1 FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    )
    if (owned.rows.length === 0) {
      fail(res, 404, 'session-not-found')
      return undefined
    }
    const workspace = await sessionWorkspace(options.db, options.objects, userId, sessionId)
    return { userId, workspaceId: workspace.id }
  }

  return {
    async handleStream(req, res, pathname) {
      const sessionId = sessionStreamId(pathname)
      if (sessionId === undefined) return false
      if (req.method !== 'GET') {
        fail(res, 405, 'method-not-allowed')
        return true
      }
      const who = await authorize(req, res, sessionId)
      if (who === undefined) return true
      const result = await options.brain.pipeSession({
        userId: who.userId,
        workspaceId: who.workspaceId,
        sessionId,
      }, req, res)
      if (!result.ok) fail(res, result.status || 502, result.code)
      return true
    },

    async handleAnswer(req, res, pathname) {
      const sessionId = answersSessionId(pathname)
      if (sessionId === undefined) return false
      if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed')
        return true
      }
      const who = await authorize(req, res, sessionId)
      if (who === undefined) return true
      let parsed: unknown
      try {
        parsed = await readJson(req)
      } catch {
        fail(res, 400, 'invalid-json')
        return true
      }
      const answer = parseAnswer(parsed, sessionId)
      if (!answer.ok) {
        fail(res, answer.code === 'session/mismatch' ? 409 : 400, answer.code)
        return true
      }
      const result = await options.brain.answer({
        userId: who.userId,
        workspaceId: who.workspaceId,
        sessionId,
        requestId: answer.body.requestId,
        outcome: answer.body.outcome,
      })
      if (!result.ok) {
        fail(res, result.status || 502, result.code)
        return true
      }
      send(res, 200, { accepted: true })
      return true
    },
  }
}

/** 平台 REST 的错误信封与 `kernel/http.ts` 一致。 */
function fail(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  send(res, status, { code: 1, msg: code, data: null })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > ANSWER_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
