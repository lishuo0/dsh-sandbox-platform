/**
 * `P/sse/<endpoint>`：浏览器 Remote 流的平台承载面。
 *
 * 官方客户端把 `connection.rpc.open` 接到这里。平台两种承载：
 *
 * - **多路复用（默认）**：一条物理流 `P/sse/$mux`，逻辑流由
 *   `POST P/remote/$mux/open` 打开、`$mux/close` 关闭，帧在物理流上以
 *   `{type:'frame',channel,value}` 分发。浏览器每源只允许 6 条 HTTP/1.1 连接，
 *   而页面同时有 `$events` / `session/follow` / `session/control` /
 *   `workspace/follow` / `remoteAccess/follow` 五条常驻流，再开文件树这类面板
 *   （`workspaceFiles/changes`）就满了，后续 unary 请求（如 `workspaceFiles/list`）
 *   会永久排队。复用到一条物理流后，逻辑流数量不再受连接数限制——这与上游
 *   官方宿主的 WebSocket mux 是同一个设计，只是承载换成 SSE。
 * - **直连兼容**：`P/sse/<endpoint>` 仍可用，给测试与排障用。
 *
 * 平台在**写出响应头之前**完成认人与归属判定：跨成员一律 404，既不开流也
 * 不连脑；只有平台自己的 `/brain/v1/*` 网关会带应用凭据去连脑。
 *
 * 这里合成浏览器侧要的值（与 `@deepseek-ai/dsh-api-gateway` 的流协议逐字段对齐）：
 *
 * - `$events`：`ready {clientId,host}`、`emit {event,args}`、
 *   `waterfall {event,eventId,agentId,request}`、`cancel {eventId}`；
 * - `session/follow`：`snapshot` → `event` / `assistant-stream`；
 * - `session/control`：`baseline` → `projection`；
 * - `session/observeEvent|observeProjections|observeState`；
 * - `workspace/follow`：平台自己的 `dsh_workspaces` / `dsh_sessions` 基线，
 *   与脑无关——跨成员的行不会出现在这条流上；
 * - `job/list|job/follow`（经脑的后台任务 SSE 转发）；
 * - `userQuestions/attachWait`。
 *
 * 交互请求由脑的会话 SSE `waterfall` 帧抬上来：`session/follow` 与 `$events`
 * 都会挂 `watchers`，`$events` 负责把它广播给浏览器并登记 `eventId → 会话` 路由。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrainClient } from '../../brain/client.js'
import type { Db } from '../../kernel/db.js'
import { HttpError } from '../../kernel/errors.js'
import type { ObjectStore } from '../../kernel/objects.js'
import { WORKSPACE_GUEST_ROOT } from '../../kernel/layout.js'
import { historyPage, listSessions, ownSession } from '../../modules/sessions/service.js'
import { workspaceState } from '../workspaces.js'
import { createAssistantStreamRevisions, EMPTY_ASSISTANT_STREAM } from './assistant-stream.js'
import { appendContiguous, eventRecordOf, tailSeqOf } from './event.js'
import { callIdOf, forwardedEventName, type ForwardedEvents } from './events.js'
import type { QueueItemView, QueueService } from './queue.js'
import type { SessionWatchers, WatchFrame } from './watchers.js'
import { mapErrorCode, parseRemoteCall, remoteFailed, remoteSucceeded } from './wire.js'

/** 一条流调用需要的依赖；`userId` 已由 surface 完成登录与成员状态校验。 */
export interface SseDeps {
  readonly db: Db
  readonly objects: ObjectStore
  readonly brain: BrainClient
  readonly userId: string
  readonly queue: QueueService
  readonly watchers: SessionWatchers
  readonly events: ForwardedEvents
}

/** 一条逻辑流的输出口：直连时写到 HTTP 响应，多路复用时写进物理流。 */
type OpenChannel = () => Channel

/** 一个进程内的流运行时：投影缓存、内容流 revision 与 `$events` 共享状态。 */
export interface SseRuntime {
  handle(req: IncomingMessage, res: ServerResponse, endpoint: string, deps: SseDeps): Promise<boolean>
  /** `POST P/remote/$mux/open|$mux/close`：在物理流上开/关逻辑通道。 */
  control(req: IncomingMessage, res: ServerResponse, endpoint: string, deps: SseDeps): Promise<boolean>
  close(): void
}

/** 只由 `P/sse` 承载的端点；其余端点走 unary。 */
const STREAM_ENDPOINTS = new Set([
  '$events',
  'session/follow',
  'session/control',
  'session/observeEvent',
  'session/observeProjections',
  'session/observeState',
  'workspace/follow',
  'job/list',
  'job/follow',
  'userQuestions/attachWait',
  'remoteAccess/follow',
  // 文件树的变更跟随：按工作区沙箱里的 stat 版本轮询，不碰宿主路径。
  'workspaceFiles/changes',
])

/** 部署级命名空间在浏览器面上不存在；与 unary 的禁用表保持一致。 */
const FORBIDDEN = new Set([
  'account/watch',
  'account/watchExpiry',
  'mcpManager/watch',
  'toolResults/watch',
  'productAnalytics/watchPolicy',
  'terminal/attach',
  'terminal/retain',
  'terminal/watch',
])

/** 投影基线在浏览器侧的形状（`SessionProjectionBaseline`）。 */
interface ProjectionBaseline {
  asOfSeq: number
  values: Record<string, unknown>
}

interface ProjectionEntry {
  readonly userId: string
  baseline: ProjectionBaseline
  fetchedAt: number
  inflight: boolean
  dirty: boolean
  timer: NodeJS.Timeout | undefined
  /** 上一次下发的平台队列快照，用来在队列变化时推 `inbox` 投影。 */
  inboxKey?: string
}

interface ControlSink {
  readonly userId: string
  send(frame: unknown): void
}

/** 一条物理 `$mux` 流：归属一个成员，承载任意数量的逻辑通道。 */
interface MuxEntry {
  readonly userId: string
  readonly channel: Channel
  readonly logical: Map<string, Channel>
}

/** 一次 SSE 输出；`close` 在浏览器断开时调用。 */
export interface Channel {
  send(value: unknown): void
  fail(error: unknown): void
  close(): void
  readonly closed: boolean
  onClose(listener: () => void): void
}

const HEARTBEAT_MS = 15_000
const DEFAULT_PAGE = 50
const PROJECTION_TTL_MS = 1_500
/** `workspace/follow` 比对平台表变化的间隔；变更以整帧 `replace` 下发。 */
const WORKSPACE_POLL_MS = 1_000

export function createSseRuntime(): SseRuntime {
  const projections = new Map<string, ProjectionEntry>()
  const controlSinks = new Set<ControlSink>()
  /** 活跃的 `$events` 代次：成员 → 会话订阅（引用由 watchers 统一计数）。 */
  const bridges = new Map<string, Set<string>>()
  /** 活跃的物理 `$mux` 连接；键是随机 id，值绑定打开它的成员。 */
  const muxes = new Map<string, MuxEntry>()

  const projectionOf = async (deps: SseDeps, sessionId: string, workspaceId: string, force: boolean): Promise<ProjectionBaseline> => {
    let entry = projections.get(sessionId)
    if (entry === undefined) {
      entry = { userId: deps.userId, baseline: { asOfSeq: 0, values: {} }, fetchedAt: 0, inflight: false, dirty: false, timer: undefined }
      projections.set(sessionId, entry)
    }
    if (!force && Date.now() - entry.fetchedAt < PROJECTION_TTL_MS) return entry.baseline
    const response = await deps.brain
      .call('GET', { userId: deps.userId, workspaceId, sessionId, path: `/brain/v1/sessions/${encodeURIComponent(sessionId)}/projections` })
      .catch(() => undefined)
    let asOfSeq = entry.baseline.asOfSeq
    let values = entry.baseline.values
    if (response?.ok === true) {
      const page = object(response.value)?.projections
      const seq = num(object(page)?.asOfSeq)
      const next = object(object(page)?.values)
      if (seq !== undefined && next !== undefined) {
        asOfSeq = seq
        values = next
      }
    }
    // `inbox` 是平台队列在客户端视图里的投影：脑的 inbox 正常为空，
    // 排队消息只可能来自 `dsh_session_queue`。
    const items = await deps.queue.items(sessionId).catch(() => [] as QueueItemView[])
    entry.baseline = { asOfSeq, values: { ...values, inbox: inboxView(items) } }
    entry.fetchedAt = Date.now()
    return entry.baseline
  }

  /** 事件落库后刷新投影，把变化广播给该成员的 `session/control` 代次。 */
  const touchProjections = async (deps: SseDeps, sessionId: string, workspaceId: string): Promise<void> => {
    let entry = projections.get(sessionId)
    if (entry === undefined) {
      entry = { userId: deps.userId, baseline: { asOfSeq: 0, values: {} }, fetchedAt: 0, inflight: false, dirty: false, timer: undefined }
      projections.set(sessionId, entry)
    }
    if (entry.inflight) {
      entry.dirty = true
      return
    }
    if (entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry!.timer = undefined
      void (async () => {
        if (entry!.inflight) {
          entry!.dirty = true
          return
        }
        entry!.inflight = true
        const before = entry!.baseline
        const after = await projectionOf(deps, sessionId, workspaceId, true).catch(() => before)
        entry!.inflight = false
        const changes: Array<{ key: string; val: unknown }> = []
        for (const [key, val] of Object.entries(after.values)) {
          if (!sameJson(before.values[key], val)) changes.push({ key, val })
        }
        if (changes.length > 0) {
          for (const sink of controlSinks) {
            if (sink.userId !== entry!.userId) continue
            sink.send({ type: 'projection', sessionId, seq: after.asOfSeq, changes })
          }
        }
        if (entry!.dirty) {
          entry!.dirty = false
          void touchProjections(deps, sessionId, workspaceId)
        }
      })()
    }, 250)
    entry.timer.unref?.()
  }

  /**
   * 把脑的一帧抬成浏览器事件。`$events` 有代次时才需要广播；
   * `waterfall` 由第一帧登记路由，后续代次不重复发卡片。
   */
  const forward = (deps: SseDeps, sessionId: string, frame: WatchFrame): void => {
    if (!deps.events.has(deps.userId)) return
    if (frame.type === 'status') {
      deps.events.emit(deps.userId, { type: 'emit', event: 'api-session/status', args: [sessionId, frame.running === true] })
      return
    }
    if (frame.type === 'event') {
      deps.events.emit(deps.userId, { type: 'emit', event: 'api-session/activity', args: [sessionId, Date.now()] })
      return
    }
    if (frame.type === 'waterfall') {
      const requestId = text(frame.requestId)
      if (requestId === undefined) return
      if (deps.events.owner(requestId) !== undefined) return
      const name = forwardedEventName(frame.kind)
      if (name === undefined) return
      const request = object(frame.request)
      if (request === undefined) return
      const callId = callIdOf(request)
      deps.events.register(requestId, deps.userId, sessionId, callId)
      deps.events.emit(deps.userId, {
        type: 'waterfall',
        event: name,
        eventId: requestId,
        agentId: sessionId,
        request,
      })
      return
    }
    if (frame.type === 'cancel') {
      const requestId = text(frame.requestId)
      if (requestId === undefined) return
      deps.events.settle(requestId)
      deps.events.emit(deps.userId, { type: 'cancel', eventId: requestId })
    }
  }

  /** `$events` 只留守运行中的会话；跨成员不可见是因为列表本来就按成员过滤。 */
  const watchRunning = (deps: SseDeps, watched: Map<string, () => void>): void => {
    void (async () => {
      const page = await listSessions(deps.db, deps.userId, null, { limit: 100 }).catch(() => undefined)
      if (page === undefined) return
      for (const item of page.items) {
        if (!item.running || watched.has(item.id)) continue
        const stop = deps.watchers.watch({ userId: deps.userId, workspaceId: item.workspace_id, sessionId: item.id }, (frame) => {
          forward(deps, item.id, frame)
          if (frame.type === 'event') void touchProjections(deps, item.id, item.workspace_id)
        })
        watched.set(item.id, stop)
      }
    })()
  }

  const handleEvents = (deps: SseDeps, open: OpenChannel): void => {
    const channel = open()
    const clientId = `sse_${randomUUID()}`
    channel.send({ type: 'ready', clientId, host: { home: WORKSPACE_GUEST_ROOT } })
    const detach = deps.events.attach(deps.userId, { clientId, send: value => channel.send(value) })
    const watched = new Map<string, () => void>()
    let members = bridges.get(deps.userId)
    if (members === undefined) {
      members = new Set()
      bridges.set(deps.userId, members)
    }
    members.add(clientId)
    watchRunning(deps, watched)
    const rescan = setInterval(() => {
      watchRunning(deps, watched)
      // 已经不在列表里的运行会话（结束/删除）释放订阅。
      void (async () => {
        const page = await listSessions(deps.db, deps.userId, null, { limit: 100 }).catch(() => undefined)
        if (page === undefined) return
        const alive = new Set(page.items.filter(item => item.running).map(item => item.id))
        for (const [sessionId, stop] of watched) {
          if (alive.has(sessionId)) continue
          stop()
          watched.delete(sessionId)
        }
      })()
    }, 15_000)
    rescan.unref?.()
    channel.onClose(() => {
      clearInterval(rescan)
      for (const stop of watched.values()) stop()
      watched.clear()
      detach()
      members?.delete(clientId)
      if (members?.size === 0) bridges.delete(deps.userId)
    })
  }

  const handleFollow = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const { sessionId, workspaceId } = await scopedSession(deps, payload)
    const request = object(object(payload)?.args)?.request
    const maxMessages = num(object(request)?.maxMessages) ?? DEFAULT_PAGE
    const turnWindow = object(object(request)?.turnWindow)
    const minMessages = num(turnWindow?.minMessages)
    const minTurns = num(turnWindow?.minTurns)
    const page = await historyPage(deps.db, deps.userId, sessionId, {
      maxMessages,
      ...(minMessages === undefined ? {} : { minMessages }),
      ...(minTurns === undefined ? {} : { minTurns }),
    })
    // 开篇 snapshot 的 cursor 必须等于本页最后一条事件；用页内末 seq 而不是
    // 表上 MAX(seq)，避免并发写入把 cursor 推到页外，触发
    // `page did not end at its requested cursor`。
    const pageCursor = tailSeqOf(page.events)
    // 先订阅、后补历史：脑的实时帧在补历史期间先进缓冲区，等 snapshot 发完
    // 再按序放行，不会漏掉两者之间提交的事件。
    let delivering = false
    let lastSeq = pageCursor
    const buffered: WatchFrame[] = []
    // 助手流 revision 用通道本地序号（见 assistant-stream.ts）：脑的计数是
    // Agent 实例级的，平台中途接入拿不到起点，客户端却要求严格 +1。
    const revisions = createAssistantStreamRevisions()
    const handler = (frame: WatchFrame): void => {
      if (frame.type === 'event') {
        const seq = num(frame.seq)
        if (seq !== undefined && seq <= lastSeq) return
        if (seq !== undefined) lastSeq = seq
        channel.send(liveRecord(object(frame.event), seq ?? lastSeq + 1))
        void touchProjections(deps, sessionId, workspaceId)
        forward(deps, sessionId, frame)
        return
      }
      if (frame.type === 'stream') {
        const inner = object(frame.frame)
        if (inner === undefined) return
        const wire = revisions.next(inner)
        channel.send({
          type: 'assistant-stream',
          frame: wire.type === 'start' ? { ...wire, startedAfterSeq: lastSeq } : wire,
        })
        return
      }
      forward(deps, sessionId, frame)
    }
    const stop = deps.watchers.watch({ userId: deps.userId, workspaceId, sessionId }, (frame) => {
      if (!delivering) {
        buffered.push(frame)
        return
      }
      handler(frame)
    })
    // 脑先广播、后按批落库，库里可能还没写到 brain 的日志末尾。只发库里的页，
    // 浏览器会在下一个实时事件处看到 seq 空洞，修复页又读不到未落库的行，
    // 于是 `page did not end at its requested cursor`。这里用脑进程内日志把
    // 页尾补到连续。
    const backlog = await deps.brain.eventBacklog({
      userId: deps.userId,
      workspaceId,
      sessionId,
      after: pageCursor,
    }).catch(() => undefined)
    const records = appendContiguous(page.events, backlog?.events ?? [], pageCursor)
    const snapshotCursor = tailSeqOf(records)
    const snapshotProjections = await projectionOf(deps, sessionId, workspaceId, true)
      .catch(() => ({ asOfSeq: snapshotCursor, values: {} }))
    const rows = await deps.db.query<{ created_at: string }>(
      `SELECT created_at FROM dsh_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, deps.userId],
    )
    const created = Date.parse(rows.rows[0]?.created_at ?? '') || Date.now()
    const channel = open()
    channel.send({
      type: 'snapshot',
      header: { version: 4, id: sessionId, createdAt: created, cwd: WORKSPACE_GUEST_ROOT, isSeeded: false },
      cursor: snapshotCursor,
      records: records.map(recordOf),
      hasMore: page.has_more,
      projections: snapshotProjections,
      assistantStream: EMPTY_ASSISTANT_STREAM,
    })
    lastSeq = snapshotCursor
    delivering = true
    for (const frame of buffered) handler(frame)
    buffered.length = 0
    channel.onClose(stop)
  }

  const handleControl = (deps: SseDeps, open: OpenChannel): void => {
    const channel = open()
    const value: Record<string, ProjectionBaseline> = {}
    for (const [sessionId, entry] of projections) {
      if (entry.userId !== deps.userId) continue
      value[sessionId] = entry.baseline
      entry.inboxKey = JSON.stringify(entry.baseline.values.inbox ?? null)
    }
    channel.send({ type: 'baseline', value: { projections: value } })
    const sink: ControlSink = { userId: deps.userId, send: frame => channel.send(frame) }
    controlSinks.add(sink)
    // 平台队列是进程外状态（`dsh_session_queue`），不会触发脑的事件帧；
    // 这里按秒比对，把变化推成 `inbox` 投影。
    const pump = async (): Promise<void> => {
      for (const [sessionId, entry] of projections) {
        if (entry.userId !== deps.userId) continue
        const items = await deps.queue.items(sessionId).catch(() => [] as QueueItemView[])
        const inbox = inboxView(items)
        const key = JSON.stringify(inbox)
        if (entry.inboxKey === key) continue
        entry.inboxKey = key
        sink.send({ type: 'projection', sessionId, seq: entry.baseline.asOfSeq, changes: [{ key: 'inbox', val: inbox }] })
      }
    }
    const timer = setInterval(() => { void pump() }, 1_000)
    timer.unref?.()
    channel.onClose(() => {
      clearInterval(timer)
      controlSinks.delete(sink)
    })
  }

  const handleObserveEvent = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const { sessionId, workspaceId } = await scopedSession(deps, payload)
    const cursor = await deps.watchers.cursorOf(sessionId) ?? await maxSeq(deps.db, sessionId)
    const channel = open()
    channel.send({ type: 'ready' })
    let lastSeq = cursor
    const stop = deps.watchers.watch({ userId: deps.userId, workspaceId, sessionId }, (frame) => {
      if (frame.type !== 'event') {
        forward(deps, sessionId, frame)
        return
      }
      const seq = num(frame.seq)
      if (seq !== undefined && seq <= lastSeq) return
      if (seq !== undefined) lastSeq = seq
      channel.send(liveRecord(object(frame.event), seq ?? lastSeq + 1))
      void touchProjections(deps, sessionId, workspaceId)
    })
    channel.onClose(stop)
  }

  const handleObserveProjections = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const { sessionId, workspaceId } = await scopedSession(deps, payload)
    const opening = await projectionOf(deps, sessionId, workspaceId, true)
    const channel = open()
    channel.send({ type: 'ready' })
    let last = opening
    const timer = setInterval(() => {
      void (async () => {
        const next = await projectionOf(deps, sessionId, workspaceId, true).catch(() => last)
        const changes: Array<{ key: string; val: unknown }> = []
        for (const [key, val] of Object.entries(next.values)) {
          if (!sameJson(last.values[key], val)) changes.push({ key, val })
        }
        if (changes.length === 0) return
        last = next
        channel.send({ type: 'projection', seq: next.asOfSeq, changes })
      })()
    }, 1_000)
    timer.unref?.()
    channel.onClose(() => clearInterval(timer))
  }

  const handleObserveState = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const { sessionId } = await scopedSession(deps, payload)
    const channel = open()
    let last = ''
    const tick = async (): Promise<void> => {
      const state = await stateOf(deps, sessionId).catch(() => undefined)
      if (channel.closed) return
      if (state !== undefined) {
        const key = JSON.stringify(state)
        if (key !== last) {
          last = key
          channel.send(state)
        }
      }
      setTimeout(() => { void tick() }, 1_000).unref?.()
    }
    void tick()
  }

  /**
   * `remoteAccess/follow`：平台的每个浏览器成员都是自己页面的 owner。
   *
   * 官方客户端挂载 `ctx.remoteAccess` 时会跟这条流，第一帧必须是
   * `{type:'baseline', owner:true}`；owner 之后不会再有增量，渠道只保持打开，
   * 页面卸载断开时由 close 钩子释放。缺了这一帧客户端会在控制台留下 404，
   * 权限判定也拿不到基线。
   */
  const handleRemoteAccessFollow = (open: OpenChannel): void => {
    const channel = open()
    channel.send({ type: 'baseline', owner: true })
  }

  /**
   * 工作区列表流：客户端 `@deepseek-ai/dsh-api-workspace-controller` 只有在收到
   * 第一帧 `baseline` 后才会把 `phase` 从 `pending` 翻成 `ready`——没有这条流，
   * 选择器永远空着、输入框永远停在「选择一个工作区开始」。
   *
   * 数据全部来自平台表（见 `workspaceState`），不经过脑：脑的投影是跨租户共用
   * 的进程内状态，直接转发会泄漏别人的工作区。变更用整帧 `replace` 增量下发，
   * 客户端语义是「替换本代之前的所有状态」，等价于一次全量刷新。
   */
  const handleWorkspaceFollow = async (deps: SseDeps, open: OpenChannel): Promise<void> => {
    const opening = await workspaceState(deps.db, deps.userId)
    const channel = open()
    channel.send({ type: 'baseline', value: opening })
    let last = JSON.stringify(opening)
    const timer = setInterval(() => {
      void (async () => {
        if (channel.closed) return
        const next = await workspaceState(deps.db, deps.userId).catch(() => undefined)
        if (next === undefined || channel.closed) return
        const key = JSON.stringify(next)
        if (key === last) return
        last = key
        channel.send({ type: 'replace', value: next })
      })()
    }, WORKSPACE_POLL_MS)
    timer.unref?.()
    channel.onClose(() => clearInterval(timer))
  }

  const handleJobList = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const { sessionId } = await scopedSession(deps, payload)
    const workspaceId = await workspaceOf(deps, sessionId)
    const channel = open()
    // 后台任务流本身就是常驻流：别处等待它会把 `$mux/open` 的控制请求卡死，
    // 失败通过 `channel.fail` 回给消费方。
    void pumpJobFrames(channel, deps, { userId: deps.userId, workspaceId, sessionId })
  }

  const handleJobFollow = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const args = object(object(payload)?.args) ?? {}
    const request = object(args.request) ?? args
    const sessionId = text(request.sessionId) ?? text(args.sessionId)
    const jobId = text(request.jobId) ?? text(args.jobId)
    if (sessionId === undefined || jobId === undefined) throw new HttpError(400, 'gateway/bad-request')
    const record = await ownSession(deps.db, deps.userId, sessionId)
    const from = num(request.from)
    const channel = open()
    void pumpJobFrames(channel, deps, {
      userId: deps.userId,
      workspaceId: record.workspaceId,
      sessionId,
      jobId,
      ...(from === undefined ? {} : { from }),
    })
  }

  const handleAttachWait = async (deps: SseDeps, open: OpenChannel, payload: unknown): Promise<void> => {
    const args = object(object(payload)?.args) ?? {}
    const sessionId = text(args.agent) ?? text(args.agentId) ?? text(args.sessionId)
    const callId = text(args.callId)
    if (sessionId === undefined || callId === undefined) throw new HttpError(400, 'gateway/bad-request')
    await ownSession(deps.db, deps.userId, sessionId)
    const channel = open()
    const deadline = Date.now() + 120_000
    channel.send({ remainingMs: Math.max(0, deadline - Date.now()) })
    const poll = (): void => {
      if (channel.closed) return
      const pending = deps.watchers.pending(sessionId).some(frame => callIdOf(frame.request) === callId)
      if (!pending) {
        channel.close()
        return
      }
      setTimeout(poll, 500).unref?.()
    }
    setTimeout(poll, 500).unref?.()
  }

  /**
   * `workspaceFiles/changes`：文件树对某个路径的变更跟随。
   *
   * 上游是宿主机 fs watcher；平台里唯一合法的文件面是会话所属工作区的沙箱，
   * 所以这里退化成每秒一次 `stat` 轮询，用沙箱给出的 `version` 判断变化。
   * 帧形状与上游一致：先 `{kind:'ready'}`，之后 `{kind:'change', change}`
   * （`change.absent === true` 表示被删掉）。轮询频率有上限，不影响推理。
   */
  const handleWorkspaceFileChanges = async (
    deps: SseDeps,
    open: OpenChannel,
    payload: unknown,
  ): Promise<void> => {
    const args = object(object(payload)?.args) ?? {}
    const sessionId = text(args.workspaceFileScopeId) ?? text(args.sessionId)
    if (sessionId === undefined) throw new HttpError(400, 'session/id-invalid')
    const record = await ownSession(deps.db, deps.userId, sessionId)
    const path = text(args.path)
    if (path === undefined || path.trim() === '') throw new HttpError(400, 'invalid-path')
    const channel = open()
    let started = false
    let present = false
    let version: string | undefined
    const tick = async (): Promise<void> => {
      if (channel.closed) return
      const search = new URLSearchParams({ path })
      const result = await deps.brain.workspaceFiles({
        userId: deps.userId,
        workspaceId: record.workspaceId,
        sessionId,
        action: 'stat',
        search: search.toString(),
      }).catch(() => undefined)
      const value = result !== undefined && result.ok ? object(result.value) : undefined
      const absolutePath = text(value?.absolutePath) ?? path
      const next = text(value?.version)
      // 只有明确的 404 才算「文件没了」；脑暂时不可达时保持上一状态。
      const absent = result !== undefined && !result.ok && result.status === 404
      if (!started) {
        channel.send({ kind: 'ready' })
        started = true
        present = next !== undefined
        version = next
      } else if (present && absent) {
        channel.send({ kind: 'change', change: { absolutePath, absent: true } })
        present = false
        version = undefined
      } else if (next !== undefined && (!present || next !== version)) {
        channel.send({ kind: 'change', change: { absolutePath, version: next } })
        present = true
        version = next
      }
      setTimeout(() => { void tick() }, 1_000).unref?.()
    }
    void tick()
    channel.onClose(() => undefined)
  }

  /** 逻辑流分发表：直连与 mux 共用同一套端点实现。 */
  const dispatch = async (endpoint: string, deps: SseDeps, payload: unknown, open: OpenChannel): Promise<void> => {
    switch (endpoint) {
      case '$events':
        handleEvents(deps, open)
        return
      case 'session/follow':
        await handleFollow(deps, open, payload)
        return
      case 'session/control':
        handleControl(deps, open)
        return
      case 'session/observeEvent':
        await handleObserveEvent(deps, open, payload)
        return
      case 'session/observeProjections':
        await handleObserveProjections(deps, open, payload)
        return
      case 'session/observeState':
        await handleObserveState(deps, open, payload)
        return
      case 'remoteAccess/follow':
        handleRemoteAccessFollow(open)
        return
      case 'workspace/follow':
        await handleWorkspaceFollow(deps, open)
        return
      case 'job/list':
        await handleJobList(deps, open, payload)
        return
      case 'job/follow':
        await handleJobFollow(deps, open, payload)
        return
      case 'userQuestions/attachWait':
        await handleAttachWait(deps, open, payload)
        return
      case 'workspaceFiles/changes':
        await handleWorkspaceFileChanges(deps, open, payload)
        return
      default:
        throw new HttpError(404, 'gateway/not-found')
    }
  }

  /** 物理流：发一帧 `ready` 带上 mux id，之后所有逻辑帧都带 `channel`。 */
  const handleMux = (req: IncomingMessage, res: ServerResponse, deps: SseDeps): void => {
    const channel = openHttpChannel(req, res)
    const id = `mux_${randomUUID()}`
    const entry: MuxEntry = { userId: deps.userId, channel, logical: new Map() }
    muxes.set(id, entry)
    channel.send({ type: 'ready', mux: id })
    channel.onClose(() => {
      muxes.delete(id)
      for (const logical of entry.logical.values()) logical.close()
      entry.logical.clear()
    })
  }

  /**
   * `POST P/remote/$mux/open|$mux/close`：控制面。
   *
   * 只允许在**自己的**物理流上开通道；逻辑端点必须本身是流端点（`$mux` 自身除外）。
   * 打开失败（归属不符、端点非法）按 Remote 错误信封回，物理流不受影响。
   */
  const handleMuxControl = async (
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: string,
    deps: SseDeps,
  ): Promise<boolean> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
      res.end()
      return true
    }
    const value = await readJsonBody(req).catch(() => undefined)
    if (value === undefined) {
      writeEnvelope(res, remoteFailed('', 'gateway/bad-request', 'The request body is not JSON.'))
      return true
    }
    const parsed = parseRemoteCall(value, endpoint)
    if (!parsed.ok) {
      writeEnvelope(res, remoteFailed(parsed.rpcId, parsed.code, 'The Remote request is malformed.'))
      return true
    }
    const { rpcId, args } = parsed.call
    const muxId = text(args.mux)
    const channelId = text(args.channel)
    if (muxId === undefined || channelId === undefined) {
      writeEnvelope(res, remoteFailed(rpcId, 'gateway/bad-request', 'mux and channel are required.'))
      return true
    }
    const entry = muxes.get(muxId)
    if (entry === undefined || entry.userId !== deps.userId) {
      writeEnvelope(res, remoteFailed(rpcId, 'gateway/not-found', 'The mux stream is not available.'))
      return true
    }
    if (endpoint === '$mux/close') {
      entry.logical.get(channelId)?.close()
      entry.logical.delete(channelId)
      writeEnvelope(res, remoteSucceeded(rpcId, { ok: true }))
      return true
    }
    const inner = text(args.endpoint)
    if (inner === undefined || inner === '$mux' || !STREAM_ENDPOINTS.has(inner)) {
      writeEnvelope(res, remoteFailed(rpcId, 'gateway/bad-request', 'The endpoint is not a stream endpoint.'))
      return true
    }
    if (entry.logical.has(channelId)) {
      writeEnvelope(res, remoteFailed(rpcId, 'gateway/bad-request', 'The channel is already open.'))
      return true
    }
    const logical = createMuxChannel(entry.channel, channelId)
    entry.logical.set(channelId, logical)
    logical.onClose(() => {
      if (entry.logical.get(channelId) === logical) entry.logical.delete(channelId)
    })
    try {
      await dispatch(inner, deps, object(args.payload) ?? { args: {} }, () => logical)
    } catch (error) {
      logical.close()
      entry.logical.delete(channelId)
      if (error instanceof HttpError) {
        writeEnvelope(res, remoteFailed(rpcId, mapErrorCode(error.code), error.code, error.details))
        return true
      }
      writeEnvelope(res, remoteFailed(rpcId, 'gateway/internal', error instanceof Error ? error.message : 'internal'))
      return true
    }
    writeEnvelope(res, remoteSucceeded(rpcId, { ok: true }))
    return true
  }

  return {
    async handle(req, res, endpoint, deps) {
      // 物理多路复用流不是逻辑端点，先于一般的流端点判定。
      if (endpoint === '$mux') {
        if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed')
        handleMux(req, res, deps)
        return true
      }
      if (!STREAM_ENDPOINTS.has(endpoint)) {
        if (FORBIDDEN.has(endpoint)) throw new HttpError(404, 'gateway/not-found')
        throw new HttpError(400, 'gateway/bad-request')
      }
      if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed')
      await dispatch(endpoint, deps, payloadOf(req), () => openHttpChannel(req, res))
      return true
    },
    async control(req, res, endpoint, deps) {
      return handleMuxControl(req, res, endpoint, deps)
    },
    close() {
      controlSinks.clear()
      for (const entry of projections.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
      }
      projections.clear()
      bridges.clear()
      for (const entry of muxes.values()) entry.channel.close()
      muxes.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

async function scopedSession(deps: SseDeps, payload: unknown): Promise<{ sessionId: string; workspaceId: string }> {
  const args = object(object(payload)?.args) ?? {}
  const request = object(args.request) ?? {}
  const address = object(request.address) ?? object(args.address) ?? {}
  const sessionId = text(address.sessionId)
    ?? text(request.sessionId)
    ?? text(args.sessionId)
    ?? text(args.agent)
    ?? text(args.agentId)
  if (sessionId === undefined) throw new HttpError(400, 'session/id-invalid')
  const record = await ownSession(deps.db, deps.userId, sessionId)
  return { sessionId, workspaceId: record.workspaceId }
}

async function workspaceOf(deps: SseDeps, sessionId: string): Promise<string> {
  return (await ownSession(deps.db, deps.userId, sessionId)).workspaceId
}

async function stateOf(deps: SseDeps, sessionId: string): Promise<Record<string, unknown>> {
  const record = await ownSession(deps.db, deps.userId, sessionId)
  const items = await deps.queue.items(sessionId)
  const pending: string[] = []
  for (const frame of deps.watchers.pending(sessionId)) {
    const kind = text(frame.kind)
    if (kind === 'approval') pending.push('approval')
    else if (kind === 'questions') pending.push('question')
    else pending.push('other')
  }
  return {
    cursor: deps.watchers.cursorOf(sessionId) ?? await maxSeq(deps.db, sessionId),
    active: record.status === 'active',
    running: deps.watchers.statusOf(sessionId)?.running ?? false,
    queue: items.map(item => ({ id: item.id, placement: item.placement, rpcId: item.rpcId, content: item.content })),
    pendingInput: pending,
  }
}

async function pumpJobFrames(
  channel: Channel,
  deps: SseDeps,
  input: { userId: string; workspaceId: string; sessionId: string; jobId?: string; from?: number },
): Promise<void> {
  const controller = new AbortController()
  channel.onClose(() => controller.abort())
  try {
    await deps.brain.jobFrames(input, controller.signal, (frame) => channel.send(frame))
  } catch (error) {
    if (!channel.closed) channel.fail(error)
    return
  }
  channel.close()
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 平台队列 → 客户端的 `inbox` 投影。
 *
 * 客户端按 `source.rpcId` 认回自己那次提交；平台用原始 `requestId` 当 rpcId，
 * 所以「已排队」的卡片能和 `session/prompt` 的回包对上。
 */
export function inboxView(items: readonly QueueItemView[]): Record<string, unknown> {
  return {
    'next-turn': items.map((item) => ({
      id: item.id,
      source: { kind: 'user', rpcId: item.rpcId },
      content: item.content,
    })),
    'next-step': [],
  }
}

type Args = Record<string, unknown>

function object(value: unknown): Args | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Args : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 历史页里的一条事件换成流帧。 */
function recordOf(event: unknown): Record<string, unknown> {
  return eventRecordOf(fieldsOf(event))
}

/** 上游实时帧（`frame.event`）换成流帧；seq 已由调用方定位。 */
function liveRecord(event: unknown, seq: number): Record<string, unknown> {
  return recordOf({ ...fieldsOf(event), seq })
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

async function maxSeq(db: Db, sessionId: string): Promise<number> {
  const rows = await db.query<{ seq: number | string | null }>(
    `SELECT MAX(seq) AS seq FROM dsh_session_events WHERE session_id = $1`,
    [sessionId],
  )
  const value = Number(rows.rows[0]?.seq ?? 0)
  return Number.isFinite(value) ? value : 0
}

/** 流请求的 payload 用 base64url JSON 放在查询串里（GET 没有请求体）。 */
function payloadOf(req: IncomingMessage): unknown {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const raw = url.searchParams.get('payload')
  if (raw === null || raw === '') return { args: {} }
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch {
    return { args: {} }
  }
}

/** 打开一条 SSE；写出响应头后平台只剩「发帧」与「关流」。 */
function openHttpChannel(req: IncomingMessage, res: ServerResponse): Channel {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // 反代可能攒满缓冲区才发；关掉它，流才是流的。
    'x-accel-buffering': 'no',
  })
  res.write('retry: 2000\n\n')
  let closed = false
  let heartbeat: NodeJS.Timeout | undefined
  const listeners: Array<() => void> = []
  const finish = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* 单个清理失败不影响其它清理 */
      }
    }
    if (!res.writableEnded) res.end()
  }
  req.on('close', finish)
  res.on('close', finish)
  heartbeat = setInterval(() => {
    if (closed) return
    res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  return {
    get closed() {
      return closed
    },
    send(value) {
      if (closed) return
      res.write(`data: ${JSON.stringify(value)}\n\n`)
    },
    fail(error) {
      if (closed) return
      const code = error instanceof HttpError ? error.code : 'gateway/internal'
      const message = error instanceof Error ? error.message : String(error)
      res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`)
      finish()
    },
    close() {
      finish()
    },
    onClose(listener) {
      if (closed) {
        try {
          listener()
        } catch {
          /* ignore */
        }
        return
      }
      listeners.push(listener)
    },
  }
}

/**
 * 物理流上的一条逻辑通道。
 *
 * 帧形状与直连 SSE 的语义一一对应：`frame` 就是直连时的一个 `data:` 值，
 * `error` 对应 `event: error`，`end` 对应关流。物理流断开时所有逻辑通道一起关，
 * 依赖 `onClose` 的清理（watcher 退订、轮询计时器）照常执行。
 */
export function createMuxChannel(carrier: Channel, id: string): Channel {
  let closed = false
  const listeners: Array<() => void> = []
  const finish = (): void => {
    if (closed) return
    closed = true
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* 单个清理失败不影响其它清理 */
      }
    }
  }
  carrier.onClose(finish)
  return {
    get closed() {
      return closed || carrier.closed
    },
    send(value) {
      if (closed || carrier.closed) return
      carrier.send({ type: 'frame', channel: id, value })
    },
    fail(error) {
      if (closed) return
      const code = error instanceof HttpError ? error.code : 'gateway/internal'
      const message = error instanceof Error ? error.message : String(error)
      if (!carrier.closed) carrier.send({ type: 'error', channel: id, error: { code, message } })
      finish()
    },
    close() {
      if (closed) return
      if (!carrier.closed) carrier.send({ type: 'end', channel: id })
      finish()
    },
    onClose(listener) {
      if (closed) {
        try {
          listener()
        } catch {
          /* ignore */
        }
        return
      }
      listeners.push(listener)
    },
  }
}

const CONTROL_BODY_LIMIT = 1024 * 1024

/** `$mux/open|close` 的请求体：一次性的小 JSON，读满即止。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > CONTROL_BODY_LIMIT) throw new HttpError(413, 'gateway/too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function writeEnvelope(res: ServerResponse, text: string): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}
