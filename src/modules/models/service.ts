import { randomBytes } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { asBuffer, asStringArray } from '../../kernel/row.js'
import { maskSecret, open, seal } from '../../kernel/seal.js'

const KIND = 'model-api-key'

/**
 * 公网地址必须 https：密钥会随每次调用发到那里。本机/内网允许 http，
 * 方便直接接本地起的兼容 OpenAI 服务。
 */
export function normalizeBaseUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) return undefined
  if (!url.hostname || url.username || url.password || url.hash) return undefined
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

function normalizedModelIds(input: string[]): string[] {
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))]
}

function displayNameOf(baseUrl: string, explicit?: string): string {
  const named = explicit?.trim()
  if (named) return named
  try {
    return new URL(baseUrl).hostname || '自定义模型 API'
  } catch {
    return '自定义模型 API'
  }
}

export interface ProviderView {
  id: string
  displayName: string
  baseUrl: string
  api: string
  modelIds: string[]
  defaultModel: string
  apiKeyMasked: string
  configured: boolean
}

export interface ModelsPageView {
  configured: boolean
  providers: ProviderView[]
}

/** @deprecated 单提供商视图；新页面用 {@link ModelsPageView}。 */
export interface ModelView {
  configured: boolean
  baseUrl: string
  api: string
  modelIds: string[]
  defaultModel: string
  apiKeyMasked: string
}

export interface ResolvedModel {
  baseUrl: string
  modelId: string
  /** 这个成员所有提供商的模型并集；脑按它登记客户端可选的模型。 */
  modelIds: string[]
  apiKey: string
}

type ProviderRow = {
  id: string
  user_id: string
  display_name: string
  base_url: string
  api: string
  model_ids: unknown
  default_model: string
  sort_order: number
}

/** 测试/旧数据仍可能只写 `dsh_user_models`；读之前补迁一次。 */
async function ensureProvidersMigrated(db: Querier, userId: string): Promise<void> {
  const existing = await db.query(`SELECT 1 FROM dsh_user_model_providers WHERE user_id = $1 LIMIT 1`, [userId])
  if (existing.rows.length > 0) return
  const legacy = await db.query<{
    base_url: string
    api: string
    model_ids: unknown
    default_model: string
  }>(`SELECT base_url, api, model_ids, default_model FROM dsh_user_models WHERE user_id = $1`, [userId])
  const row = legacy.rows[0]
  if (!row) return
  const id = `mp_legacy_${userId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64)
  await db.query(
    `INSERT INTO dsh_user_model_providers (id, user_id, display_name, base_url, api, model_ids, default_model, sort_order)
     VALUES ($1, $2, '', $3, $4, $5, $6, 0)`,
    [id, userId, row.base_url, row.api || 'openai-completions', row.model_ids, row.default_model],
  )
  const secret = await db.query(
    `SELECT ciphertext, key_version FROM dsh_user_credentials
     WHERE user_id = $1 AND kind = $2 AND name = 'default'`,
    [userId, KIND],
  )
  const cipher = secret.rows[0]
  if (cipher?.ciphertext !== undefined) {
    await db.query(
      `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext, key_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, kind, name) DO NOTHING`,
      [userId, KIND, id, cipher.ciphertext, cipher.key_version ?? 1],
    )
  }
}

export async function listProviders(db: Querier, key: Buffer, userId: string): Promise<ModelsPageView> {
  await ensureProvidersMigrated(db, userId)
  const rows = await db.query<ProviderRow>(
    `SELECT id, user_id, display_name, base_url, api, model_ids, default_model, sort_order
     FROM dsh_user_model_providers
     WHERE user_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [userId],
  )
  const providers: ProviderView[] = []
  for (const row of rows.rows) {
    const secret = await db.query(`SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
      userId,
      KIND,
      row.id,
    ])
    const ciphertext = secret.rows[0]?.ciphertext === undefined ? undefined : asBuffer(secret.rows[0].ciphertext)
    const modelIds = asStringArray(row.model_ids)
    providers.push({
      id: row.id,
      displayName: displayNameOf(row.base_url, row.display_name),
      baseUrl: row.base_url,
      api: row.api || 'openai-completions',
      modelIds,
      defaultModel: row.default_model,
      apiKeyMasked: ciphertext ? maskSecret(open(key, ciphertext)) : '',
      configured: Boolean(ciphertext),
    })
  }
  return { configured: providers.some((item) => item.configured), providers }
}

export async function createProvider(
  db: Querier,
  key: Buffer,
  userId: string,
  input: { displayName?: string; baseUrl: string; apiKey?: string; modelIds: string[]; defaultModel: string },
): Promise<ProviderView> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const modelIds = normalizedModelIds(input.modelIds)
  const defaultModel = (input.defaultModel.trim() || modelIds[0] || '').trim()
  const apiKey = input.apiKey?.trim() ?? ''
  if (!baseUrl || !modelIds.length || !defaultModel) throw new HttpError(422, 'model-config-required')
  if (!modelIds.includes(defaultModel)) throw new HttpError(422, 'default-model-not-listed')
  if (!apiKey) throw new HttpError(422, 'model-api-key-required')
  const id = `mp_${randomBytes(8).toString('hex')}`
  const displayName = input.displayName?.trim() || ''
  const order = await db.query<{ n: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM dsh_user_model_providers WHERE user_id = $1`,
    [userId],
  )
  const sortOrder = Number(order.rows[0]?.n ?? 0)
  await db.query(
    `INSERT INTO dsh_user_model_providers (id, user_id, display_name, base_url, api, model_ids, default_model, sort_order)
     VALUES ($1, $2, $3, $4, 'openai-completions', $5, $6, $7)`,
    [id, userId, displayName, baseUrl, modelIds, defaultModel, sortOrder],
  )
  await db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
    [userId, KIND, id, seal(key, apiKey)],
  )
  const page = await listProviders(db, key, userId)
  const created = page.providers.find((item) => item.id === id)
  if (!created) throw new HttpError(500, 'provider-create-failed')
  return created
}

export async function updateProvider(
  db: Querier,
  key: Buffer,
  userId: string,
  id: string,
  input: { displayName?: string; baseUrl: string; apiKey?: string; modelIds: string[]; defaultModel: string },
): Promise<ProviderView> {
  const existing = await db.query(`SELECT 1 FROM dsh_user_model_providers WHERE id = $1 AND user_id = $2`, [id, userId])
  if (!existing.rowCount) throw new HttpError(404, 'provider-not-found')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const modelIds = normalizedModelIds(input.modelIds)
  const defaultModel = (input.defaultModel.trim() || modelIds[0] || '').trim()
  const apiKey = input.apiKey?.trim() ?? ''
  if (!baseUrl || !modelIds.length || !defaultModel) throw new HttpError(422, 'model-config-required')
  if (!modelIds.includes(defaultModel)) throw new HttpError(422, 'default-model-not-listed')
  const secret = await db.query(`SELECT 1 FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    id,
  ])
  if (!apiKey && !secret.rowCount) throw new HttpError(422, 'model-api-key-required')
  const displayName = input.displayName === undefined ? undefined : input.displayName.trim()
  if (displayName === undefined) {
    await db.query(
      `UPDATE dsh_user_model_providers
       SET base_url = $3, model_ids = $4, default_model = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [id, userId, baseUrl, modelIds, defaultModel],
    )
  } else {
    await db.query(
      `UPDATE dsh_user_model_providers
       SET display_name = $3, base_url = $4, model_ids = $5, default_model = $6, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [id, userId, displayName, baseUrl, modelIds, defaultModel],
    )
  }
  if (apiKey) {
    await db.query(
      `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
      [userId, KIND, id, seal(key, apiKey)],
    )
  }
  const page = await listProviders(db, key, userId)
  const updated = page.providers.find((item) => item.id === id)
  if (!updated) throw new HttpError(404, 'provider-not-found')
  return updated
}

export async function deleteProvider(db: Querier, userId: string, id: string): Promise<void> {
  const existing = await db.query(`SELECT 1 FROM dsh_user_model_providers WHERE id = $1 AND user_id = $2`, [id, userId])
  if (!existing.rowCount) throw new HttpError(404, 'provider-not-found')
  await db.query(`DELETE FROM dsh_user_model_providers WHERE id = $1 AND user_id = $2`, [id, userId])
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [userId, KIND, id])
}

/** 兼容旧单行接口：读第一个已配置提供商。 */
export async function readModel(db: Querier, key: Buffer, userId: string): Promise<ModelView> {
  const page = await listProviders(db, key, userId)
  const row = page.providers.find((item) => item.configured) ?? page.providers[0]
  return {
    configured: Boolean(row?.configured),
    baseUrl: row?.baseUrl ?? '',
    api: row?.api ?? 'openai-completions',
    modelIds: row?.modelIds ?? [],
    defaultModel: row?.defaultModel ?? '',
    apiKeyMasked: row?.apiKeyMasked ?? '',
  }
}

/** 兼容旧单行接口：没有提供商则新建，否则更新第一个。 */
export async function saveModel(
  db: Querier,
  key: Buffer,
  userId: string,
  input: { baseUrl: string; apiKey?: string; modelIds: string[]; defaultModel: string },
): Promise<void> {
  const page = await listProviders(db, key, userId)
  if (page.providers[0]) {
    await updateProvider(db, key, userId, page.providers[0].id, input)
    return
  }
  await createProvider(db, key, userId, input)
}

export async function clearModel(db: Querier, userId: string): Promise<void> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM dsh_user_model_providers WHERE user_id = $1`, [userId])
  for (const row of rows.rows) {
    await deleteProvider(db, userId, row.id)
  }
  await db.query(`DELETE FROM dsh_user_models WHERE user_id = $1`, [userId])
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = 'default'`, [userId, KIND])
}

/** 开会话和投递定时任务时用。选了名单以外的模型就当没配。 */
export async function resolveModel(db: Querier, key: Buffer, userId: string, selected?: string): Promise<ResolvedModel | undefined> {
  const page = await listProviders(db, key, userId)
  const ready = page.providers.filter((item) => item.configured)
  if (!ready.length) return undefined
  const allIds = [...new Set(ready.flatMap((item) => item.modelIds))]
  const modelId = selected || ready[0]!.defaultModel
  const owner = ready.find((item) => item.modelIds.includes(modelId))
  if (!owner || !allIds.includes(modelId)) return undefined
  const secret = await db.query(`SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    owner.id,
  ])
  const ciphertext = secret.rows[0]?.ciphertext === undefined ? undefined : asBuffer(secret.rows[0].ciphertext)
  if (!ciphertext) return undefined
  return { baseUrl: owner.baseUrl, modelId, modelIds: allIds, apiKey: open(key, ciphertext) }
}
