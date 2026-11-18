import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { ownWorkspace } from '../workspaces/service.js'
import {
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  listWorkspaceGroups,
  setWorkspaceGroups,
  updateGroup,
  type GroupKind,
} from './service.js'

/** 技能分组和 MCP 分组共用一套处理，只有资源名不同。 */
export function groupRoutes(deps: Deps): Route[] {
  return [...kindRoutes(deps, 'skill', '/skill-groups'), ...kindRoutes(deps, 'mcp', '/mcp-groups')]
}

function kindRoutes(deps: Deps, kind: GroupKind, base: string): Route[] {
  return [
    {
      method: 'GET',
      path: base,
      auth: 'member',
      handle: async (ctx) => {
        const params = ctx.url.searchParams
        const includePublic = params.get('available') === '1' || params.get('include_public') === '1'
        ctx.send(200, { code: 0, msg: 'ok', data: await listGroups(deps.db, ctx.actor!.id, kind, includePublic) })
      },
    },
    {
      method: 'POST',
      path: base,
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ name?: unknown; description?: unknown; visibility?: unknown }>()
        ctx.send(201, {
          code: 0,
          msg: 'ok',
          data: await createGroup(deps.db, ctx.actor!, kind, body),
        })
      },
    },
    {
      method: 'GET',
      path: `${base}/:id`,
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await getGroup(deps.db, ctx.actor!, kind, ctx.params.id) })
      },
    },
    {
      method: 'PATCH',
      path: `${base}/:id`,
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ name?: unknown; description?: unknown; visibility?: unknown }>()
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await updateGroup(deps.db, ctx.actor!, kind, ctx.params.id, body),
        })
      },
    },
    {
      method: 'DELETE',
      path: `${base}/:id`,
      auth: 'member',
      handle: async (ctx) => {
        await deleteGroup(deps.db, ctx.actor!, kind, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: { deleted: true } })
      },
    },
    {
      method: 'GET',
      path: `/workspaces/:id/${base.slice(1)}`,
      auth: 'member',
      handle: async (ctx) => {
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: await listWorkspaceGroups(deps.db, kind, workspace.id) })
      },
    },
    {
      method: 'PUT',
      path: `/workspaces/:id/${base.slice(1)}`,
      auth: 'member',
      handle: async (ctx) => {
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        const body = await ctx.json<{ groupIds?: unknown; group_ids?: unknown }>()
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await setWorkspaceGroups(
            deps.db,
            ctx.actor!,
            kind,
            workspace.id,
            groupIdsOf(body.groupIds ?? body.group_ids),
          ),
        })
      },
    },
  ]
}

function groupIdsOf(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(422, 'invalid-group-ids')
  }
  return value as string[]
}
