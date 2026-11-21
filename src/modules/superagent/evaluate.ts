/**
 * 接单判断：把「群里这句话算不算活」交给成员自己的模型。
 *
 * 平台只负责凑齐输入（绑定规则、当前话题、已开的工单）并把结论翻译成
 * 平台里的动作；模型调用本身在脑的 `/brain/v1/superagent/evaluate`。
 *
 * 模型出错一律降级为 `unavailable`——宁可回一句「判断不了」，
 * 也不能在没判断出来的时候自己猜一个接单结论。
 *
 * @module platform/modules/superagent/evaluate
 */

import type { BrainClient } from '../../brain/client.js'
import type { ResolvedModel } from '../models/service.js'

/** 发给脑的评估请求；字段由脑的文档固定，多一个都会被拒。 */
export interface EvaluateBody {
  thread: { key: string; kind?: string }
  triggers: Array<{ id: string; text: string }>
  strength: 'explicit' | 'inferred'
  policyVersion: number
  policy: {
    eval?: { mode?: string; timeoutSeconds?: number }
    rules: Array<{ id: string; enabled: boolean; instruction?: string }>
    actions?: Record<string, unknown>
  }
  tickets: Array<{ id: string; stage: string; title: string }>
}

/** 模型的结论。 */
export type EvalOutcome =
  | {
      kind: 'accept'
      title: string
      scope: string
      reason: string
      intentEvidence: string
      rules: string[]
      name?: string
      acknowledgement?: string
    }
  | { kind: 'ignore'; reason?: string; reply?: string }
  | { kind: 'stop'; reason?: string }
  | { kind: 'unavailable'; reason: { code: string; message?: string } }

/** 一次评估的完整结果，用量和版本要落库。 */
export interface EvalResult {
  promptVersion?: string
  model?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number } | null
  outcome: EvalOutcome
}

/** 调用脑做一次评估。传输失败也折算成 `unavailable`，调用方只看 `outcome`。 */
export async function evaluateInbox(
  brain: BrainClient,
  input: { userId: string; model: ResolvedModel; body: EvaluateBody },
): Promise<EvalResult> {
  const response = await brain.evaluate({
    userId: input.userId,
    modelKey: input.model.apiKey,
    modelBaseUrl: input.model.baseUrl,
    modelApi: input.model.api,
    modelId: input.model.modelId,
    modelIds: input.model.modelIds,
    body: input.body,
  })
  if (!response.ok) {
    return { outcome: unavailable(`brain-${response.code}`, `脑返回 ${response.status}`) }
  }
  return normalize(response.value, input.body.strength)
}

/**
 * 把脑的响应收成平台内部形状；乱掉的响应同样算判断不了。
 *
 * 点名 / 单聊（explicit）由人授权，接单不要求引用规则；只有主动判断
 * （inferred）必须落在一条启用的规则上。
 */
export function normalize(value: unknown, strength: 'explicit' | 'inferred' = 'inferred'): EvalResult {
  if (value === null || typeof value !== 'object') {
    return { outcome: unavailable('invalid-response', '响应不是对象') }
  }
  const body = value as {
    promptVersion?: unknown
    model?: { provider?: unknown; model?: unknown }
    usage?: { inputTokens?: unknown; outputTokens?: unknown } | null
    outcome?: unknown
  }
  const result: EvalResult = {
    ...(typeof body.promptVersion === 'string' ? { promptVersion: body.promptVersion } : {}),
    ...(typeof body.model?.provider === 'string' && typeof body.model.model === 'string'
      ? { model: { provider: body.model.provider, model: body.model.model } }
      : {}),
    ...(body.usage === null || body.usage === undefined
      ? {}
      : {
          usage: {
            ...(typeof body.usage.inputTokens === 'number' ? { inputTokens: body.usage.inputTokens } : {}),
            ...(typeof body.usage.outputTokens === 'number' ? { outputTokens: body.usage.outputTokens } : {}),
          },
        }),
    outcome: normalizeOutcome(body.outcome, strength),
  }
  return result
}

function normalizeOutcome(value: unknown, strength: 'explicit' | 'inferred'): EvalOutcome {
  if (value === null || typeof value !== 'object') return unavailable('invalid-response', '缺少结论')
  const outcome = value as Record<string, unknown>
  if (outcome.kind === 'accept') {
    const rules = Array.isArray(outcome.rules) ? outcome.rules.filter((rule): rule is string => typeof rule === 'string') : []
    if (
      typeof outcome.title !== 'string' ||
      typeof outcome.scope !== 'string' ||
      typeof outcome.reason !== 'string' ||
      typeof outcome.intentEvidence !== 'string' ||
      // 主动接活必须有依据；点名直达不看规则。
      (strength === 'inferred' && rules.length === 0)
    ) {
      return unavailable('invalid-response', '接单结论不完整')
    }
    return {
      kind: 'accept',
      title: outcome.title,
      scope: outcome.scope,
      reason: outcome.reason,
      intentEvidence: outcome.intentEvidence,
      rules,
      ...(typeof outcome.name === 'string' ? { name: outcome.name } : {}),
      ...(typeof outcome.acknowledgement === 'string' ? { acknowledgement: outcome.acknowledgement } : {}),
    }
  }
  if (outcome.kind === 'ignore' || outcome.kind === 'stop') {
    return {
      kind: outcome.kind,
      ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
      // 只有 ignore 会附带面向用户的回复；stop 仍用理由本身回信。
      ...(outcome.kind === 'ignore' && typeof outcome.reply === 'string' ? { reply: outcome.reply } : {}),
    }
  }
  if (outcome.kind === 'unavailable') {
    const reason = (outcome.reason ?? {}) as { code?: unknown; message?: unknown }
    return unavailable(
      typeof reason.code === 'string' ? reason.code : 'unknown',
      typeof reason.message === 'string' ? reason.message : undefined,
    )
  }
  return unavailable('invalid-response', '未知的结论类型')
}

function unavailable(code: string, message?: string): EvalOutcome {
  return { kind: 'unavailable', reason: { code, ...(message === undefined ? {} : { message }) } }
}
