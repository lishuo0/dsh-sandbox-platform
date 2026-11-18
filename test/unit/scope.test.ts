import { describe, expect, it } from 'vitest'
import { failure, requestOf, rpcIdOf, withSessionScope } from '../../src/client/scope.js'

describe('scope 信封工具', () => {
  it('failure 带回业务错误码与 details', () => {
    const frame = JSON.parse(failure('rpc-2', 'schedule/input-invalid', 'bad rule', { code: 'invalid_rule' })) as {
      type: string
      rpcId: string
      result: { ok: boolean; error: { code: string; message: string; details: { code: string } } }
    }
    expect(frame.type).toBe('server-response')
    expect(frame.rpcId).toBe('rpc-2')
    expect(frame.result.ok).toBe(false)
    expect(frame.result.error).toEqual({
      code: 'schedule/input-invalid',
      message: 'bad rule',
      details: { code: 'invalid_rule' },
    })
    // 没有 rpcId 时也要能回帧，客户端按 invalid-request 处理。
    expect(JSON.parse(failure(42, 'x', 'y')).rpcId).toBe('invalid-request')
  })

  it('rpcIdOf 只认信封上的字符串 rpcId', () => {
    expect(rpcIdOf({ type: 'client-request', rpcId: 'rpc-3' })).toBe('rpc-3')
    expect(rpcIdOf({ rpcId: 7 })).toBe(7)
    expect(rpcIdOf('text')).toBeUndefined()
    expect(rpcIdOf(null)).toBeUndefined()
  })

  it('withSessionScope 把当前成员的会话范围补进 payload.args', () => {
    const request = {
      type: 'client-request',
      rpcId: 'rpc-list',
      method: 'schedule/list',
      payload: { args: { request: { active: true } } },
    }
    const next = withSessionScope(request, ['s1', 's2']) as typeof request & {
      payload: { args: { request: { active: boolean }; sessionIds: string[] } }
    }
    expect(next.payload.args.sessionIds).toEqual(['s1', 's2'])
    expect(next.payload.args.request).toEqual({ active: true })
    // 原对象不被改写；空范围也要显式落下来（脑据此返回空结果，而不是不过滤）。
    expect((request.payload.args as { sessionIds?: unknown }).sessionIds).toBeUndefined()
    const empty = withSessionScope({ payload: {} }, []) as { payload: { args: { sessionIds: string[] } } }
    expect(empty.payload.args.sessionIds).toEqual([])
  })

  it('requestOf 取出 payload.args.request，缺失时返回 undefined', () => {
    expect(requestOf({ payload: { args: { request: { id: 'sch-1' } } } })).toEqual({ id: 'sch-1' })
    expect(requestOf({ payload: { args: {} } })).toBeUndefined()
    expect(requestOf({ payload: {} })).toBeUndefined()
    expect(requestOf({ payload: { args: { request: 'x' } } })).toBeUndefined()
    expect(requestOf(undefined)).toBeUndefined()
  })
})
