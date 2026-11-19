/**
 * 会话级实时面的路径与上行体契约。
 *
 * 浏览器通常走 `P/socket`（成员级 WSS，多条逻辑通道复用）或它的 SSE 回退
 * `P/sse/$mux`；这里保留单会话直连路径 `P/sessions/{id}/stream` 与
 * `POST P/sessions/{id}/answers`，给不经过 mux 的调用方与测试使用。下行帧都
 * 来自脑的会话实时面，形状一致。
 */

/**
 * 会话实时面的前缀；平台只认这两个模板。
 *
 * 前缀直接取 `API_PREFIX` 会形成 `http ↔ surface ↔ mux` 的循环导入（顶层常量
 * 求值期拿不到值），所以这里引用它的字面量等价形式，由测试断言两者一致。
 */
export const SESSION_STREAM_PREFIX = '/dsh-api/platform/v1/sessions/'
const STEM = SESSION_STREAM_PREFIX
const STREAM_SUFFIX = '/stream'
const ANSWERS_SUFFIX = '/answers'

/** 从 pathname 里取会话 id；不是该模板时 undefined。 */
function idAt(pathname: string, suffix: string): string | undefined {
  if (!pathname.startsWith(STEM) || !pathname.endsWith(suffix)) return undefined
  const raw = pathname.slice(STEM.length, pathname.length - suffix.length)
  if (raw === '' || raw.includes('/')) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/** 下行 SSE 路径里的会话 id。 */
export function sessionStreamId(pathname: string): string | undefined {
  return idAt(pathname, STREAM_SUFFIX)
}

/** 平台会话流的完整路径。 */
export function sessionStreamPath(sessionId: string): string {
  return `${STEM}${encodeURIComponent(sessionId)}${STREAM_SUFFIX}`
}

/** 上行答复路径里的会话 id。 */
export function answersSessionId(pathname: string): string | undefined {
  return idAt(pathname, ANSWERS_SUFFIX)
}

/** 平台答复接口的完整路径。 */
export function answersPath(sessionId: string): string {
  return `${STEM}${encodeURIComponent(sessionId)}${ANSWERS_SUFFIX}`
}

/** 一次答复的规范化形状。 */
export interface AnswerBody {
  readonly requestId: string
  readonly outcome:
    | { readonly kind: 'result'; readonly value: unknown }
    | { readonly kind: 'rejected'; readonly error?: string }
}

/**
 * 把浏览器上行体收窄成受限答复。
 *
 * 会话已在路径里；帧里若再点名会话，必须就是这条路径的会话。
 * @param value - 解析后的 JSON body。
 * @param sessionId - 路径里的会话 id。
 * @returns 规范化后的答复，或拒绝原因。
 */
export function parseAnswer(
  value: unknown,
  sessionId: string,
): { ok: true; body: AnswerBody } | { ok: false; code: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'invalid-answer' }
  }
  const body = value as { requestId?: unknown; outcome?: unknown; sessionId?: unknown }
  if (body.sessionId !== undefined && body.sessionId !== sessionId) {
    return { ok: false, code: 'session/mismatch' }
  }
  if (typeof body.requestId !== 'string' || body.requestId === '') {
    return { ok: false, code: 'invalid-answer' }
  }
  const outcome = body.outcome
  if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) {
    return { ok: false, code: 'invalid-answer' }
  }
  const kind = (outcome as { kind?: unknown }).kind
  if (kind === 'result') {
    return {
      ok: true,
      body: {
        requestId: body.requestId,
        outcome: { kind: 'result', value: (outcome as { value?: unknown }).value },
      },
    }
  }
  if (kind === 'rejected') {
    const error = (outcome as { error?: unknown }).error
    return {
      ok: true,
      body: {
        requestId: body.requestId,
        outcome: { kind: 'rejected', ...(typeof error === 'string' ? { error } : {}) },
      },
    }
  }
  return { ok: false, code: 'invalid-answer' }
}
