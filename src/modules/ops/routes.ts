import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'

/** 管理员看沙箱属于谁，用来排障。不读会话内容。 */
export function opsRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/admin/sandboxes',
      auth: 'admin',
      handle: async (ctx) => {
        try {
          const rows = await deps.db.query(
            `SELECT user_id, workspace_id, session_id, sandbox_id, state, last_used_at
               FROM dsh_sandboxes
              ORDER BY last_used_at DESC NULLS LAST
              LIMIT 200`,
          )
          ctx.send(200, { code: 0, msg: 'ok', data: rows.rows })
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : ''
          if (code === '42P01') {
            ctx.send(200, { code: 0, msg: 'ok', data: [] })
            return
          }
          throw error
        }
      },
    },
  ]
}
