import { describe, expect, it } from 'vitest'
import type { BrainClient } from '../../src/brain/client.js'
import { evaluateInbox, normalize, type EvaluateBody } from '../../src/modules/superagent/evaluate.js'
import type { ResolvedModel } from '../../src/modules/models/service.js'

/**
 * 接单判断的翻译层：模型说什么，平台就照着收；说不清楚的一律当「判断不了」，
 * 绝不在没结论的时候自己猜接不接。
 */

const model: ResolvedModel = {
  baseUrl: 'https://api.example.com/v1',
  api: 'anthropic-messages',
  modelId: 'deepseek-chat',
  modelIds: ['deepseek-chat'],
  apiKey: 'sk-user-key',
}

const body: EvaluateBody = {
  thread: { key: 'oc_1:om_1', kind: 'chat' },
  triggers: [{ id: 'sa_msg_1', text: '[小明] 修一下登录页' }],
  strength: 'explicit',
  policyVersion: 3,
  policy: { eval: { mode: 'auto' }, rules: [{ id: 'r1', enabled: true, instruction: '改前端可以接' }] },
  tickets: [],
}

describe('结论归一', () => {
  it('接单要带齐标题、范围、理由、依据和命中规则', () => {
    const result = normalize({
      promptVersion: 'v1',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      usage: { inputTokens: 10, outputTokens: 5 },
      outcome: {
        kind: 'accept',
        title: '修登录页',
        scope: '只改登录页',
        reason: '明确要求',
        intentEvidence: '「修一下登录页」',
        rules: ['r1'],
        name: '登录页报错',
        acknowledgement: '收到，这就看。',
      },
    })
    expect(result.outcome).toEqual({
      kind: 'accept',
      title: '修登录页',
      scope: '只改登录页',
      reason: '明确要求',
      intentEvidence: '「修一下登录页」',
      rules: ['r1'],
      name: '登录页报错',
      acknowledgement: '收到，这就看。',
    })
    expect(result.promptVersion).toBe('v1')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('主动判断（inferred）接单但缺依据或没引用任何规则，按判断不了处理', () => {
    for (const outcome of [
      { kind: 'accept', title: 't', scope: 's', reason: 'r', intentEvidence: 'e', rules: [] },
      { kind: 'accept', title: 't', scope: 's', reason: 'r', rules: ['r1'] },
      { kind: 'accept', title: 't', scope: 's', reason: 'r', intentEvidence: 'e' },
    ]) {
      expect(normalize({ outcome }, 'inferred').outcome.kind).toBe('unavailable')
    }
  })

  it('点名 / 单聊（explicit）接单不要求引用规则：人已经明确授权', () => {
    const base = { kind: 'accept', title: 't', scope: 's', reason: 'r', intentEvidence: 'e' }
    expect(normalize({ outcome: { ...base, rules: [] } }, 'explicit').outcome).toMatchObject({
      kind: 'accept',
      rules: [],
    })
    // 完全没给 rules 字段也一样接单。
    expect(normalize({ outcome: base }, 'explicit').outcome).toMatchObject({ kind: 'accept', rules: [] })
    // 但结构化字段仍要齐全：缺依据一样判断不了。
    const { intentEvidence: _drop, ...incomplete } = base
    expect(normalize({ outcome: incomplete }, 'explicit').outcome.kind).toBe('unavailable')
  })

  it('evaluateInbox 按请求的强弱判定：explicit 的空规则接单不被误判', async () => {
    const client = {
      evaluate: async () => ({
        ok: true as const,
        value: {
          outcome: {
            kind: 'accept',
            title: 't',
            scope: 's',
            reason: 'r',
            intentEvidence: 'e',
            rules: [],
          },
        },
      }),
    } as unknown as BrainClient
    const explicit = await evaluateInbox(client, { userId: 'u1', model, body: { ...body, strength: 'explicit' } })
    expect(explicit.outcome.kind).toBe('accept')
    const inferred = await evaluateInbox(client, { userId: 'u1', model, body: { ...body, strength: 'inferred' } })
    expect(inferred.outcome.kind).toBe('unavailable')
  })

  it('忽略和停止原样透传理由，忽略额外透传给用户的话', () => {
    expect(normalize({ outcome: { kind: 'ignore', reason: '闲聊' } }).outcome).toEqual({
      kind: 'ignore',
      reason: '闲聊',
    })
    expect(
      normalize({ outcome: { kind: 'ignore', reason: '闲聊', reply: '在的，有什么要我做的直接说。' } }).outcome,
    ).toEqual({ kind: 'ignore', reason: '闲聊', reply: '在的，有什么要我做的直接说。' })
    // stop 只回理由，不认 reply 字段。
    expect(normalize({ outcome: { kind: 'stop', reason: '先停', reply: '别做了' } }).outcome).toEqual({
      kind: 'stop',
      reason: '先停',
    })
  })

  it('形状不对、结论未知、不是对象，都归为判断不了', () => {
    expect(normalize(null).outcome.kind).toBe('unavailable')
    expect(normalize('x').outcome.kind).toBe('unavailable')
    expect(normalize({ outcome: { kind: 'maybe' } }).outcome).toMatchObject({
      kind: 'unavailable',
      reason: { code: 'invalid-response' },
    })
  })
})

describe('调用脑', () => {
  it('用触发消息本人配的模型，把请求原样送过去', async () => {
    const calls: Array<{ userId: string; modelKey: string; modelBaseUrl: string; modelApi?: string; body: unknown }> = []
    const client = {
      evaluate: async (input: { userId: string; modelKey: string; modelBaseUrl: string; modelApi?: string; body: unknown }) => {
        calls.push(input)
        return { ok: true as const, value: { outcome: { kind: 'ignore' } } }
      },
    } as unknown as BrainClient

    const result = await evaluateInbox(client, { userId: 'u1', model, body })
    expect(result.outcome.kind).toBe('ignore')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      userId: 'u1',
      modelKey: 'sk-user-key',
      modelBaseUrl: model.baseUrl,
      // 成员选的协议要传给脑，否则脑会按 OpenAI 兼容去连 Anthropic 端点。
      modelApi: 'anthropic-messages',
      body,
    })
  })

  it('脑不可达或报错时降级为判断不了，带上错误码', async () => {
    const down = { evaluate: async () => ({ ok: false as const, status: 502, code: 'brain-unreachable' }) }
    const result = await evaluateInbox(down as unknown as BrainClient, { userId: 'u1', model, body })
    expect(result.outcome).toMatchObject({ kind: 'unavailable', reason: { code: 'brain-brain-unreachable' } })
  })
})
