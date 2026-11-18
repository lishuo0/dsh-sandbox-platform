import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { WORKSPACE_GUEST_ROOT } from '../../kernel/layout.js'
import {
  createWorkspace,
  getWorkspaceDetail,
  listFiles,
  listWorkspaces,
  ownWorkspace,
  readFile,
  selectionFrom,
  updateWorkspace,
  writeFile,
} from './service.js'
import { personalMemory, workspaceMemory, workspaceMemoryDocument } from './memory.js'

export function workspaceRoutes(deps: Deps): Route[] {
  const ready = () => {
    if (!deps.objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
  }
  return [
    {
      method: 'GET',
      path: '/workspaces',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await listWorkspaces(deps.db, ctx.actor!.id) }),
    },
    {
      method: 'POST',
      path: '/workspaces',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{
          name?: string
          skills?: unknown
          mcpServers?: unknown
          skillGroupIds?: unknown
          mcpGroupIds?: unknown
          skill_group_ids?: unknown
          mcp_group_ids?: unknown
        }>()
        const skillGroups = groupIdsOf(body.skillGroupIds ?? body.skill_group_ids)
        const mcpGroups = groupIdsOf(body.mcpGroupIds ?? body.mcp_group_ids)
        const groupIds =
          skillGroups === undefined && mcpGroups === undefined
            ? undefined
            : { skill: skillGroups ?? [], mcp: mcpGroups ?? [] }
        const workspace = await createWorkspace(
          deps.db,
          deps.objects,
          ctx.actor!.id,
          body.name ?? '',
          selectionFrom(body),
          groupIds,
        )
        ctx.send(201, { code: 0, msg: 'ok', data: workspace })
      },
    },
    {
      method: 'GET',
      path: '/workspaces/:id',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await getWorkspaceDetail(deps.db, ctx.actor!.id, ctx.params.id),
        })
      },
    },
    {
      method: 'GET',
      path: '/workspaces/:id/memory',
      auth: 'member',
      handle: async (ctx) => {
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: await workspaceMemory(deps.objects, workspace) })
      },
    },
    {
      method: 'GET',
      path: '/workspaces/:id/memory/documents/:docId',
      auth: 'member',
      handle: async (ctx) => {
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await workspaceMemoryDocument(deps.objects, workspace, ctx.params.docId),
        })
      },
    },
    {
      method: 'GET',
      path: '/me/memory',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: await personalMemory(deps.objects, ctx.actor!.id) })
      },
    },
    {
      method: 'PATCH',
      path: '/workspaces/:id',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ name?: string; archived?: boolean; default?: boolean }>()
        await updateWorkspace(deps.db, ctx.actor!.id, ctx.params.id, body)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'GET',
      path: '/workspaces/:id/files',
      auth: 'member',
      handle: async (ctx) => {
        ready()
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: await listFiles(deps.objects, workspace, ctx.url.searchParams.get('path') ?? '') })
      },
    },
    {
      method: 'GET',
      path: '/workspaces/:id/files/content',
      auth: 'member',
      handle: async (ctx) => {
        ready()
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        ctx.send(200, { code: 0, msg: 'ok', data: await readFile(deps.objects, workspace, ctx.url.searchParams.get('path') ?? '') })
      },
    },
    {
      method: 'PUT',
      path: '/workspaces/:id/files',
      auth: 'member',
      handle: async (ctx) => {
        ready()
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        const body = await ctx.json<{ path?: string; content?: string }>()
        if (body.content === undefined || !body.path) throw new HttpError(422, 'path-required')
        const saved = await writeFile(deps.objects, workspace, body.path, Buffer.from(body.content), 'text/plain; charset=utf-8')
        ctx.send(201, { code: 0, msg: 'ok', data: saved })
      },
    },
    {
      method: 'POST',
      path: '/workspaces/:id/files',
      auth: 'member',
      handle: async (ctx) => {
        ready()
        const workspace = await ownWorkspace(deps.db, ctx.actor!.id, ctx.params.id)
        const name = singleName(ctx.url.searchParams.get('name'))
        const directory = ctx.url.searchParams.get('path') || WORKSPACE_GUEST_ROOT
        const target = directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`
        const bytes = await ctx.raw()
        const saved = await writeFile(deps.objects, workspace, target, bytes, mediaType(ctx.req.headers['content-type']))
        ctx.send(201, { code: 0, msg: 'ok', data: saved })
      },
    },
  ]
}

function mediaType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(';')[0]?.trim() || 'application/octet-stream'
}

function singleName(value: string | null): string {
  const name = value?.trim() ?? ''
  if (!name || name.includes('/') || name === '.' || name === '..') throw new HttpError(422, 'invalid-name')
  return name
}

/** 分组 id 列表：没出现返回 undefined（沿用旧语义），出现就必须是字符串数组。 */
function groupIdsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(422, 'invalid-group-ids')
  }
  return value as string[]
}
