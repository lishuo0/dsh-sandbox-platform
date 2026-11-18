import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { listFeedback } from './service.js'

/** 反馈列表：成员只看自己的会话，管理员可看全部，并可按会话过滤。 */
export function feedbackRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/feedback',
      auth: 'member',
      handle: async (ctx) => {
        const raw = Number(ctx.url.searchParams.get('limit') ?? '')
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 500) : 100
        const sessionId = ctx.url.searchParams.get('sessionId') ?? undefined
        const viewer = ctx.actor!.role === 'admin'
          ? { id: ctx.actor!.id, role: 'admin' as const }
          : { id: ctx.actor!.id, role: 'member' as const }
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await listFeedback(deps.db, viewer, {
            limit,
            ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
          }),
        })
      },
    },
  ]
}
