/**
 * 定时任务 Remote 调用的平台收口。
 *
 * 页面的 `schedule/*` 参数由平台补上「当前成员的会话范围」再转给脑：脑的
 * `@brain/dsh-schedule-tasks` 不认识租户，按注入的 `sessionIds` 过滤。页面新建
 * 任务时只能选「独立会话」或「每次新建会话」；平台的投递循环只往
 * `dsh_schedule_tasks.session_id` 指向的会话发消息，所以这里先把「独立会话」
 * 落成成员名下的一条真实会话，再把目标改写成 session。`new`（每次投递新建）
 * 平台没有对应的会话生命周期，按输入错误退回，不悄悄换成复用会话。
 */

import type { Db } from '../kernel/db.js'
import { HttpError } from '../kernel/errors.js'
import type { ObjectStore } from '../kernel/objects.js'
import type { BrainClient } from '../brain/client.js'
import { openSession } from '../modules/sessions/service.js'
import type { SessionAccess } from './scope.js'
import { requestOf, withSessionScope } from './scope.js'

export interface ScheduleScopeContext {
  readonly db: Db
  readonly objects: ObjectStore
  readonly brain: BrainClient
  readonly credentialsKey: Buffer
  readonly userId: string
  readonly access: SessionAccess
}

export type ScheduleScopeResult =
  | { readonly value: unknown }
  | { readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }

export async function scopeSchedule(
  action: string,
  parsed: unknown,
  context: ScheduleScopeContext,
): Promise<ScheduleScopeResult> {
  const copy = structuredClone(parsed)
  const request = requestOf(copy)
  const target = request !== undefined && typeof request.target === 'object' && request.target !== null
    ? request.target as { kind?: unknown }
    : undefined
  if (request !== undefined && (action === 'create' || action === 'edit')) {
    if (target?.kind === 'new') {
      return {
        error: {
          code: 'schedule/input-invalid',
          message: 'Creating a fresh Session for every run is not supported here; choose the one-Session target.',
          details: { code: 'invalid_rule' },
        },
      }
    }
    if (target?.kind === 'new_once' || (action === 'create' && target === undefined)) {
      const opened = await openSession(context.db, context.objects, context.brain, context.credentialsKey, context.userId, {
        title: typeof request.title === 'string' ? request.title : '',
      })
      if (opened.createState !== 'ready') {
        return {
          error: { code: 'session/create-failed', message: 'The Session for this scheduled task could not be created.', details: {} },
        }
      }
      await context.access.claim(opened.id)
      request.target = { kind: 'session', sessionId: opened.id }
    }
    // 客户端点名的会话必须是自己的；别人的会话按不存在处理，也不转给脑。
    if ((request.target as { kind?: unknown } | undefined)?.kind === 'session') {
      const sessionId = (request.target as { sessionId?: unknown }).sessionId
      if (typeof sessionId !== 'string' || !(await context.access.allows(sessionId))) {
        return {
          error: {
            code: 'session/not-found',
            message: `session "${typeof sessionId === 'string' ? sessionId : ''}" not found`,
            details: {},
          },
        }
      }
    }
  }
  return { value: withSessionScope(copy, [...await context.access.ids()]) }
}

/** 脑返回的错误码也走平台的错误码映射。 */
export function scheduleInputError(error: unknown): never {
  const http = error instanceof HttpError ? error : undefined
  throw http ?? new HttpError(400, 'schedule/input-invalid')
}
