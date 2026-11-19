/**
 * `P/remote/<endpoint>`：浏览器 Remote 调用的平台分发面。
 *
 * 官方的 `connection.rpc.call` 被打到 `POST /dsh-api/platform/v1/remote/<endpoint>`，
 * 请求体固定为 `{type:'client-request', rpcId, method, payload:{args}}`，回复固定为
 * `{type:'server-response', rpcId, result:{ok,value|error}}`。
 *
 * 这个分发器的唯一职责是**在平台终结协议**：
 *
 * - 先按 `dsh_sessions` / `dsh_workspaces` 做归属判定，判定失败一律 `session/not-found`
 *   或 `workspace/not-found`，且**不调用脑**（§4.7）。
 * - 平台能自己回答的（会话列表/搜索/改名/队列/快照/模型目录/工作区/上传）平台回答。
 * - 只有脑才知道的原子事实与动作（会话创建、消息、取消、分支、投影、命令、目标、
 *   预设、工作区文件、后台任务）经 `BrainClient` 走 `/brain/v1/*`。
 * - 部署级命名空间（插件、账号、凭证、终端、子代理、宿主路径）一律 `gateway/not-found`。
 *
 * 实时流（`session/follow`、`session/control`、`job/*`、`$events`）不在这里：
 * 它们走 `P/sse/<endpoint>`（见 `sse.ts`），因为需要长连接写出。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from '../../kernel/errors.js'
import type { Db } from '../../kernel/db.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { WORKSPACE_GUEST_ROOT } from '../../kernel/layout.js'
import type { BrainClient } from '../../brain/client.js'
import type { ResolvedModel } from '../../modules/models/service.js'
import { listProviders, resolveModel } from '../../modules/models/service.js'
import { listSkills } from '../../modules/skills/service.js'
import {
  composerCall,
  executeCommand,
  historyPage,
  killJob,
  listSessions,
  openSession,
  ownSession,
  searchSessions,
  updateSession,
  type SessionItem,
} from '../../modules/sessions/service.js'
import { sessionImageAttachment, uploadSessionFile } from '../../modules/sessions/attachment.js'
import { ensureDefaultWorkspace, ownedWorkspace, sessionWorkspace } from '../../modules/workspaces/service.js'
import { interceptWorkspace, viewOf as workspaceView } from '../workspaces.js'
import { scopeSchedule } from '../schedule.js'
import { textOfContent, type QueueService } from './queue.js'
import type { SessionWatchers, WatchFrame } from './watchers.js'
import { appendContiguous, eventRecordOf, tailSeqOf } from './event.js'
import { answerOutcome, sendAnswer, type ForwardedEvents } from './events.js'
import { mapErrorCode, parseRemoteCall, remoteFailed, remoteSucceeded, type RemoteCall } from './wire.js'

/** 分发一次调用所需的全部依赖；`userId` 已由 `surface` 完成登录与成员状态校验。 */
export interface RemoteDeps {
  readonly db: Db
  readonly objects: ObjectStore
  readonly brain: BrainClient
  readonly credentialsKey: Buffer
  readonly userId: string
  readonly queue: QueueService
  readonly watchers: SessionWatchers
  readonly events: ForwardedEvents
}

/** 请求体上限：Remote 参数永远是 JSON，超过 1MB 视为坏请求。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 部署级命名空间：脑是一台所有租户共用的进程，这些接口改的是进程级状态。
 * 浏览器面上它们不存在（§2、§4.4）。平台自己的 `/brain/v1/*` 网关不受影响。
 */
const FORBIDDEN_PREFIXES = [
  'terminal/',
  'subagents/',
  'pluginManager/',
  'pluginMarket/',
  'pluginRegistryProbe/',
  'pluginInventory/',
  'dynamicCordisRunner/',
  'account/',
  'credentials/',
  'mcpManager/',
  'directoryPicker/',
  'officeKit/',
]

/** 宿主机路径操作与桌面端设置写入；改状态必须进沙箱。 */
const FORBIDDEN_ENDPOINTS = new Set([
  'settings/mutate',
  'settings/update',
  'settings/replace',
  'settings/openSettingsDocument',
  'session/openWorkspacePath',
  'session/canOpenWorkspacePath',
  'session/workspacePathApplications',
])

/** 只由 `P/sse` 承载的端点；unary 调用按坏请求拒绝。 */
const STREAM_ONLY = new Set([
  'session/follow',
  'session/control',
  'session/observeEvent',
  'session/observeProjections',
  'session/observeState',
  'remoteAccess/follow',
  'workspace/follow',
  'job/list',
  'job/follow',
  'workspaceFiles/changes',
  'terminal/attach',
  'terminal/retain',
  'terminal/watch',
  'userQuestions/attachWait',
  'account/watch',
  'account/watchExpiry',
  'mcpManager/watch',
  'toolResults/watch',
  'productAnalytics/watchPolicy',
])

export const REMOTE_ENDPOINTS = STREAM_ONLY

/**
 * 处理一次 `POST P/remote/<endpoint>`。
 * 返回 true 表示已经写出响应。
 */
export async function handleRemote(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: string,
  deps: RemoteDeps,
): Promise<boolean> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
    res.end()
    return true
  }
  const raw = await readBody(req).catch(() => undefined)
  if (raw === undefined) {
    writeEnvelope(res, remoteFailed('', 'gateway/bad-request', 'The request body could not be read.'))
    return true
  }
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    writeEnvelope(res, remoteFailed('', 'gateway/bad-request', 'The request body is not JSON.'))
    return true
  }
  const parsed = parseRemoteCall(value, endpoint)
  if (!parsed.ok) {
    writeEnvelope(res, remoteFailed(parsed.rpcId, parsed.code, 'The Remote request is malformed.'))
    return true
  }
  const call = parsed.call
  try {
    const result = await dispatch(call, deps)
    writeEnvelope(res, remoteSucceeded(call.rpcId, result))
  } catch (error) {
    if (error instanceof HttpError) {
      writeEnvelope(res, remoteFailed(call.rpcId, mapErrorCode(error.code), error.code, error.details))
      return true
    }
    writeEnvelope(res, remoteFailed(call.rpcId, 'gateway/internal', error instanceof Error ? error.message : 'internal'))
  }
  return true
}

function writeEnvelope(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'gateway/too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// 参数读取
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>

function object(value: unknown): Args | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : undefined
}

function request(call: RemoteCall): Args {
  return object(object(call.args)?.request) ?? {}
}

function argsOf(call: RemoteCall): Args {
  return object(call.args) ?? {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function notFound(): never {
  throw new HttpError(404, 'not-found')
}

function badRequest(code = 'gateway/bad-request'): never {
  throw new HttpError(400, code)
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

async function dispatch(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const endpoint = call.endpoint
  if (FORBIDDEN_ENDPOINTS.has(endpoint)) {
    throw new HttpError(404, 'gateway/not-found')
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (endpoint.startsWith(prefix)) throw new HttpError(404, 'gateway/not-found')
  }
  if (STREAM_ONLY.has(endpoint)) {
    throw new HttpError(400, 'gateway/bad-request')
  }
  switch (endpoint) {
    // ----- 会话 ---------------------------------------------------------
    case 'session/create':
      return createSession(call, deps)
    case 'session/list':
      return listSessionsValue(call, deps)
    case 'session/page':
    case 'session/events':
      return historyValue(call, deps)
    case 'session/search':
      return searchValue(call, deps)
    case 'session/rename':
      return renameSession(call, deps)
    case 'session/cancel':
      return cancelSession(call, deps)
    case 'session/prompt':
      return promptSession(call, deps)
    case 'session/updateQueue':
      return updateQueue(call, deps)
    case 'session/selectModel':
      return selectModel(call, deps)
    case 'session/state':
      return stateValue(call, deps)
    case 'session/wait':
      return waitValue(call, deps)
    case 'session/projections':
      return projectionsValue(call, deps)
    case 'session/modelCatalog':
      return modelCatalog(call, deps)
    case 'session/initializeDefaultModel':
      return undefined
    case 'session/fork':
      return forkSession(call, deps)
    case 'session/attachment':
      return attachmentValue(call, deps)

    // ----- 工作区 -------------------------------------------------------
    case 'workspace/create':
    case 'workspace/rename':
    case 'workspace/delete':
    case 'workspace/archiveSession':
    case 'workspace/unarchiveSession':
    case 'workspace/insertBefore':
    case 'workspace/insertSessionBefore':
    case 'workspace/pinSession':
    case 'workspace/unpinSession':
      return workspaceMutation(call, deps)
    case 'workspace/initializeDefault':
      return initializeDefaultWorkspace(deps)

    // ----- 工作区文件 ---------------------------------------------------
    case 'workspaceFiles/list':
      return workspaceFiles(call, deps, { action: undefined, bytes: false })
    case 'workspaceFiles/stat':
      return workspaceFiles(call, deps, { action: 'stat', bytes: false })
    case 'workspaceFiles/read':
      return workspaceFiles(call, deps, { action: 'content', bytes: false })
    case 'workspaceFiles/readBytes':
      return workspaceFiles(call, deps, { action: 'content', bytes: true })
    case 'workspaceFiles/search':
      return workspaceSearch(call, deps)
    case 'fileReferences/list':
      return fileReferences(call, deps)

    // ----- 上传与附件 ---------------------------------------------------
    case 'fileUploads/upload':
      return uploadValue(call, deps)

    // ----- 命令 / 目标 / 预设 / 能力目录 --------------------------------
    case 'commands/list':
      return commandsList(call, deps)
    case 'commands/execute':
      return commandExecute(call, deps)
    case 'goals/get':
      return goalsGet(call, deps)
    case 'goals/create':
      return goalsCreate(call, deps)
    case 'goals/edit':
      return goalsEdit(call, deps)
    case 'goals/pause':
    case 'goals/resume':
    case 'goals/complete':
    case 'goals/clear':
      return goalsAction(call, deps)
    case 'agentPresets/list':
      return presetsList(deps)
    case 'agentPresets/read':
      throw new HttpError(404, 'gateway/not-found')
    case 'agentPresets/select':
      return presetSelect(call, deps)
    case 'permissionPresets/catalog':
      return permissionCatalog(deps)
    case 'skills/list':
      return skillsValue(deps)
    case 'session/modelCatalog/providers':
      return providers(call, deps)

    // ----- 反馈 ---------------------------------------------------------
    case 'messageFeedback/list':
    case 'messageFeedback/put':
    case 'messageFeedback/delete':
      return messageFeedback(call, deps)
    case 'sessionFeedback/record':
      return sessionFeedback(call, deps)

    // ----- 任务 ---------------------------------------------------------
    case 'job/kill':
      return jobKill(call, deps)

    // ----- 定时任务 -----------------------------------------------------
    case 'schedule/catalog':
    case 'schedule/list':
    case 'schedule/view':
    case 'schedule/create':
    case 'schedule/edit':
    case 'schedule/run':
    case 'schedule/history':
    case 'schedule/deliveryLimits':
    case 'schedule/deleteInactive':
      return scheduleCall(call, deps)

    // ----- 目录 ---------------------------------------------------------
    case 'llm/listProviders':
    case 'web/listProviders':
      return providerList(call, deps)
    case 'llm/listConfigurableProviders':
      return configurableProviders(call, deps)
    case 'llm/discoverModels':
      return []
    case 'settings/describe':
      return { writable: false, hasDocument: false, namespaces: [] }

    // ----- 分析（桌面端专用） -------------------------------------------
    case 'productAnalytics/enabled':
      return false
    case 'productAnalytics/report':
      return undefined

    // ----- 交互答复（$events 的上行） ------------------------------------
    case '$events/result':
      return eventsResult(call, deps)
    case 'userQuestions/answer':
      return answerQuestion(call, deps)

    default:
      throw new HttpError(404, 'gateway/not-found')
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

async function createSession(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const requested = text(input.workspaceId)
  const workspace = requested === undefined ? undefined : await ownedWorkspace(deps.db, deps.userId, requested)
  const target = workspace ?? await ensureDefaultWorkspace(deps.db, deps.objects, deps.userId)
  await deps.brain.syncWorkspaces(deps.userId)
  const requestedId = text(input.sessionId)
  if (requestedId !== undefined && !/^s_[A-Za-z0-9_-]{1,80}$/.test(requestedId)) {
    throw new HttpError(400, 'session/id-invalid')
  }
  const opened = await openSession(deps.db, deps.objects, deps.brain, deps.credentialsKey, deps.userId, {
    workspaceId: target.id,
    title: '',
    sessionId: requestedId,
  })
  if (opened.createState !== 'ready') throw new HttpError(502, 'session/create-failed')
  return { sessionId: opened.id }
}

function summaryOf(item: SessionItem): Record<string, unknown> {
  return {
    sessionId: item.id,
    agentAvailable: item.status === 'active',
    updatedAt: Date.parse(item.last_active_at) || 0,
    running: item.running,
    blank: item.blank,
    cwd: WORKSPACE_GUEST_ROOT,
  }
}

async function listSessionsValue(_call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const page = await listSessions(deps.db, deps.userId, null, {})
  return { items: page.items.map(summaryOf) }
}

async function searchValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const query = text(request(call).query) ?? ''
  const result = await searchSessions(deps.db, deps.userId, query)
  return {
    items: result.items.map(hit => ({ sessionId: hit.session_id, snippet: hit.snippet })),
    hasMore: result.has_more,
  }
}

async function historyValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const address = object(input.address)
  const sessionId = text(address?.sessionId) ?? text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const through = num(input.throughSeq)
  const beforeSeq = num(input.beforeSeq)
  const maxMessages = num(input.maxMessages)
  const turnWindow = object(input.turnWindow)
  const minMessages = num(turnWindow?.minMessages)
  const minTurns = num(turnWindow?.minTurns)
  // `throughSeq` 是这一页的截断点：日志可能已经写到更后面，但回包的
  // `cursor` 必须等于截断点本身，且末条事件 seq 与之对齐。否则浏览器
  // journal stream 会报 `page did not end at its requested cursor`，
  // 历史加载失败，页面红字，会话像卡住一样等不到回复。
  const page = await historyPage(deps.db, deps.userId, sessionId, {
    before: beforeSeq ?? (through === undefined ? undefined : through + 1),
    ...(maxMessages === undefined ? {} : { maxMessages }),
    ...(minMessages === undefined ? {} : { minMessages }),
    ...(minTurns === undefined ? {} : { minTurns }),
  })
  let events = page.events
  // 修复页要求末条正好是 `throughSeq`。脑先广播后落库，库里可能暂时没有这一
  // 段；用脑的进程内日志补齐。`beforeSeq` 是向前翻旧页，截断点不是 `through`，
  // 不能在这里补。
  if (beforeSeq === undefined && through !== undefined && tailSeqOf(events) < through) {
    const workspaceId = (await ownSession(deps.db, deps.userId, sessionId)).workspaceId
    const backlog = await deps.brain.eventBacklog({
      userId: deps.userId,
      workspaceId,
      sessionId,
      after: tailSeqOf(events),
      until: through,
    }).catch(() => undefined)
    events = appendContiguous(events, backlog?.events ?? [], tailSeqOf(events))
  }
  return {
    // 绝不声称一个页内并不存在的 cursor：补不齐就按实际页尾回，让浏览器
    // 重新修复，而不是收到一页对不上 cursor 的历史。
    cursor: tailSeqOf(events) >= 0 ? tailSeqOf(events) : page.cursor,
    records: events.map(eventRecordOf),
    hasMore: page.has_more,
  }
}

async function renameSession(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const item = await updateSession(deps.db, deps.brain, deps.userId, sessionId, { title: text(input.title) ?? '' })
  const seq = await maxSeq(deps.db, sessionId)
  return { title: item.title, seq }
}

async function cancelSession(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const sessionId = text(request(call).sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const cancelled = await deps.brain.cancel({
    userId: deps.userId,
    workspaceId: record.workspaceId,
    sessionId,
    requestId: call.rpcId === '' ? randomUUID() : call.rpcId,
  })
  if (!cancelled.ok) {
    // 404 收敛成会话不存在；其它一律平台内部错误，脑的业务码留在 details。
    if (cancelled.status === 404) throw new HttpError(404, 'session-not-found', { code: cancelled.code })
    throw new HttpError(502, 'gateway/internal', { code: cancelled.code })
  }
  return { accepted: true }
}

async function promptSession(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  if (record.status !== 'active') throw new HttpError(409, 'session-inactive')
  const body = textOfContent(input.content)
  const requestId = text(input.requestId) ?? (call.rpcId === '' ? randomUUID() : call.rpcId)
  const item = await deps.queue.enqueue({ userId: deps.userId, sessionId, requestId, text: body })
  if (input.mode === 'steer') {
    const steered = await deps.queue.update({ userId: deps.userId, sessionId, itemId: item.itemId, action: 'steer' })
    if (steered.ok) return { accepted: true }
  }
  deps.queue.wake(sessionId)
  return { accepted: true }
}

async function updateQueue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  const itemId = text(input.itemId)
  if (sessionId === undefined || itemId === undefined) badRequest('gateway/bad-request')
  await ownSession(deps.db, deps.userId, sessionId)
  const action = object(input.action)
  const kind = text(action?.kind) ?? text(input.action)
  if (kind !== 'edit' && kind !== 'remove' && kind !== 'steer') badRequest('gateway/bad-request')
  const result = await deps.queue.update({
    userId: deps.userId,
    sessionId,
    itemId,
    action: kind,
    text: textOfContent(action?.content),
  })
  if (!result.ok) throw new HttpError(409, result.code)
  return { accepted: true }
}

async function selectModel(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const model = await resolveModel(deps.db, deps.credentialsKey, deps.userId, text(input.model))
  // 名单外的模型和「还没配置模型」对 UI 是同一件事：去配置，而不是一次失败的调用。
  if (model === undefined) throw new HttpError(422, 'model-config-required')
  const opened = await deps.brain.openSession({
    userId: deps.userId,
    workspaceId: record.workspaceId,
    sessionId,
    cwd: WORKSPACE_GUEST_ROOT,
    modelKey: model.apiKey,
    modelBaseUrl: model.baseUrl,
    modelId: model.modelId,
    modelIds: model.modelIds,
  })
  if (!opened.ok) throw new HttpError(opened.status || 502, opened.code)
  await deps.db.query(
    `UPDATE dsh_sessions SET model_id = $2 WHERE id = $1 AND user_id = $3`,
    [sessionId, model.modelId, deps.userId],
  )
  return { selected: { provider: 'user', model: model.modelId } }
}

function pendingKinds(frames: readonly WatchFrame[]): string[] {
  const kinds: string[] = []
  for (const frame of frames) {
    const kind = text(frame.kind)
    if (kind === 'approval') kinds.push('approval')
    else if (kind === 'questions') kinds.push('question')
    else kinds.push('other')
  }
  return kinds
}

async function stateOf(sessionId: string, deps: RemoteDeps, record?: { status: string }): Promise<Record<string, unknown>> {
  const state = record ?? await ownSession(deps.db, deps.userId, sessionId)
  const items = await deps.queue.items(sessionId)
  return {
    cursor: deps.watchers.cursorOf(sessionId) ?? await maxSeq(deps.db, sessionId),
    active: state.status === 'active',
    running: deps.watchers.statusOf(sessionId)?.running ?? false,
    queue: items.map(item => ({ id: item.id, placement: item.placement, rpcId: item.rpcId, content: item.content })),
    pendingInput: pendingKinds(deps.watchers.pending(sessionId)),
  }
}

async function stateValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const sessionId = text(request(call).sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  return stateOf(sessionId, deps)
}

async function waitValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const afterSeq = num(input.afterSeq)
  const maxMessages = num(input.maxMessages)
  const timeout = Math.min(num(input.timeoutMs) ?? 30_000, 30_000)
  const deadline = Date.now() + Math.max(0, timeout)
  for (;;) {
    const state = await stateOf(sessionId, deps, record)
    if ((state.pendingInput as string[]).length > 0) {
      return { reason: 'input-required', state, output: await outputOf(sessionId, deps, afterSeq, maxMessages) }
    }
    if (state.running !== true) {
      return { reason: 'idle', state, output: await outputOf(sessionId, deps, afterSeq, maxMessages) }
    }
    if (Date.now() >= deadline) {
      return { reason: 'timeout', state, output: await outputOf(sessionId, deps, afterSeq, maxMessages) }
    }
    await delay(250)
  }
}

async function outputOf(
  sessionId: string,
  deps: RemoteDeps,
  afterSeq: number | undefined,
  maxMessages: number | undefined,
): Promise<unknown> {
  if (afterSeq === undefined) return { records: [], truncated: false }
  const page = await historyPage(deps.db, deps.userId, sessionId, {
    after: afterSeq,
    ...(maxMessages === undefined ? {} : { maxMessages }),
  })
  return {
    records: page.events.map(eventRecordOf),
    truncated: page.has_more,
  }
}

async function projectionsValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const sessionId = text(request(call).sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  return composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'GET', '/projections')
}

async function modelCatalog(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const sessionId = text(request(call).sessionId)
  if (sessionId !== undefined) await ownSession(deps.db, deps.userId, sessionId)
  let model: ResolvedModel | undefined
  try {
    model = await resolveModel(deps.db, deps.credentialsKey, deps.userId)
  } catch {
    model = undefined
  }
  if (model === undefined) {
    return { default: { provider: 'user', model: '' }, routableProviders: [], groups: [], failures: [] }
  }
  return {
    default: { provider: 'user', model: model.modelId },
    routableProviders: ['user'],
    groups: [{ id: 'user', name: 'user', models: model.modelIds.map(id => ({ id, name: id })) }],
    failures: [],
  }
}

async function forkSession(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const atSeq = num(input.atSeq)
  const forked = await deps.brain.fork({
    userId: deps.userId,
    workspaceId: record.workspaceId,
    sessionId,
    ...(atSeq === undefined ? {} : { atSeq }),
  })
  if (!forked.ok) throw new HttpError(forked.status || 502, forked.code)
  const created = text(object(forked.value)?.sessionId)
  if (created === undefined) throw new HttpError(502, 'session/fork-failed')
  await deps.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title, preset_id) VALUES ($1, $2, $3, $4, 'client')
     ON CONFLICT (id) DO NOTHING`,
    [created, deps.userId, record.workspaceId, ''],
  )
  return { sessionId: created }
}

async function attachmentValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  const attachment = object(input.attachment)
  const attachmentId = text(attachment?.attachmentId)
  if (sessionId === undefined || attachmentId === undefined) badRequest('gateway/bad-request')
  return sessionImageAttachment(deps.db, deps.objects, deps.userId, sessionId, attachmentId)
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

async function workspaceMutation(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const text_ = await interceptWorkspace(call.endpoint, {
    type: 'client-request',
    rpcId: call.rpcId,
    method: call.endpoint,
    payload: { args: call.args },
  }, { db: deps.db, objects: deps.objects, brain: deps.brain, userId: deps.userId })
  if (text_ === undefined) throw new HttpError(404, 'gateway/not-found')
  const parsed = JSON.parse(text_) as {
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  }
  if (parsed.result?.ok !== true) {
    const error = parsed.result?.error
    // 平台工作区收口把语义码放在 message 里（例如 `invalid-selection`）；
    // `gateway/bad-request` 只表示「这条信封是失败」，不能盖掉真正的语义码。
    // 只有「无空格的语义码」才提升，人类可读的错误句子仍保留原 code。
    const semantic = error?.message !== undefined && /^[a-z][a-z0-9-]*$/u.test(error.message)
    const code = error?.code === 'gateway/bad-request' && semantic ? error.message : error?.code
    throw new HttpError(400, code ?? 'gateway/bad-request')
  }
  return parsed.result.value
}

async function initializeDefaultWorkspace(deps: RemoteDeps): Promise<unknown> {
  const workspace = await ensureDefaultWorkspace(deps.db, deps.objects, deps.userId)
  await deps.brain.syncWorkspaces(deps.userId)
  return { workspaceId: workspace.id }
}

// ---------------------------------------------------------------------------
// 工作区文件
// ---------------------------------------------------------------------------

async function sessionForScope(call: RemoteCall, deps: RemoteDeps): Promise<{ sessionId: string; workspaceId: string }> {
  const sessionId = text(argsOf(call).workspaceFileScopeId) ?? text(argsOf(call).sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  return { sessionId, workspaceId: record.workspaceId }
}

async function workspaceFiles(
  call: RemoteCall,
  deps: RemoteDeps,
  mode: { action: 'content' | 'stat' | undefined; bytes: boolean },
): Promise<unknown> {
  const { sessionId, workspaceId } = await sessionForScope(call, deps)
  const args = argsOf(call)
  const path = text(args.path) ?? ''
  const range = object(args.range)
  const options = object(args.options)
  const search = new URLSearchParams()
  if (path !== '') search.set('path', path)
  if (mode.bytes) {
    search.set('bytes', '1')
    const offset = num(range?.offset) ?? num(options?.range && object(options.range)?.offset)
    const length = num(range?.length) ?? num(object(options?.range)?.length)
    if (offset !== undefined) search.set('offset', String(offset))
    if (length !== undefined) search.set('length', String(length))
  } else if (mode.action === 'content') {
    const offset = num(range?.offset)
    const limit = num(range?.length)
    if (offset !== undefined) search.set('offset', String(offset))
    if (limit !== undefined) search.set('limit', String(limit))
  }
  const result = await deps.brain.workspaceFiles({
    userId: deps.userId,
    workspaceId,
    sessionId,
    action: mode.action,
    search: search.toString(),
  })
  if (!result.ok) throw new HttpError(result.status, result.code)
  return result.value
}

/** 有界递归列举：深度、条目与总字节都设上限，不跑 shell 搜索。 */
async function walkWorkspace(
  deps: RemoteDeps,
  workspaceId: string,
  sessionId: string,
  root: string,
  query: string,
  wantDirectories: boolean,
): Promise<{ matches: Array<{ path: string; type: 'file' | 'directory' }>; truncated: boolean }> {
  const needle = query.trim().toLowerCase()
  const matches: Array<{ path: string; type: 'file' | 'directory' }> = []
  let truncated = false
  const maxEntries = 2_000
  const maxDepth = 8
  let seen = 0
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift() as { path: string; depth: number }
    const search = new URLSearchParams({ path: current.path })
    const listed = await deps.brain.workspaceFiles({
      userId: deps.userId,
      workspaceId,
      sessionId,
      action: undefined,
      search: search.toString(),
    })
    if (!listed.ok) throw new HttpError(listed.status, listed.code)
    const page = object(listed.value)
    const entries = Array.isArray(page?.entries) ? page.entries : []
    for (const raw of entries) {
      seen += 1
      if (seen > maxEntries) {
        truncated = true
        break
      }
      const entry = object(raw)
      if (entry === undefined) continue
      const name = text(entry.name)
      if (name === undefined) continue
      const child = current.path === '' ? name : `${current.path}/${name}`
      const type = entry.type === 'directory' ? 'directory' : 'file'
      const candidate = query.includes('/') ? child.toLowerCase() : name.toLowerCase()
      if (candidate.includes(needle)) matches.push({ path: child, type })
      if (type === 'directory' && current.depth + 1 < maxDepth) queue.push({ path: child, depth: current.depth + 1 })
      if (matches.length >= 200) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }
  if (!wantDirectories) {
    return { matches: matches.filter(match => match.type === 'file'), truncated }
  }
  return { matches, truncated }
}

async function workspaceSearch(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId, workspaceId } = await sessionForScope(call, deps)
  const input = request(call)
  const query = text(input.query) ?? ''
  const { matches, truncated } = await walkWorkspace(deps, workspaceId, sessionId, '', query, false)
  return { matches, truncated, incomplete: false }
}

async function fileReferences(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const sessionId = text(args.agentId) ?? text(args.agent) ?? text(args.sessionId)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const query = text(args.query) ?? ''
  const { matches } = await walkWorkspace(deps, record.workspaceId, sessionId, '', query, true)
  return matches.map(match => ({ path: match.path, kind: match.type }))
}

// ---------------------------------------------------------------------------
// 上传与附件
// ---------------------------------------------------------------------------

async function uploadValue(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const sessionId = text(args.agentId) ?? text(args.agent) ?? text(args.sessionId)
  const input = object(args.request) ?? {}
  const data = text(input.data)
  if (sessionId === undefined || data === undefined) badRequest('gateway/bad-request')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const bytes = Buffer.from(data, 'base64')
  const name = text(input.name) ?? 'upload.bin'
  const stored = await uploadSessionFile(
    deps.db,
    deps.objects,
    deps.credentialsKey,
    deps.userId,
    sessionId,
    name,
    'application/octet-stream',
    bytes,
  )
  void record
  return {
    receiptId: `upload_${randomUUID()}`,
    file: { attachmentId: `ws:${Buffer.from(stored.sandboxPath).toString('base64url')}`, name, bytes: stored.bytes },
  }
}

// ---------------------------------------------------------------------------
// 命令 / 目标 / 预设
// ---------------------------------------------------------------------------

/**
 * 从调用里取会话 id。
 *
 * 不同 Remote 命名空间的线上参数名不同：`goals/*`、`commands/*` 传 `agentId`，
 * `messageFeedback/*`、`sessionFeedback/*` 传 `sessionId`。两种都接受，避免
 * 一个命名空间因为参数名不同就整族 400。
 */
function sessionArg(call: RemoteCall): string | undefined {
  const args = argsOf(call)
  const input = request(call)
  return text(input.sessionId) ?? text(args.sessionId) ?? text(args.agentId) ?? text(args.agent)
}

async function agentSession(call: RemoteCall, deps: RemoteDeps): Promise<{ sessionId: string; record: { id: string; workspaceId: string; status: string; workspaceState: string } }> {
  const sessionId = sessionArg(call)
  if (sessionId === undefined) badRequest('session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  return { sessionId, record }
}

async function commandsList(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  try {
    const value = await composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'GET', '/commands')
    const items = object(value)?.items
    return Array.isArray(items) ? items : []
  } catch (error) {
    if (error instanceof HttpError && error.status === 501) return []
    throw error
  }
}

async function commandExecute(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const args = argsOf(call)
  const line = text(args.line)
  if (line === undefined) badRequest('gateway/bad-request')
  const attachments = Array.isArray(args.submittedAttachments) ? args.submittedAttachments : undefined
  const value = await executeCommand(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, {
    line,
    ...(attachments === undefined ? {} : { attachments }),
  })
  return object(value)?.result
}

async function goalsGet(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const value = await composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'GET', '/goal')
  const goal = object(value)?.goal
  return goal ?? undefined
}

async function goalsCreate(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const view = await composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'PUT', '/goal', request(call))
  const goal = object(view)
  return { ref: { id: text(goal?.id) ?? '', revision: num(goal?.revision) ?? 1 } }
}

async function goalsEdit(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  return composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'PUT', '/goal', request(call))
}

async function goalsAction(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const action = call.endpoint.slice('goals/'.length)
  return composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'POST', `/goal/${action}`, request(call))
}

async function presetsList(deps: RemoteDeps): Promise<unknown> {
  const value = await deps.brain.presets(deps.userId)
  if (!value.ok) throw new HttpError(value.status, value.code)
  const page = object(value.value)
  if (Array.isArray(page?.presets)) return { presets: page.presets }
  if (Array.isArray(value.value)) return { presets: value.value }
  return { presets: [] }
}

async function presetSelect(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const preset = text(argsOf(call).agentPreset)
  if (preset === undefined) badRequest('gateway/bad-request')
  const value = await composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'POST', '/preset', { agentPreset: preset })
  return text(object(value)?.agentPreset) ?? preset
}

async function permissionCatalog(deps: RemoteDeps): Promise<unknown> {
  const value = await deps.brain.permissionPresets(deps.userId)
  if (!value.ok) throw new HttpError(value.status, value.code)
  return value.value
}

async function skillsValue(deps: RemoteDeps): Promise<unknown> {
  const rows = await listSkills(deps.db, deps.userId)
  return {
    skills: rows.map((row) => {
      const value = row as unknown as { name?: unknown; description?: unknown; display_name?: unknown }
      const name = text(value.name) ?? ''
      return {
        name,
        description: text(value.description) ?? text(value.display_name) ?? name,
        modelInvocable: false,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// 反馈
// ---------------------------------------------------------------------------

async function messageFeedback(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  const method = call.endpoint === 'messageFeedback/list'
    ? 'GET'
    : call.endpoint === 'messageFeedback/put' ? 'POST' : 'DELETE'
  return composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, method, '/message-feedback', payloadOf(call))
}

/** 反馈类命名空间把参数平铺在 args 里；`session/*` 则包在 request 里。 */
function payloadOf(call: RemoteCall): Record<string, unknown> {
  const input = request(call)
  return Object.keys(input).length > 0 ? input : argsOf(call)
}

async function sessionFeedback(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const { sessionId } = await agentSession(call, deps)
  return composerCall(deps.db, deps.brain, deps.credentialsKey, deps.userId, sessionId, 'POST', '/feedback', payloadOf(call))
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

async function jobKill(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const input = request(call)
  const sessionId = text(input.sessionId)
  const jobId = text(input.jobId)
  if (sessionId === undefined || jobId === undefined) badRequest('gateway/bad-request')
  return killJob(deps.db, deps.brain, deps.userId, sessionId, jobId)
}

// ---------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------

async function scheduleCall(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const action = call.endpoint.slice('schedule/'.length)
  const scoped = await scopeSchedule(action, {
    type: 'client-request',
    rpcId: call.rpcId,
    method: call.endpoint,
    payload: { args: call.args },
  }, {
    db: deps.db,
    objects: deps.objects,
    brain: deps.brain,
    credentialsKey: deps.credentialsKey,
    userId: deps.userId,
    access: {
      ids: async () => new Set((await listSessions(deps.db, deps.userId, null, { limit: 100 })).items.map(item => item.id)),
      allows: async (id: string) => {
        const rows = await deps.db.query(`SELECT 1 FROM dsh_sessions WHERE id = $1 AND user_id = $2`, [id, deps.userId])
        return rows.rows.length > 0
      },
      foreignAgents: async () => new Set(),
      claim: async () => undefined,
    },
  })
  if ('error' in scoped) throw new HttpError(400, scoped.error.code, scoped.error.details as Record<string, unknown>)
  const forwarded = await deps.brain.call('POST', {
    userId: deps.userId,
    workspaceId: '',
    sessionId: '',
    path: `/brain/v1/schedule/${action}`,
    body: scoped.value,
  })
  if (!forwarded.ok) throw new HttpError(forwarded.status || 502, forwarded.code)
  const envelope = object(forwarded.value)
  const result = object(envelope?.result)
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = object(result.error)
    throw new HttpError(400, text(error?.code) ?? 'schedule/input-invalid')
  }
  return forwarded.value
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

async function providerList(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const sessionScoped = text(args.sessionId) ?? text(request(call).sessionId)
  if (sessionScoped !== undefined) await ownSession(deps.db, deps.userId, sessionScoped)
  const page = await listProviders(deps.db, deps.credentialsKey, deps.userId)
  if (call.endpoint === 'web/listProviders') {
    return { providers: page.providers.map(provider => ({ id: provider.id, title: provider.displayName, description: provider.baseUrl })) }
  }
  return page.providers.map(provider => ({ id: provider.id, name: provider.displayName }))
}

async function configurableProviders(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const sessionScoped = text(args.sessionId) ?? text(request(call).sessionId)
  if (sessionScoped !== undefined) await ownSession(deps.db, deps.userId, sessionScoped)
  const page = await listProviders(deps.db, deps.credentialsKey, deps.userId)
  return page.providers.map(provider => ({ provider: provider.id, displayName: provider.displayName }))
}

function providers(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  return providerList(call, deps)
}

// ---------------------------------------------------------------------------
// 交互答复
// ---------------------------------------------------------------------------

function eventBelongs(eventId: string | undefined, deps: RemoteDeps): { userId: string; sessionId: string } {
  if (eventId === undefined) badRequest('gateway/bad-request')
  const owner = deps.events.owner(eventId)
  if (owner === undefined || owner.userId !== deps.userId) notFound()
  return owner
}

/**
 * 把一个答复交回脑里正在等待的 answerer。
 *
 * 优先在会话 socket 上带内上行：答复和下行是同一条连接，答复一定落在同一条
 * 会话的脑进程上。没有 socket（旧脑版本、入口不承载 Upgrade）时退回 REST。
 * 两条路共用脑上的同一张待答表，`false` 只表示请求已经结算过，按终态处理。
 */
async function settleAnswer(
  deps: RemoteDeps,
  owner: { sessionId: string },
  requestId: string,
  outcome: { kind: 'result'; value: unknown } | { kind: 'rejected'; error: string },
): Promise<void> {
  const inBand = await deps.watchers.answer(owner.sessionId, requestId, outcome)
  if (inBand !== undefined) return
  const workspace = await sessionWorkspace(deps.db, deps.objects, deps.userId, owner.sessionId)
  await sendAnswer(deps.brain, {
    userId: deps.userId,
    workspaceId: workspace.id,
    sessionId: owner.sessionId,
    requestId,
  }, outcome)
}

async function eventsResult(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const eventId = text(args.eventId)
  if (eventId === undefined) badRequest('gateway/bad-request')
  return answerForwardedEvent(deps, eventId, args.outcome)
}

async function answerQuestion(call: RemoteCall, deps: RemoteDeps): Promise<unknown> {
  const args = argsOf(call)
  const callId = text(args.callId)
  if (callId === undefined) badRequest('gateway/bad-request')
  return answerUserQuestion(deps, callId, args.answer)
}

/**
 * 结算 `$events` 上的一张卡片（审批 / 计划评审）。
 *
 * HTTP unary 与浏览器 WSS 的带内上行共用这一条；只按当前成员过滤。
 */
export async function answerForwardedEvent(deps: RemoteDeps, eventId: string, outcome: unknown): Promise<unknown> {
  const owner = eventBelongs(eventId, deps)
  await settleAnswer(deps, owner, eventId, answerOutcome(outcome))
  deps.events.settle(eventId)
  deps.watchers.settle(owner.sessionId, eventId)
  return { accepted: true }
}

/** 结算一次 `userQuestions` 提问；HTTP 与 WSS 共用。 */
export async function answerUserQuestion(deps: RemoteDeps, callId: string, answer: unknown): Promise<unknown> {
  const eventId = deps.events.eventOfCall(callId)
  const owner = eventBelongs(eventId, deps)
  await settleAnswer(deps, owner, eventId as string, { kind: 'result', value: answer })
  deps.events.settle(eventId as string)
  deps.watchers.settle(owner.sessionId, eventId as string)
  return true
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function maxSeq(db: Db, sessionId: string): Promise<number> {
  const rows = await db.query<{ seq: number | string | null }>(
    `SELECT MAX(seq) AS seq FROM dsh_session_events WHERE session_id = $1`,
    [sessionId],
  )
  const value = Number(rows.rows[0]?.seq ?? 0)
  return Number.isFinite(value) ? value : 0
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 供测试与其它面复用：这条路径是不是平台保留的 Remote 面。 */
export function isRemotePath(pathname: string): boolean {
  return pathname.startsWith('/dsh-api/platform/v1/remote/')
}

/** 只读导出，方便测试断言工作区视图形状。 */
export { workspaceView }
