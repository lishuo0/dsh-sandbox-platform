import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { asBuffer } from '../../kernel/row.js'
import { maskSecret, open, seal } from '../../kernel/seal.js'
import type { AppConfig } from '../../config.js'

/**
 * 成员级模型 API Key 和 TokenPlan。
 *
 * Key 用平台的 credentialsKey 加密后落在 `dsh_user_credentials`，任何接口都只
 * 回传脱敏值。TokenPlan 只是读模型目录和余额，不改平台或脑的状态。
 */

const KIND = 'model-api-key'
const NAME = 'default'
const MAX_KEY_BYTES = 4096
const ERROR_LIMIT = 320

export interface ModelApiKeyStatus {
  configured: boolean
  masked?: string
}

export async function modelApiKeyStatus(
  db: Querier,
  key: Buffer,
  userId: string,
): Promise<ModelApiKeyStatus> {
  const apiKey = await readModelApiKey(db, key, userId)
  return apiKey === '' ? { configured: false } : { configured: true, masked: maskModelKey(apiKey) }
}

export async function setModelApiKey(
  db: Querier,
  key: Buffer,
  userId: string,
  raw: unknown,
): Promise<ModelApiKeyStatus> {
  const apiKey = normalizeModelApiKey(raw)
  await db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, name) DO UPDATE SET ciphertext = $4, updated_at = now()`,
    [userId, KIND, NAME, seal(key, apiKey)],
  )
  return { configured: true, masked: maskModelKey(apiKey) }
}

export async function clearModelApiKey(db: Querier, userId: string): Promise<ModelApiKeyStatus> {
  await db.query(`DELETE FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`, [
    userId,
    KIND,
    NAME,
  ])
  return { configured: false }
}

/** TokenPlan 页面用的模型目录和额度快照。 */
export interface TokenPlanStatus {
  configured: boolean
  apiKeyMask?: string
  catalog: TokenPlanModelView[]
  catalogError?: string
  catalogFetchedAt?: string
  balance: TokenPlanBalanceView
  balanceError?: string
  balanceFetchedAt?: string
  defaultModel: string
  applyUrl?: string
}

export interface TokenPlanModelView {
  id: string
  name: string
  model: string
  icon: string
  tier: string
  recommended: boolean
  contextWindow: number
  maxTokens: number
  input: string[]
}

export interface TokenPlanBalanceView {
  limit: number
  used: number
  remaining: number
  usageRatio: number
  cycleStart: string
  cycleEnd: string
  resetAt: string
  reserved: number
  maxModelLimit: number
  maxModelUsed: number
  maxModelRemaining: number
  maxModelUsageRatio: number
}

const EMPTY_BALANCE: TokenPlanBalanceView = {
  limit: 0,
  used: 0,
  remaining: 0,
  usageRatio: 0,
  cycleStart: '',
  cycleEnd: '',
  resetAt: '',
  reserved: 0,
  maxModelLimit: 0,
  maxModelUsed: 0,
  maxModelRemaining: 0,
  maxModelUsageRatio: 0,
}

/** `refresh` 只是页面的重试入口；目录每次都现拉，没有缓存要失效。 */
export async function tokenPlanStatus(
  db: Querier,
  key: Buffer,
  cfg: AppConfig,
  userId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<TokenPlanStatus> {
  const tokenPlan = cfg.tokenPlan
  const apiKey = await readModelApiKey(db, key, userId)
  const status: TokenPlanStatus = {
    configured: apiKey !== '',
    catalog: [],
    balance: { ...EMPTY_BALANCE },
    defaultModel: tokenPlan?.defaultModel?.trim() ?? '',
  }
  if (tokenPlan?.applyUrl?.trim()) status.applyUrl = tokenPlan.applyUrl.trim()
  if (apiKey === '') {
    status.catalogError = '请先配置 API Key。'
    status.balanceError = '请先配置 API Key。'
    return status
  }
  status.apiKeyMask = maskModelKey(apiKey)
  const baseUrl = tokenPlan?.apiBaseUrl?.trim() ?? ''
  if (baseUrl === '') {
    status.catalogError = '当前部署未配置 TokenPlan 接口。'
    status.balanceError = '当前部署未配置 TokenPlan 接口。'
    return status
  }

  const call = options.fetch ?? fetch
  const channel = tokenPlan?.channel?.trim() ?? ''
  const catalogURL = `${baseUrl.replace(/\/+$/, '')}/v1/token-plan/models${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`
  const catalogTask = readTokenPlan(call, catalogURL, apiKey, channel, tokenPlan?.timeoutMs).then(
    (raw) => {
      const catalog = parseCatalog(raw)
      status.catalog = catalog
      status.catalogFetchedAt = new Date().toISOString()
      if (catalog.length === 0) status.catalogError = '当前渠道没有可用模型。'
    },
    (error: unknown) => {
      status.catalogError = sanitize(error, apiKey)
    },
  )
  const balanceTask = readTokenPlan(
    call,
    `${baseUrl.replace(/\/+$/, '')}/v1/token-plan/balance`,
    apiKey,
    '',
    tokenPlan?.balanceTimeoutMs,
  ).then(
    (raw) => {
      status.balance = parseBalance(raw)
      status.balanceFetchedAt = new Date().toISOString()
    },
    (error: unknown) => {
      status.balanceError = sanitize(error, apiKey)
    },
  )
  await Promise.all([catalogTask, balanceTask])
  return status
}

async function readModelApiKey(db: Querier, key: Buffer, userId: string): Promise<string> {
  const rows = await db.query(
    `SELECT ciphertext FROM dsh_user_credentials WHERE user_id = $1 AND kind = $2 AND name = $3`,
    [userId, KIND, NAME],
  )
  const ciphertext = rows.rows[0]?.ciphertext
  if (ciphertext === undefined || ciphertext === null) return ''
  return open(key, asBuffer(ciphertext))
}

/** 只接受一段非空、无空白/控制字符的 key；原样落库前先去掉首尾空白。 */
export function normalizeModelApiKey(raw: unknown): string {
  const apiKey = typeof raw === 'string' ? raw.trim() : ''
  if (apiKey === '' || Buffer.byteLength(apiKey) > MAX_KEY_BYTES) throw new HttpError(422, 'invalid-api-key')
  for (const char of apiKey) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) throw new HttpError(422, 'invalid-api-key')
  }
  return apiKey
}

/** 只露头尾各四位，和参考实现的脱敏规则一致。 */
export function maskModelKey(apiKey: string): string {
  if (apiKey === '') return ''
  if (apiKey.length <= 8) return '****'
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`
}

async function readTokenPlan(
  call: typeof fetch,
  url: string,
  apiKey: string,
  channel: string,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  }
  if (channel) headers['x-agent-channel'] = channel
  let response: Response
  try {
    response = await call(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    })
  } catch {
    throw new Error('请求 TokenPlan 失败')
  }
  const text = await response.text()
  if (!response.ok) {
    let message = ''
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === 'string') message = parsed.message.trim()
    } catch {
      /* 非 JSON 就用状态码 */
    }
    throw new Error(message || `HTTP ${response.status}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('TokenPlan 响应不是 JSON')
  }
}

function parseCatalog(raw: unknown): TokenPlanModelView[] {
  const data = (raw as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const models: TokenPlanModelView[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = text(record.id)
    if (id === '') continue
    const input = Array.isArray(record.input)
      ? record.input.filter((value): value is string => typeof value === 'string' && value !== '')
      : []
    models.push({
      id,
      name: text(record.name) || id,
      model: text(record.model) || id,
      icon: text(record.icon),
      tier: text(record.tier),
      recommended: record.is_recommended === true,
      contextWindow: number(record.context_window),
      maxTokens: number(record.max_output_tokens),
      input: input.length > 0 ? input : ['text', 'image'],
    })
  }
  return models
}

function parseBalance(raw: unknown): TokenPlanBalanceView {
  const data = (raw as { data?: unknown } | null)?.data
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  return {
    limit: number(record.limit),
    used: number(record.used),
    remaining: number(record.remaining),
    usageRatio: number(record.usage_ratio),
    cycleStart: text(record.cycle_start),
    cycleEnd: text(record.cycle_end),
    resetAt: text(record.reset),
    reserved: number(record.reserved),
    maxModelLimit: number(record.max_model_limit),
    maxModelUsed: number(record.max_model_used),
    maxModelRemaining: number(record.max_model_remaining),
    maxModelUsageRatio: number(record.max_model_usage_ratio),
  }
}

/** 上游错误里可能回显 key；落进响应前先替换掉，并截断过长的正文。 */
function sanitize(error: unknown, apiKey: string): string {
  let message = error instanceof Error ? error.message : String(error)
  if (apiKey !== '') {
    message = message.split(apiKey).join('[redacted]')
    if (apiKey.length > 8) message = message.split(apiKey.slice(-4)).join('[redacted]')
  }
  return message.length > ERROR_LIMIT ? message.slice(0, ERROR_LIMIT) : message
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
