/**
 * 工单执行：把一张工单变成工作区里的一次会话，跑完再把结果带回群里。
 *
 * 分两步，任何一步中断都能接着跑：
 * 1. 开始——在绑定好的工作区开/复用会话，把工单投进去，记下当前事件游标；
 * 2. 看进度——按游标回放会话事件，等到 `turn/end` 再落结论、回消息。
 *
 * 会话里干活的是脑 + 工作区沙箱，本模块只在平台侧调度。
 *
 * @module platform/modules/superagent/execute
 */

import type { Deps } from '../../app/deps.js'
import type { BrainEvent } from '../../brain/client.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { resolveModel } from '../models/service.js'
import { openSession, postMessage } from '../sessions/service.js'
import {
  bindingById,
  claimAssignments,
  enqueueOutbox,
  finishAssignment,
  patchTicketOutcome,
  renewAssignment,
  requeueAssignment,
  runningAssignments,
  setTicketStage,
  ticketById,
  type ClaimedAssignment,
  type TicketView,
} from './store.js'

/** 群里能看的长摘要；再长就截断，会话里还有完整记录。 */
const REPORT_LIMIT = 1500

/** 一次接单最多试几次；超过就判失败，不无限重试。 */
const MAX_ATTEMPTS = 5

export interface RunDeps {
  db: Deps['db']
  objects: ObjectStore
  brain: Deps['brain']
  credentialsKey: Buffer
}

/** 认领并开始一批工单；返回真正启动了几张。 */
export async function runAssignments(deps: RunDeps, owner: string, limit = 4): Promise<number> {
  const claimed = await claimAssignments(deps.db, owner, limit)
  let started = 0
  for (const assignment of claimed) {
    if (await startAssignment(deps, owner, assignment)) started += 1
  }
  return started
}

/** 看本副本正在跑的工单有没有结束；返回结束了几张。 */
export async function watchAssignments(deps: RunDeps, owner: string): Promise<number> {
  const running = await runningAssignments(deps.db, owner)
  let finished = 0
  for (const assignment of running) {
    if (await watchAssignment(deps, owner, assignment)) finished += 1
  }
  return finished
}

async function startAssignment(deps: RunDeps, owner: string, assignment: ClaimedAssignment): Promise<boolean> {
  const { db } = deps
  const ticket = await ticketById(db, assignment.userId, assignment.ticketId)
  if (ticket === undefined || (ticket.stage !== 'accepted' && ticket.stage !== 'working')) {
    await finishAssignment(db, assignment.id, 'cancelled')
    return false
  }

  const model = await resolveModel(db, deps.credentialsKey, assignment.userId)
  if (model === undefined) {
    // 成员还没配模型：留着这张单，等配上再跑。
    await requeueAssignment(db, assignment.id, 'model-not-configured', 5 * 60_000)
    return false
  }

  const sessionId = ticket.sessionId ?? (await openTicketSession(deps, ticket, assignment.userId))
  if (sessionId === undefined) {
    await fail(deps, ticket, assignment, 'session-create-failed')
    return false
  }
  if (ticket.sessionId === undefined) await setTicketStage(db, ticket.id, 'working', { sessionId })

  const prior = readRun(ticket)
  if (prior.sessionId === sessionId) {
    // 上一轮已经投过、只是没等完（比如进程重启）：从原游标接着看，不重发。
    await renewAssignment(db, assignment.id, owner)
    return true
  }

  // 先记住当前位置，之后只看这之后的事件，免得把旧回合当成这次的结果。
  const position = await deps.brain.eventBacklog({
    userId: assignment.userId,
    workspaceId: ticket.workspaceId,
    sessionId,
    after: 0,
  })
  if (position === undefined) {
    await requeueAssignment(db, assignment.id, 'brain-unreachable', 30_000)
    return false
  }
  const run = { sessionId, cursor: position.cursor, startedAt: new Date().toISOString() }
  await patchTicketOutcome(db, ticket.id, { run })

  const binding = await bindingById(db, assignment.userId, ticket.bindingId)
  const requestId = `ticket.${ticket.id}.${assignment.generation}`
  try {
    const sent = await postMessage(
      db,
      deps.brain,
      deps.credentialsKey,
      assignment.userId,
      sessionId,
      ticketPrompt(ticket, repoOf(binding?.policy)),
      requestId,
    )
    if (sent.status >= 400) {
      await fail(deps, ticket, assignment, `message-${sent.state}`)
      return false
    }
  } catch (error) {
    await fail(deps, ticket, assignment, messageOf(error))
    return false
  }

  await renewAssignment(db, assignment.id, owner)
  return true
}

/** 在工单绑定的工作区里开会话；失败时返回 undefined，由调用方记失败。 */
async function openTicketSession(deps: RunDeps, ticket: TicketView, userId: string): Promise<string | undefined> {
  try {
    const opened = await openSession(deps.db, deps.objects, deps.brain, deps.credentialsKey, userId, {
      workspaceId: ticket.workspaceId,
      title: `工单：${ticket.title}`,
    })
    return opened.status >= 400 ? undefined : opened.id
  } catch {
    // 工作区被归档、模型没配好之类：交给失败处理，不在这一层区分。
    return undefined
  }
}

async function watchAssignment(deps: RunDeps, owner: string, assignment: ClaimedAssignment): Promise<boolean> {
  const { db } = deps
  const ticket = await ticketById(db, assignment.userId, assignment.ticketId)
  if (ticket === undefined) {
    await finishAssignment(db, assignment.id, 'cancelled')
    return true
  }
  if (ticket.stage !== 'working') {
    // 成员已经从「工单任务」里结束/停止了这张单：别再落一次结论把它翻回来。
    await finishAssignment(db, assignment.id, 'cancelled')
    return true
  }
  const run = readRun(ticket)
  if (run.sessionId === undefined) return false

  await renewAssignment(db, assignment.id, owner)
  const backlog = await deps.brain.eventBacklog({
    userId: assignment.userId,
    workspaceId: ticket.workspaceId,
    sessionId: run.sessionId,
    after: run.cursor,
  })
  // 脑暂时不可达就等下一轮；租约续着，不会被别人抢走。
  if (backlog === undefined) return false

  const end = backlog.events.find((event) => event.type === 'turn/end')
  await patchTicketOutcome(db, ticket.id, { run: { ...run, cursor: backlog.cursor } })
  if (end === undefined) return false

  const reason = turnReason(end)
  const summary = summaryOf(backlog.events)
  await settleRun(deps, ticket, assignment, run.sessionId, reason, summary)
  return true
}

async function settleRun(
  deps: RunDeps,
  ticket: TicketView,
  assignment: ClaimedAssignment,
  sessionId: string,
  reason: string,
  summary: string,
): Promise<void> {
  const { db } = deps
  const failed = reason === 'error'
  const interrupted = reason === 'interrupted'
  // 自动合并的单由工作区里的会话自己合；否则留在「已完成待确认」，等人看过再归档。
  const stage = failed ? 'failed' : interrupted ? 'stopped' : ticket.autoMerge ? 'done' : 'review'
  const report = failed
    ? `工单「${ticket.title}」执行失败了${summary === '' ? '。' : `：\n${summary}`}`
    : interrupted
      ? `工单「${ticket.title}」已中止。`
      : `工单「${ticket.title}」做完了${summary === '' ? '。' : `：\n${summary}`}`

  await setTicketStage(db, ticket.id, stage, {
    outcome: { ...ticket.outcome, result: { reason, summary, reportedAt: new Date().toISOString() } },
  })
  await finishAssignment(db, assignment.id, failed ? 'failed' : interrupted ? 'cancelled' : 'succeeded', {
    sessionId,
    ...(failed ? { error: summary === '' ? reason : summary } : {}),
  })
  await replyToThread(db, ticket, assignment.userId, report)
}

async function fail(
  deps: RunDeps,
  ticket: TicketView,
  assignment: ClaimedAssignment,
  error: string,
): Promise<void> {
  // 前几次按退避重试；超过上限才真的判失败，免得一次网络抖动就把单做废。
  if (assignment.attemptCount < MAX_ATTEMPTS) {
    await requeueAssignment(deps.db, assignment.id, error, 30_000 * assignment.attemptCount)
    return
  }
  await setTicketStage(deps.db, ticket.id, 'failed', {
    outcome: { ...ticket.outcome, result: { reason: 'error', summary: error } },
  })
  await finishAssignment(deps.db, assignment.id, 'failed', { error })
  await replyToThread(deps.db, ticket, assignment.userId, `工单「${ticket.title}」没能开工：${error}`)
}

/** 发给会话的工单说明；模型只看得到这些，所以范围要写清楚。 */
export function ticketPrompt(ticket: TicketView, repo: string | undefined): string {
  return [
    '[工单]',
    `标题：${ticket.title}`,
    `范围：${ticket.scope}`,
    `接单理由：${ticket.reason}`,
    `群里的原话：${ticket.intentEvidence}`,
    ...(repo === undefined ? [] : [`仓库：${repo}`]),
    ticket.autoMerge ? '做完可以直接合并到主干。' : '做完先不要合并，留给人看一眼。',
    '改动只落在工作区里，范围之外的事先不做；需要澄清时按最合理的理解往下走。',
    '结束时用几句话说明做了什么、改了哪些文件。',
  ].join('\n')
}

/** 绑定策略里的仓库名（`owner/name`）；没配就不往提示里写。 */
export function repoOf(policy: Record<string, unknown> | undefined): string | undefined {
  const repo = policy?.repo
  return typeof repo === 'string' && repo.trim() !== '' ? repo.trim() : undefined
}

/** 回合结束的原因；不认识的按 completed 处理。 */
function turnReason(event: BrainEvent): string {
  const data = event.data as { reason?: { kind?: unknown } } | null
  const kind = data?.reason?.kind
  return typeof kind === 'string' ? kind : 'completed'
}

/** 这一回合里助手说的最后一句话；群里发全文太吵，只发最后的总结。 */
function summaryOf(events: BrainEvent[]): string {
  const messages = events.filter((event) => event.type === 'assistant/message')
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageTextOf(messages[index] as BrainEvent)
    if (text !== '') return truncate(text)
  }
  return ''
}

function messageTextOf(event: BrainEvent): string {
  const data = event.data as { message?: { content?: unknown } } | null
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        ? [(block as { text: string }).text]
        : [],
    )
    .join('\n')
    .trim()
}

function truncate(text: string): string {
  return text.length <= REPORT_LIMIT ? text : `${text.slice(0, REPORT_LIMIT)}…`
}

function readRun(ticket: TicketView): { sessionId?: string; cursor: number } {
  const run = ticket.outcome.run
  if (run === null || typeof run !== 'object') return { cursor: 0 }
  const { sessionId, cursor } = run as { sessionId?: unknown; cursor?: unknown }
  return {
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    cursor: typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : 0,
  }
}

/** 把执行结论说得回群里；落 outbox 后由发送循环投递。 */
async function replyToThread(db: Deps['db'], ticket: TicketView, userId: string, text: string): Promise<void> {
  const root = threadRoot(ticket)
  await enqueueOutbox(db, {
    userId,
    channelId: ticket.channelId,
    externalChatId: chatOf(ticket.threadKey),
    ...(root === undefined ? {} : { threadRootId: root }),
    kind: 'report',
    text,
  })
}

/** 话题键的左边是群；右边是话题根消息。 */
function chatOf(threadKey: string): string {
  const at = threadKey.indexOf(':')
  return at < 0 ? threadKey : threadKey.slice(0, at)
}

function threadRoot(ticket: TicketView): string | undefined {
  const at = ticket.threadKey.indexOf(':')
  const root = at < 0 ? '' : ticket.threadKey.slice(at + 1)
  return root === '' ? undefined : root
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 每两秒看一次：先开工新排的，再收已经跑完的。 */
export function startExecuteLoop(deps: RunDeps, owner: string, intervalMs = 2000): () => void {
  let stopped = false
  let busy = false
  const timer = setInterval(() => {
    if (stopped || busy) return
    busy = true
    void watchAssignments(deps, owner)
      .then(() => runAssignments(deps, owner))
      .catch((error: unknown) => console.error('superagent execute', messageOf(error)))
      .finally(() => {
        busy = false
      })
  }, intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
