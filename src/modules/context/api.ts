import type { ServerResponse } from 'node:http'
import type { Deps } from '../../app/deps.js'
import { HttpError } from '../../kernel/errors.js'
import { ownSession } from '../sessions/service.js'
import { projectUsage } from './projection.js'
import {
  detail,
  emptyDelta,
  facts,
  heads,
  overview,
  pricingReady,
} from './service.js'

/** `dsh-context` 浏览器半的旧路由由页面里的 fetch 垫片改写到这里。 */
export const CONTEXT_PREFIX = '/dsh-api/platform/v1/context/'

/**
 * `dsh-context` 的浏览器半直接请求平台，不经脑。
 *
 * 响应统一是 `{ok, value, revision?}`；详情类端点先确认会话属于当前成员。
 * 未实现的块返回形状合法的空结果，避免页面整块报错。
 */
export async function handleContext(
  deps: Deps,
  userId: string,
  path: string,
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): Promise<boolean> {
  const endpoint = path.slice(CONTEXT_PREFIX.length)
  const payload = body ?? {}
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  try {
    switch (endpoint) {
      case 'overview':
        return reply(res, 200, {
          ok: true,
          value: await overview(deps.db, userId, payload, pricingReady(deps.config)),
        })
      case 'detail': {
        if (sessionId === '') return notFoundSession(res)
        await ownSession(deps.db, userId, sessionId)
        const result = await detail(deps.db, sessionId)
        return reply(res, 200, {
          ok: true,
          value: payload.head === true ? { head: result.head } : result,
        })
      }
      case 'facts': {
        if (sessionId === '') return notFoundSession(res)
        await ownSession(deps.db, userId, sessionId)
        const parts = Array.isArray(payload.parts)
          ? payload.parts.filter((part): part is string => typeof part === 'string')
          : ['head', 'series']
        return reply(res, 200, { ok: true, value: await facts(deps.db, sessionId, parts) })
      }
      case 'heads': {
        const ids = Array.isArray(payload.ids)
          ? payload.ids.filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        return reply(res, 200, { ok: true, value: await heads(deps.db, userId, ids.slice(0, 64)) })
      }
      case 'delta': {
        if (sessionId === '') return notFoundSession(res)
        await ownSession(deps.db, userId, sessionId)
        return reply(res, 200, { ok: true, value: emptyDelta() })
      }
      case 'commands': {
        if (sessionId === '') return notFoundSession(res)
        await ownSession(deps.db, userId, sessionId)
        return reply(res, 200, { ok: true, value: { atStart: true, commands: [], total: 0 } })
      }
      case 'attachment': {
        if (sessionId === '') return notFoundSession(res)
        await ownSession(deps.db, userId, sessionId)
        return reply(res, 200, { ok: true, value: null })
      }
      case 'skills': {
        if (sessionId !== '') await ownSession(deps.db, userId, sessionId)
        return reply(res, 200, { ok: true, value: { skills: [] } })
      }
      case 'fleet':
        return reply(res, 200, { ok: true, value: fleetValue(sessionId, payload) })
      case 'version':
        return reply(res, 200, {
          ok: true,
          value: { ready: true, failed: false, checkedAt: Date.now(), current: null },
        })
      case 'balance':
        return reply(res, 200, { ok: true, value: { isAvailable: false, balances: [] } })
      case 'backfill':
        // 页面在概览还没投影完时会反复触发；这里顺手推进一小批，不等它结束。
        void projectUsage(deps).catch(() => undefined)
        return reply(res, 200, { ok: true, value: {} })
      case 'recom':
        return reply(res, 200, { ok: true, value: [], degraded: true })
      default:
        return reply(res, 404, {
          ok: false,
          error: { code: 'context/unknown-endpoint', message: `unknown ${endpoint}` },
        })
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return reply(res, 200, {
        ok: false,
        error: { code: 'context/session-not-found', message: 'session not found' },
      })
    }
    return reply(res, 500, {
      ok: false,
      error: {
        code: 'context/failed',
        message: error instanceof Error ? error.message : 'context request failed',
      },
    })
  }
}

function fleetValue(sessionId: string, body: Record<string, unknown>): Record<string, unknown> {
  const batch = body.batch !== null && typeof body.batch === 'object'
    ? body.batch as Record<string, unknown>
    : null
  if (batch !== null) return { rows: {}, missing: [], total: 0 }
  if (body.summary === true && sessionId !== '') {
    return {
      rootId: sessionId,
      detail: { messages: [], truncated: false },
      members: [],
      familySize: 1,
      counts: {},
    }
  }
  return { messages: [], truncated: false }
}

function notFoundSession(res: ServerResponse): boolean {
  return reply(res, 200, {
    ok: false,
    error: { code: 'context/session-not-found', message: 'session not found' },
  })
}

function reply(res: ServerResponse, status: number, payload: Record<string, unknown>): boolean {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
  return true
}
