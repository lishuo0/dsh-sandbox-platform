import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import {
  getMcp,
  listMcp,
  removeMcp,
  saveMcp,
  setMcpEnabled,
  type HeaderSpec,
  type McpScope,
} from './service.js'

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
        const body = await ctx.json<{
          name?: string
          url?: string
          scope?: string
          timeoutMs?: number
          headers?: Record<string, HeaderSpec>
          groupId?: string | null
          group_id?: string | null
        }>()
        const scope = body.scope === 'public' ? 'public' : 'private'
        await saveMcp(deps.db, deps.credentialsKey, ctx.actor!, {
          name: body.name ?? '',
          url: body.url ?? '',
          scope,
          timeoutMs: body.timeoutMs,
          headers: body.headers,
          groupId: body.groupId ?? body.group_id,
        })
        ctx.send(201, { code: 0, msg: 'ok', data: { name: body.name, scope } })
      },
    },
    {
      method: 'GET',
      path: '/mcp-servers/:name',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await getMcp(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url)),
        })
      },
    },
    {
      method: 'PUT',
      path: '/mcp-servers/:name',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{
          url?: string
          timeoutMs?: number
          headers?: Record<string, HeaderSpec>
          groupId?: string | null
          group_id?: string | null
        }>()
        const scope = scopeOf(ctx.url)
        await saveMcp(deps.db, deps.credentialsKey, ctx.actor!, {
          name: ctx.params.name,
          url: body.url ?? '',
          scope,
          timeoutMs: body.timeoutMs,
          headers: body.headers,
          groupId: body.groupId ?? body.group_id,
        })
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'POST',
      path: '/mcp-servers/:name/enable',
      auth: 'member',
      handle: async (ctx) => {
        await setMcpEnabled(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url), true)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'POST',
      path: '/mcp-servers/:name/disable',
      auth: 'member',
      handle: async (ctx) => {
        await setMcpEnabled(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url), false)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'DELETE',
      path: '/mcp-servers/:name',
      auth: 'member',
      handle: async (ctx) => {
        await removeMcp(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url))
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
  ]
}

function scopeOf(url: URL): McpScope {
  return url.searchParams.get('scope') === 'public' ? 'public' : 'private'
}
