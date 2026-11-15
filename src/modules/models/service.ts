import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { maskSecret, open, seal } from '../../kernel/seal.js'

const KIND = 'model-api-key'
const NAME = 'default'

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
  apiKey: string
}

export async function readModel(db: Querier, key: Buffer, userId: string): Promise<ModelView> {
  const model = await db.query(`SELECT base_url, api, model_ids, default_model FROM dsh_user_models WHERE user_id = $1`, [userId])
  const row = model.rows[0] as { base_url: string; api: string; model_ids: string[]; default_model: string } | undefined
  const secret = await db.query(`SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    NAME,
  ])
  const ciphertext = secret.rows[0]?.ciphertext as Buffer | undefined
  return {
    configured: Boolean(row && ciphertext),
    baseUrl: row?.base_url ?? '',
    api: row?.api ?? 'openai-completions',
    modelIds: row?.model_ids ?? [],
    defaultModel: row?.default_model ?? '',
    apiKeyMasked: ciphertext ? maskSecret(open(key, ciphertext)) : '',
  }
}

export async function saveModel(
  db: Querier,
  key: Buffer,
  userId: string,
  input: { baseUrl: string; apiKey?: string; modelIds: string[]; defaultModel: string },
): Promise<void> {
  if (!input.baseUrl.startsWith('https://') || !input.modelIds.length || !input.defaultModel) {
    throw new HttpError(422, 'model-config-required')
  }
  if (!input.modelIds.includes(input.defaultModel)) throw new HttpError(422, 'default-model-not-listed')
  const existing = await db.query(`SELECT 1 FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    NAME,
  ])
  if (!input.apiKey && !existing.rowCount) throw new HttpError(422, 'model-config-required')
  await db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET base_url = $2, model_ids = $3, default_model = $4, updated_at = now()`,
    [userId, input.baseUrl, input.modelIds, input.defaultModel],
  )
  if (input.apiKey) {
    await db.query(
      `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
      [userId, KIND, NAME, seal(key, input.apiKey)],
    )
  }
}

export async function clearModel(db: Querier, userId: string): Promise<void> {
  await db.query(`DELETE FROM dsh_user_models WHERE user_id = $1`, [userId])
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2`, [userId, KIND])
}

/** 开会话和投递定时任务时用。选了名单以外的模型就当没配。 */
export async function resolveModel(db: Querier, key: Buffer, userId: string, selected?: string): Promise<ResolvedModel | undefined> {
  const model = await db.query(`SELECT base_url, model_ids, default_model FROM dsh_user_models WHERE user_id = $1`, [userId])
  const row = model.rows[0] as { base_url: string; model_ids: string[]; default_model: string } | undefined
  const secret = await db.query(`SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    NAME,
  ])
  const ciphertext = secret.rows[0]?.ciphertext as Buffer | undefined
  if (!row || !ciphertext) return undefined
  const modelId = selected || row.default_model
  if (!row.model_ids.includes(modelId)) return undefined
  return { baseUrl: row.base_url, modelId, apiKey: open(key, ciphertext) }
}
