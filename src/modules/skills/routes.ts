import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { listSkills, saveSkill, setSkillEnabled, type SkillScope } from './service.js'

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
        const body = await ctx.json<{ name?: string; description?: string; skillMd?: string; scope?: string }>()
        await saveSkill(deps.db, deps.objects, ctx.actor!, {
          name: body.name ?? '',
          description: body.description ?? '',
          skillMd: body.skillMd ?? '',
          scope: body.scope === 'public' ? 'public' : 'private',
        })
        ctx.send(201, { code: 0, msg: 'ok', data: { name: body.name, scope: body.scope === 'public' ? 'public' : 'private' } })
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
