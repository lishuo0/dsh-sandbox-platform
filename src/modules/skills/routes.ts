import type { Deps } from '../../app/deps.js'
import type { RequestCtx, Route } from '../../kernel/http.js'
import {
  deleteSkill,
  getSkill,
  listSkills,
  readSkillFile,
  removeSkillFile,
  saveSkill,
  setSkillEnabled,
  updateSkill,
  writeSkillFile,
  type SkillScope,
} from './service.js'

export function skillRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/skills',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await listSkills(deps.db, ctx.actor!.id) }),
    },
    {
      method: 'POST',
      path: '/skills',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{
          name?: string
          description?: string
          skillMd?: string
          scope?: string
          groupId?: string | null
          group_id?: string | null
        }>()
        const scope = body.scope === 'public' ? 'public' : 'private'
        await saveSkill(deps.db, deps.objects, ctx.actor!, {
          name: body.name ?? '',
          description: body.description ?? '',
          skillMd: body.skillMd ?? '',
          scope,
          groupId: body.groupId ?? body.group_id,
        })
        ctx.send(201, { code: 0, msg: 'ok', data: { name: body.name, scope } })
      },
    },
    {
      method: 'GET',
      path: '/skills/:name',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await getSkill(deps.db, deps.objects, ctx.actor!, ctx.params.name, scopeOf(ctx.url)),
        })
      },
    },
    {
      method: 'PUT',
      path: '/skills/:name',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ description?: string; skillMd?: string; groupId?: string | null; group_id?: string | null }>()
        const scope = scopeOf(ctx.url)
        await updateSkill(deps.db, deps.objects, ctx.actor!, ctx.params.name, scope, {
          description: body.description,
          skillMd: body.skillMd,
          groupId: body.groupId ?? body.group_id,
        })
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'DELETE',
      path: '/skills/:name',
      auth: 'member',
      handle: async (ctx) => {
        await deleteSkill(deps.db, deps.objects, ctx.actor!, ctx.params.name, scopeOf(ctx.url))
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'GET',
      path: '/skills/:name/file',
      auth: 'member',
      handle: async (ctx) => {
        const file = await readSkillFile(
          deps.db,
          deps.objects,
          ctx.actor!,
          ctx.params.name,
          scopeOf(ctx.url),
          pathOf(ctx.url) || 'SKILL.md',
        )
        sendBytes(ctx, file.body, file.contentType)
      },
    },
    {
      method: 'POST',
      path: '/skills/:name/files',
      auth: 'member',
      handle: async (ctx) => {
        const type = ctx.req.headers['content-type']
        const stats = await writeSkillFile(
          deps.db,
          deps.objects,
          ctx.actor!,
          ctx.params.name,
          scopeOf(ctx.url),
          pathOf(ctx.url),
          await ctx.raw(),
          (Array.isArray(type) ? type[0] : type) ?? 'application/octet-stream',
        )
        ctx.send(201, { code: 0, msg: 'ok', data: stats })
      },
    },
    {
      method: 'DELETE',
      path: '/skills/:name/files',
      auth: 'member',
      handle: async (ctx) => {
        const stats = await removeSkillFile(
          deps.db,
          deps.objects,
          ctx.actor!,
          ctx.params.name,
          scopeOf(ctx.url),
          pathOf(ctx.url),
        )
        ctx.send(200, { code: 0, msg: 'ok', data: stats })
      },
    },
    {
      method: 'POST',
      path: '/skills/:name/enable',
      auth: 'member',
      handle: async (ctx) => {
        await setSkillEnabled(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url), true)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'POST',
      path: '/skills/:name/disable',
      auth: 'member',
      handle: async (ctx) => {
        await setSkillEnabled(deps.db, ctx.actor!, ctx.params.name, scopeOf(ctx.url), false)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
  ]
}

function scopeOf(url: URL): SkillScope {
  return url.searchParams.get('scope') === 'public' ? 'public' : 'private'
}

function pathOf(url: URL): string {
  return url.searchParams.get('path') ?? ''
}

function sendBytes(ctx: RequestCtx, body: Buffer, contentType: string): void {
  ctx.res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  ctx.res.end(body)
}
