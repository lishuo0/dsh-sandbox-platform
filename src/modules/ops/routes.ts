import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { listSandboxes } from './service.js'

/** 管理员看沙箱属于谁，用来排障。不读会话内容。 */
export function opsRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/admin/sandboxes',
      auth: 'admin',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await listSandboxes(deps.db, {
            page: Number(ctx.url.searchParams.get('page')),
            pageSize: Number(ctx.url.searchParams.get('page_size')),
          }),
        })
      },
    },
  ]
}
