import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { clearModel, readModel, saveModel } from './service.js'

export function modelRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/settings/model',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await readModel(deps.db, deps.credentialsKey, ctx.actor!.id) }),
    },
    {
      method: 'PUT',
      path: '/settings/model',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ baseUrl?: string; apiKey?: string; modelIds?: string[]; defaultModel?: string }>()
        await saveModel(deps.db, deps.credentialsKey, ctx.actor!.id, {
          baseUrl: body.baseUrl ?? '',
          apiKey: body.apiKey,
          modelIds: body.modelIds ?? [],
          defaultModel: body.defaultModel ?? '',
        })
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'DELETE',
      path: '/settings/model',
      auth: 'member',
      handle: async (ctx) => {
        await clearModel(deps.db, ctx.actor!.id)
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
  ]
}
