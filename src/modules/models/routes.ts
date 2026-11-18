import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import type { Route } from '../../kernel/http.js'
import { modelCatalog } from './catalog.js'
import { clearModel, createProvider, deleteProvider, listProviders, updateProvider } from './service.js'
import {
  clearModelApiKey,
  modelApiKeyStatus,
  setModelApiKey,
  tokenPlanStatus,
} from './settings.js'

type ProviderBody = {
  displayName?: string
  baseUrl?: string
  apiKey?: string
  modelIds?: string[]
  defaultModel?: string
}

export function modelRoutes(deps: Deps): Route[] {
  return [
    {
      method: 'GET',
      path: '/models',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await modelCatalog(deps.db, deps.credentialsKey, ctx.actor!.id),
        }),
    },
    {
      method: 'GET',
      path: '/presets',
      auth: 'member',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await brainCatalog(() => deps.brain.presets(ctx.actor!.id)) }),
    },
    {
      method: 'GET',
      path: '/permission-presets',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, { code: 0, msg: 'ok', data: await brainCatalog(() => deps.brain.permissionPresets(ctx.actor!.id)) }),
    },
    {
      method: 'GET',
      path: '/settings/model-api-key',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await modelApiKeyStatus(deps.db, deps.credentialsKey, ctx.actor!.id),
        }),
    },
    {
      method: 'PUT',
      path: '/settings/model-api-key',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ api_key?: unknown; apiKey?: unknown }>()
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await setModelApiKey(
            deps.db,
            deps.credentialsKey,
            ctx.actor!.id,
            body.api_key ?? body.apiKey,
          ),
        })
      },
    },
    {
      method: 'DELETE',
      path: '/settings/model-api-key',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await clearModelApiKey(deps.db, ctx.actor!.id),
        }),
    },
    {
      method: 'GET',
      path: '/settings/token-plan',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await tokenPlanStatus(deps.db, deps.credentialsKey, deps.config, ctx.actor!.id),
        }),
    },
    {
      method: 'POST',
      path: '/settings/token-plan/refresh',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await tokenPlanStatus(deps.db, deps.credentialsKey, deps.config, ctx.actor!.id),
        }),
    },
    {
      method: 'GET',
      path: '/settings/model',
      auth: 'member',
      handle: async (ctx) =>
        ctx.send(200, { code: 0, msg: 'ok', data: await listProviders(deps.db, deps.credentialsKey, ctx.actor!.id) }),
    },
    {
      method: 'POST',
      path: '/settings/model',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<ProviderBody>()
        const data = await createProvider(deps.db, deps.credentialsKey, ctx.actor!.id, {
          displayName: body.displayName,
          baseUrl: body.baseUrl ?? '',
          apiKey: body.apiKey,
          modelIds: body.modelIds ?? [],
          defaultModel: body.defaultModel ?? '',
        })
        ctx.send(200, { code: 0, msg: 'ok', data })
      },
    },
    {
      method: 'PUT',
      path: '/settings/model/:id',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<ProviderBody>()
        const data = await updateProvider(deps.db, deps.credentialsKey, ctx.actor!.id, ctx.params.id, {
          displayName: body.displayName,
          baseUrl: body.baseUrl ?? '',
          apiKey: body.apiKey,
          modelIds: body.modelIds ?? [],
          defaultModel: body.defaultModel ?? '',
        })
        ctx.send(200, { code: 0, msg: 'ok', data })
      },
    },
    {
      method: 'DELETE',
      path: '/settings/model/:id',
      auth: 'member',
      handle: async (ctx) => {
        await deleteProvider(deps.db, ctx.actor!.id, ctx.params.id)
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

type BrainRead<T> = { ok: true; value: T } | { ok: false; status: number; code: string }

/** 脑的预设目录是组合结果；脑没装对应能力时保留 501，其他失败按上游错误回。 */
async function brainCatalog(call: () => Promise<BrainRead<unknown>>): Promise<unknown> {
  const result = await call()
  if (result.ok) return result.value
  throw new HttpError(result.status === 501 ? 501 : 502, result.code)
}
