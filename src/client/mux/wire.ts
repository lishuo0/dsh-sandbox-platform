/**
 * 平台 Remote 传输的线格式：信封、参数解包、错误映射。
 *
 * 浏览器侧 `__DSH_TRANSPORT__` 把官方客户端的 `connection.rpc.call/open` 接到
 * 平台的两个端点：
 *
 * - `POST P/remote/<endpoint>`：普通 RPC，回 `{type:'server-response', rpcId, result}`；
 * - `GET P/sse/<endpoint>`：会话级/单用户的 SSE 流；每帧 `data:` 是一个 JSON。
 *
 * 浏览器默认不逐条开流：`GET P/sse/$mux` 是一条物理 SSE，逻辑流用
 * `POST P/remote/$mux/open`（`{mux, channel, endpoint, payload}`）与
 * `$mux/close`（`{mux, channel}`）在同一信封里开关。物理流上的帧形如
 * `{type:'frame', channel, value}`，另有 `{type:'error'|'end', channel, ...}`。
 * 这样逻辑流再多也只占浏览器的一条同源连接（HTTP/1.1 每源 6 条的限制）。
 *
 * 平台是这个传输唯一的一侧：所有租户判定都在这里先做完，再决定要不要调脑。
 */

import { HttpError } from '../../kernel/errors.js'

export const REMOTE_PREFIX = '/dsh-api/platform/v1/remote/'
export const SSE_PREFIX = '/dsh-api/platform/v1/sse/'

const ENDPOINT = /^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/

/** 从 pathname 里取 `P/remote/<endpoint>` 的端点名；不是该前缀时 undefined。 */
export function remoteEndpoint(pathname: string): string | undefined {
  return endpointAfter(pathname, REMOTE_PREFIX)
}

/** 从 pathname 里取 `P/sse/<endpoint>` 的端点名；不是该前缀时 undefined。 */
export function sseEndpoint(pathname: string): string | undefined {
  return endpointAfter(pathname, SSE_PREFIX)
}

function endpointAfter(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined
  const raw = pathname.slice(prefix.length)
  if (!ENDPOINT.test(raw)) return undefined
  return raw
}

/** 一次浏览器 Remote 调用。 */
export interface RemoteCall {
  readonly rpcId: string
  readonly endpoint: string
  readonly args: Record<string, unknown>
}

/**
 * 解出 `{type:'client-request', rpcId, method, payload:{args}}`。
 *
 * `method` 与路径里的端点必须一致；不一致按坏请求处理，避免一个路径打到别的端点。
 * @param value - 解析后的 JSON 体。
 * @param endpoint - 路径里的端点名。
 */
export function parseRemoteCall(
  value: unknown,
  endpoint: string,
): { ok: true; call: RemoteCall } | { ok: false; rpcId: string; code: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, rpcId: '', code: 'invalid-request' }
  }
  const body = value as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string') {
    return { ok: false, rpcId: '', code: 'invalid-request' }
  }
  if (typeof body.method !== 'string' || body.method !== endpoint) {
    return { ok: false, rpcId: body.rpcId, code: 'endpoint-mismatch' }
  }
  const args = typeof body.payload === 'object' && body.payload !== null && !Array.isArray(body.payload)
    ? (body.payload as { args?: unknown }).args
    : undefined
  return {
    ok: true,
    call: {
      rpcId: body.rpcId,
      endpoint,
      args: typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {},
    },
  }
}

/** 取一个参数对象；缺省按空对象。 */
export function argsObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 取一个字符串参数；缺省或非字符串时 undefined。 */
export function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 取一次调用公共的 `request` 参数（`session/*` 的线上形状）。 */
export function requestArg(args: Record<string, unknown>): Record<string, unknown> {
  return argsObject(args, 'request')
}

/** `result.value` 的成功信封。 */
export function remoteSucceeded(rpcId: string, value: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } })
}

/** `result.error` 的失败信封；`details` 必须是对象。 */
export function remoteFailed(
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details } },
  })
}

/** 把内部异常收窄成 Remote 的失败码；未预期的异常统一 `gateway/internal`。 */
export function failureOf(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HttpError) {
    return { code: mapErrorCode(error.code), message: error.code, status: error.status }
  }
  const message = error instanceof Error ? error.message : 'internal'
  return { code: 'gateway/internal', message, status: 500 }
}

/**
 * 平台错误码到 Remote 错误码的映射。
 *
 * UI 只认 Remote 的错误码族；平台内部的 `not-found` 一律转成
 * `session/not-found` 或调用方指定的前缀，跨成员不暴露存在性。
 */
export function mapErrorCode(code: string): string {
  if (code === 'not-found' || code === 'session-not-found') return 'session/not-found'
  if (code === 'unauthorized') return 'gateway/unauthorized'
  if (code === 'model-config-required') return 'session/model-config-required'
  if (code === 'session-inactive') return 'session/inactive'
  return code
}

/** 只有一个 `{ accepted: true }` 的回执。 */
export const ACCEPTED = { accepted: true } as const

/** 当前请求的成员；`resolveUser` 只验签名，`isActiveUser` 回查成员状态。 */
export interface Caller {
  readonly userId: string
}
