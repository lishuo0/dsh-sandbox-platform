import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { listAttachments, saveAttachment } from './service.js'

function mediaType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(';')[0]?.trim() || 'application/octet-stream'
}

export function attachmentRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/attachments',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await listAttachments(deps.db, ctx.actor!.id) }),
    },
    {
      method: 'POST',
      path: '/attachments',
      auth: 'member',
      handle: async (ctx) => {
        const name = ctx.url.searchParams.get('name')?.trim() ?? ''
        if (!name) throw new HttpError(422, 'invalid-name')
        const saved = await saveAttachment(
          deps.db,
          deps.objects,
          ctx.actor!.id,
          name,
          mediaType(ctx.req.headers['content-type']),
          await ctx.raw(),
        )
        ctx.send(201, { code: 0, msg: 'ok', data: saved })
      },
    },
  ]
}
