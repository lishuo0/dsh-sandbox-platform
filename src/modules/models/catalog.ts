import type { Querier } from '../../kernel/db.js'
import { listProviders } from './service.js'

/**
 * 成员的模型目录（DSH ModelCatalog 形状）。
 *
 * 平台自己按成员的提供商配置拼：一个提供商一组，只列已经配好密钥的。
 * 客户端模型选择器读这个接口，不需要再去脑上问。
 */

export interface ModelCatalogEntry {
  id: string
  name: string
}

export interface ModelCatalogGroup {
  id: string
  name: string
  models: ModelCatalogEntry[]
}

export interface ModelCatalog {
  default?: { provider: string; model: string }
  routableProviders: string[]
  groups: ModelCatalogGroup[]
  failures: unknown[]
}

export async function modelCatalog(db: Querier, key: Buffer, userId: string): Promise<ModelCatalog> {
  const page = await listProviders(db, key, userId)
  const ready = page.providers.filter((provider) => provider.configured && provider.modelIds.length > 0)
  const groups = ready.map((provider) => ({
    id: provider.id,
    name: provider.displayName || provider.id,
    models: provider.modelIds.map((id) => ({ id, name: id })),
  }))
  const first = ready.find((provider) => provider.defaultModel !== '') ?? ready[0]
  return {
    ...(first === undefined ? {} : { default: { provider: first.id, model: first.defaultModel || first.modelIds[0]! } }),
    routableProviders: groups.map((group) => group.id),
    groups,
    failures: [],
  }
}
