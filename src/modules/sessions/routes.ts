import { randomBytes } from 'node:crypto'
import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { noteFor } from '../attachments/service.js'
import {
  cancelSession,
  history,
  listSessions,
  openSession,
  ownSession,
  postMessage,
  resumeSession,
  switchModel,
} from './service.js'

export function sessionRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/sessions',
      auth: 'member',
      handle: async (ctx) => {
        const workspaceId = ctx.url.searchParams.get('workspaceId') ?? ctx.url.searchParams.get('workspace_id')
        ctx.send(200, { code: 0, msg: 'ok', data: await listSessions(deps.db, ctx.actor!.id, workspaceId) })
      },
    },
    {
      method: 'POST',
      path: '/sessions',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ workspaceId?: string; title?: string; modelId?: string }>()
        const created = await openSession(deps.db, deps.brain, deps.credentialsKey, ctx.actor!.id, {
          workspaceId: body.workspaceId ?? '',
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
          ctx.res.write(`event: event\ndata: ${JSON.stringify({ seq: row.seq, type: row.type, data: row.payload })}\n\n`)
        }
        ctx.res.write(`event: ready\ndata: ${JSON.stringify({ replayed: rows.length, after: last, live: false })}\n\n`)
        ctx.res.end()
      },
    },
  ]
}
