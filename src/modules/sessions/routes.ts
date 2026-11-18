import { randomBytes } from 'node:crypto'
import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { RequestCtx, Route } from '../../kernel/http.js'
import { noteFor } from '../attachments/service.js'
import { sessionImageAttachment, uploadSessionFile } from './attachment.js'
import {
  cancelSession,
  commands,
  composerCall,
  executeCommand,
  forceCancelSession,
  getSession,
  goalAction,
  history,
  historyPage,
  jobStream,
  killJob,
  listSessions,
  openSession,
  ownSession,
  postMessage,
  resumeSession,
  searchSessions,
  switchModel,
  updateSession,
} from './service.js'

/** 会话沙箱文件接口接受的查询参数，其余一律丢弃。 */
const FILE_PARAMS = ['path', 'baseFile', 'bytes', 'offset', 'length', 'limit', 'name'] as const

function fileSearch(ctx: RequestCtx): string {
  const search = new URLSearchParams()
  for (const key of FILE_PARAMS) {
    const value = ctx.url.searchParams.get(key)
    if (value !== null && value !== '') search.set(key, value)
  }
  return search.toString()
}

/** 文件读写属于改状态的动作，必须由脑经沙箱接缝执行，平台只做归属判定。 */
async function sessionFiles(deps: Deps, ctx: RequestCtx, action?: 'content' | 'stat' | 'upload') {
  const session = await ownSession(deps.db, ctx.actor!.id, ctx.params.id)
  const bytes = action === 'upload' ? await ctx.raw() : undefined
  const result = await deps.brain.workspaceFiles({
    userId: ctx.actor!.id,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    action,
    search: fileSearch(ctx),
    bytes,
  })
  if (!result.ok) throw new HttpError(result.status || 502, result.code)
  return result.value
}

/** 查询参数里的整数；缺省或空串按默认值处理，越界交给服务层判断。 */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new HttpError(400, 'invalid-pagination')
  return value
}

const COMPOSER_BODY_LIMIT = 1_000_000

/** composer 请求体原样转给脑；空 body 当成 `{}`，和参考实现一致。 */
async function composerBody(ctx: RequestCtx): Promise<unknown> {
  const bytes = await ctx.raw()
  if (bytes.byteLength > COMPOSER_BODY_LIMIT) throw new HttpError(413, 'body-too-large')
  if (bytes.byteLength === 0) return {}
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'invalid-json')
  }
}

/** 硬取消的 request_id 可省；空 body 当成没带。 */
async function forceCancelBody(ctx: RequestCtx): Promise<string | undefined> {
  const bytes = await ctx.raw()
  if (bytes.byteLength === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'invalid-json')
  }
  if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'invalid-json')
  const body = parsed as { request_id?: unknown; requestId?: unknown }
  const value = body.request_id ?? body.requestId
  if (value !== undefined && typeof value !== 'string') throw new HttpError(422, 'invalid-request-id')
  return value
}

export function sessionRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/search/sessions',
      auth: 'member',
      handle: async (ctx) => {
        const q = ctx.url.searchParams.get('q')?.trim() || ctx.url.searchParams.get('query')?.trim() || ''
        ctx.send(200, { code: 0, msg: 'ok', data: await searchSessions(deps.db, ctx.actor!.id, q) })
      },
    },
    {
      method: 'GET',
      path: '/sessions',
      auth: 'member',
      handle: async (ctx) => {
        const workspaceId = ctx.url.searchParams.get('workspaceId') ?? ctx.url.searchParams.get('workspace_id')
        const limit = intParam(ctx.url.searchParams.get('limit'), 0)
        const cursor = ctx.url.searchParams.get('cursor') || undefined
        const page = await listSessions(deps.db, ctx.actor!.id, workspaceId, { limit, cursor })
        ctx.send(200, { code: 0, msg: 'ok', data: { items: page.items, next_cursor: page.nextCursor } })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await getSession(deps.db, ctx.actor!.id, ctx.params.id) })
      },
    },
    {
      method: 'PATCH',
      path: '/sessions/:id',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ title?: unknown; archived?: unknown; stopActivity?: unknown }>()
        const input: { title?: string; archived?: boolean; stopActivity?: boolean } = {}
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') throw new HttpError(422, 'invalid-title')
          input.title = body.title
        }
        if (body.archived !== undefined) {
          if (typeof body.archived !== 'boolean') throw new HttpError(422, 'invalid-archived')
          input.archived = body.archived
        }
        if (body.stopActivity !== undefined) {
          if (typeof body.stopActivity !== 'boolean') throw new HttpError(422, 'invalid-stop-activity')
          input.stopActivity = body.stopActivity
        }
        const updated = await updateSession(deps.db, deps.brain, ctx.actor!.id, ctx.params.id, input)
        ctx.send(200, { code: 0, msg: 'ok', data: updated })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/history',
      auth: 'member',
      handle: async (ctx) => {
        // 不传 after/before 表示最新一页；两者互斥。
        const params = ctx.url.searchParams
        const page = await historyPage(deps.db, ctx.actor!.id, ctx.params.id, {
          after: intParam(params.get('after'), -1),
          before: intParam(params.get('before'), -1),
          limit: intParam(params.get('limit'), 0),
          maxMessages: intParam(params.get('max_messages'), 0),
          minMessages: intParam(params.get('min_messages'), 0),
          minTurns: intParam(params.get('min_turns'), 0),
        })
        ctx.send(200, { code: 0, msg: 'ok', data: page })
      },
    },
    {
      method: 'POST',
      path: '/sessions',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ workspaceId?: string; title?: string; modelId?: string }>()
        const created = await openSession(deps.db, deps.objects, deps.brain, deps.credentialsKey, ctx.actor!.id, {
          workspaceId: body.workspaceId,
          title: body.title,
          modelId: body.modelId,
        })
        ctx.send(created.status, { code: created.createState === 'ready' ? 0 : 1, msg: created.createState, data: { id: created.id, createState: created.createState } })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/resume',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ modelId?: string }>()
        const resumed = await resumeSession(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, body.modelId)
        ctx.send(200, { code: 0, msg: 'ok', data: resumed })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/messages',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ text?: string; requestId?: string; attachmentIds?: string[] }>()
        const text = body.text?.trim() ?? ''
        if (!text && !body.attachmentIds?.length) throw new HttpError(422, 'invalid-text')
        const note = await noteFor(deps.db, ctx.actor!.id, body.attachmentIds ?? [])
        const delivered = await postMessage(
          deps.db,
          deps.brain,
          deps.credentialsKey,
          ctx.actor!.id,
          ctx.params.id,
          `${text}${note}`,
          body.requestId || randomBytes(12).toString('hex'),
        )
        ctx.send(delivered.status, { code: delivered.state === 'accepted' ? 0 : 1, msg: delivered.state, data: delivered })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/model',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ modelId?: string }>()
        if (!body.modelId) throw new HttpError(422, 'model-config-required')
        ctx.send(200, { code: 0, msg: 'ok', data: await switchModel(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, body.modelId) })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/cancel',
      auth: 'member',
      handle: async (ctx) => {
        await cancelSession(deps.db, deps.brain, ctx.actor!.id, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/workspace-files',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await sessionFiles(deps, ctx) })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/workspace-files',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await sessionFiles(deps, ctx, 'upload') })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/workspace-files/content',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await sessionFiles(deps, ctx, 'content') })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/workspace-files/stat',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await sessionFiles(deps, ctx, 'stat') })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/force-cancel',
      auth: 'member',
      handle: async (ctx) => {
        const requestId = await forceCancelBody(ctx)
        ctx.send(202, {
          code: 0,
          msg: 'ok',
          data: await forceCancelSession(deps.db, deps.brain, ctx.actor!.id, ctx.params.id, requestId),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/jobs',
      auth: 'member',
      handle: async (ctx) => {
        await jobStream(deps.db, deps.brain, ctx.actor!.id, ctx.params.id, {}, ctx.req, ctx.res)
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/jobs/:jobId/output',
      auth: 'member',
      handle: async (ctx) => {
        const raw = ctx.url.searchParams.get('from')
        let from: number | undefined
        if (raw !== null && raw !== '') {
          from = Number(raw)
          if (!Number.isSafeInteger(from) || from < 0) throw new HttpError(400, 'invalid-from')
        }
        await jobStream(deps.db, deps.brain, ctx.actor!.id, ctx.params.id, { jobId: ctx.params.jobId, from }, ctx.req, ctx.res)
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/jobs/:jobId/kill',
      auth: 'member',
      handle: async (ctx) => {
        await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await killJob(deps.db, deps.brain, ctx.actor!.id, ctx.params.id, ctx.params.jobId),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/projections',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'GET', '/projections'),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/message-feedback',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'GET', '/message-feedback'),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/message-feedback',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'POST', '/message-feedback', body),
        })
      },
    },
    {
      method: 'DELETE',
      path: '/sessions/:id/message-feedback',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'DELETE', '/message-feedback', body),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/feedback',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'POST', '/feedback', body),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/commands',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await commands(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/commands',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await executeCommand(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, body),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/goal',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'GET', '/goal'),
        })
      },
    },
    {
      method: 'PUT',
      path: '/sessions/:id/goal',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'PUT', '/goal', body),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/goal/:action',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await goalAction(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, ctx.params.action, body),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/preset',
      auth: 'member',
      handle: async (ctx) => {
        const body = await composerBody(ctx)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await composerCall(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, ctx.params.id, 'POST', '/preset', body),
        })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/attachments/:attachmentId',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await sessionImageAttachment(deps.db, deps.objects, ctx.actor!.id, ctx.params.id, ctx.params.attachmentId),
        })
      },
    },
    {
      method: 'POST',
      path: '/sessions/:id/files',
      auth: 'member',
      handle: async (ctx) => {
        const name = ctx.url.searchParams.get('name') ?? ''
        const saved = await uploadSessionFile(
          deps.db,
          deps.objects,
          deps.credentialsKey,
          ctx.actor!.id,
          ctx.params.id,
          name,
          String(ctx.req.headers['content-type'] ?? ''),
          await ctx.raw(),
        )
        ctx.send(200, { code: 0, msg: 'ok', data: saved })
      },
    },
    {
      method: 'GET',
      path: '/sessions/:id/events',
      auth: 'member',
      handle: async (ctx) => {
        const after = Number(ctx.url.searchParams.get('after') ?? '-1')
        if (!Number.isSafeInteger(after) || after < -1) throw new HttpError(400, 'invalid-after')
        const session = await ownSession(deps.db, ctx.actor!.id, ctx.params.id)
        const live = await deps.brain.pipeEvents(
          { userId: ctx.actor!.id, workspaceId: session.workspaceId, sessionId: session.id, after },
          ctx.req,
          ctx.res,
        )
        if (live) return
        let rows: Awaited<ReturnType<typeof history>> = []
        try {
          rows = await history(deps.db, ctx.actor!.id, session.id, after)
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : ''
          if (code !== '42P01') throw error
        }
        ctx.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const last = rows.at(-1)?.seq ?? after
        ctx.res.write(`event: snapshot\ndata: ${JSON.stringify({ cursor: last })}\n\n`)
        for (const row of rows) {
          // 与实时转发的帧保持同一形状：surfaceOp/sourceEventSeqs 是持久日志的
          // 一部分，回退路径漏掉它们会让浏览器整段历史校验失败。
          const committed = (row.payload ?? {}) as Record<string, unknown>
          ctx.res.write(`event: event\ndata: ${JSON.stringify({
            seq: row.seq,
            type: row.type,
            data: committed.data ?? null,
            ...(typeof committed.time === 'number' ? { time: committed.time } : {}),
            ...(committed.ignorable === true ? { ignorable: true } : {}),
            ...(committed.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: committed.sourceEventSeqs }),
            ...(committed.surfaceOp === undefined ? {} : { surfaceOp: committed.surfaceOp }),
          })}\n\n`)
        }
        ctx.res.write(`event: ready\ndata: ${JSON.stringify({ replayed: rows.length, after: last, live: false })}\n\n`)
        ctx.res.end()
      },
    },
  ]
}
