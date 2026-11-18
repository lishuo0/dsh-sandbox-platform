import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { listSchedules } from './service.js'

/**
 * 只列当前成员自己会话上的定时任务。
 * 创建、修改和删除仍由会话里的工具完成，平台这里只读。
 */
export function scheduleRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/schedules',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: { items: await listSchedules(deps.db, ctx.actor!.id) } })
      },
    },
  ]
}
