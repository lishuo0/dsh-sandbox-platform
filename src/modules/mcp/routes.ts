import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { listMcp, removeMcp, saveMcp, setMcpEnabled } from './service.js'

export function mcpRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/mcp-servers',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await listMcp(deps.db, ctx.actor!.id) }),
    },
    {
      method: 'POST',
      path: '/mcp-servers',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ name?: string; url?: string; timeoutMs?: number; headers?: Record<string, { secret?: string; value?: string }> }>()
        await saveMcp(deps.db, deps.credentialsKey, ctx.actor!.id, {
          name: body.name ?? '',
          url: body.url ?? '',
          timeoutMs: body.timeoutMs,
          headers: body.headers,
        })
        ctx.send(201, { code: 0, msg: 'ok', data: { name: body.name } })
      },
    },
    {
      method: 'POST',
      path: '/mcp-servers/:name/enable',
      auth: 'member',
      handle: async (ctx) => {
        await setMcpEnabled(deps.db, ctx.actor!.id, ctx.params.name, true)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'POST',
      path: '/mcp-servers/:name/disable',
      auth: 'member',
      handle: async (ctx) => {
        await setMcpEnabled(deps.db, ctx.actor!.id, ctx.params.name, false)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'DELETE',
      path: '/mcp-servers/:name',
      auth: 'member',
      handle: async (ctx) => {
        await removeMcp(deps.db, ctx.actor!.id, ctx.params.name)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
  ]
}
