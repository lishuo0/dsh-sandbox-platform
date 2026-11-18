import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { readSignedUpload } from '../sessions/attachment.js'
import { listAttachments, saveAttachment } from './service.js'

function mediaType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(';')[0]?.trim() || 'application/octet-stream'
}

export function attachmentRoutes(deps: Deps): Route[] {
  return [
    {
      // 图片预览用的只读地址：签名按成员签发，且要求登录态；地址到期即失效。
      method: 'GET',
      path: '/files',
      auth: 'member',
      handle: async (ctx) => {
        const params = ctx.url.searchParams
        const { data, mediaType } = await readSignedUpload(deps.objects, deps.credentialsKey, ctx.actor!.id, {
          workspaceId: params.get('w') ?? '',
          key: params.get('k') ?? '',
          expires: params.get('e') ?? '',
          signature: params.get('sig') ?? '',
        })
        ctx.res.writeHead(200, {
          'content-type': mediaType,
          'content-length': data.byteLength,
          'cache-control': 'private, max-age=3600',
        })
        ctx.res.end(data)
      },
    },
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
