import { describe, expect, it } from 'vitest'
import { HttpError } from '../../src/kernel/errors.js'
import {
  REMOTE_PREFIX,
  SSE_PREFIX,
  argsObject,
  argString,
  failureOf,
  mapErrorCode,
  parseRemoteCall,
  remoteEndpoint,
  remoteFailed,
  remoteSucceeded,
  requestArg,
  sseEndpoint,
} from '../../src/client/mux/wire.js'

/**
 * 平台 Remote 传输的线格式：统一前缀、信封解包、错误映射。
 * 浏览器只认这三个形状，任何偏差都会表现成「点了没反应」。
 */

describe('统一前缀', () => {
  it('只认 P/remote 与 P/sse 下的端点名', () => {
    expect(REMOTE_PREFIX).toBe('/dsh-api/platform/v1/remote/')
    expect(SSE_PREFIX).toBe('/dsh-api/platform/v1/sse/')
    expect(remoteEndpoint('/dsh-api/platform/v1/remote/session/list')).toBe('session/list')
    expect(sseEndpoint('/dsh-api/platform/v1/sse/session/follow')).toBe('session/follow')
  })

  it('前缀之外、含非法字符或空端点都不算', () => {
    expect(remoteEndpoint('/api/session/list')).toBeUndefined()
    expect(remoteEndpoint('/dsh-api/platform/v1/remote/')).toBeUndefined()
    expect(remoteEndpoint('/dsh-api/platform/v1/remote/session//list')).toBeUndefined()
    expect(remoteEndpoint('/dsh-api/platform/v1/remote/session list')).toBeUndefined()
    expect(sseEndpoint('/dsh-api/platform/v1/stream')).toBeUndefined()
  })
})

describe('parseRemoteCall', () => {
  it('解出 rpcId、端点与 args', () => {
    const parsed = parseRemoteCall({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/list',
      payload: { args: { request: { sessionId: 's_1' } } },
    }, 'session/list')
    expect(parsed).toEqual({
      ok: true,
      call: { rpcId: 'rpc-1', endpoint: 'session/list', args: { request: { sessionId: 's_1' } } },
    })
  })

  it('方法名与路径不一致按坏请求处理', () => {
    const parsed = parseRemoteCall({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/prompt',
      payload: {},
    }, 'session/list')
    expect(parsed).toEqual({ ok: false, rpcId: 'rpc-1', code: 'endpoint-mismatch' })
  })

  it('形状不对时没有 rpcId 可用', () => {
    expect(parseRemoteCall(null, 'session/list')).toEqual({ ok: false, rpcId: '', code: 'invalid-request' })
    expect(parseRemoteCall({ type: 'server-response', rpcId: 'x' }, 'session/list'))
      .toEqual({ ok: false, rpcId: '', code: 'invalid-request' })
  })
})

describe('参数与信封', () => {
  it('argsObject / argString / requestArg 只取合法值', () => {
    const args = { request: { sessionId: 's_1' }, line: '/compact', bad: 3 }
    expect(requestArg(args)).toEqual({ sessionId: 's_1' })
    expect(argString(args, 'line')).toBe('/compact')
    expect(argString(args, 'bad')).toBeUndefined()
    expect(argsObject(args, 'missing')).toEqual({})
  })

  it('成功/失败信封都是 server-response', () => {
    expect(JSON.parse(remoteSucceeded('rpc-1', { accepted: true }))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { accepted: true } },
    })
    expect(JSON.parse(remoteFailed('rpc-1', 'session/not-found', 'not found'))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: false, error: { code: 'session/not-found', message: 'not found', details: {} } },
    })
  })
})

describe('错误映射', () => {
  it('内部码变成 UI 认识的族', () => {
    expect(mapErrorCode('not-found')).toBe('session/not-found')
    expect(mapErrorCode('session-not-found')).toBe('session/not-found')
    expect(mapErrorCode('unauthorized')).toBe('gateway/unauthorized')
    expect(mapErrorCode('model-config-required')).toBe('session/model-config-required')
    expect(mapErrorCode('session-inactive')).toBe('session/inactive')
    expect(mapErrorCode('workspace/not-found')).toBe('workspace/not-found')
  })

  it('HttpError 保留状态码，未预期异常收敛成 gateway/internal', () => {
    expect(failureOf(new HttpError(404, 'not-found'))).toEqual({
      code: 'session/not-found',
      message: 'not-found',
      status: 404,
    })
    expect(failureOf(new Error('boom'))).toEqual({ code: 'gateway/internal', message: 'boom', status: 500 })
  })
})
