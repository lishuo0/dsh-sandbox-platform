import type { IncomingMessage } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AppConfig } from '../config.js'

/** 脑上的一条已提交日志事件；字段与 `dsh_session_events.event` 对齐。 */
export interface BrainEvent {
  seq: number
  type: string
  data: unknown
  ignorable?: boolean
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
}

export interface BrainCall {
  userId: string
  workspaceId: string
  sessionId: string
  /** 相关请求号；按契约走 x-request-id 头，脑用它做幂等去重。 */
  requestId?: string
  modelKey?: string
  modelBaseUrl?: string
  modelId?: string
  /** 这个成员配置的全部模型；脑按它登记客户端可选模型。 */
  modelIds?: string[]
}

/** 平台访问脑的唯一出口。各能力不自己拼地址和请求头。 */
export class BrainClient {
  constructor(private readonly cfg: AppConfig) {}

  openSession(input: BrainCall & { cwd: string }) {
    return this.json('/brain/v1/sessions', {
      ...input,
      method: 'POST',
      body: { cwd: input.cwd, sessionId: input.sessionId },
    })
  }

  /**
   * 平台改完 `dsh_workspaces` / 会话归档位之后，让脑重新投影工作区。
   * 租户归属已经由平台判定；这里只带应用凭据。
   */
  syncWorkspaces(userId: string) {
    return this.json('/brain/v1/workspaces/sync', {
      userId,
      workspaceId: '',
      sessionId: '',
      method: 'POST',
      body: {},
    })
  }

  sendMessage(input: BrainCall & { text: string; requestId: string; mode?: 'queue' | 'steer' }) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/messages`, {
      ...input,
      method: 'POST',
      body: {
        text: input.text,
        requestId: input.requestId,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      },
    })
  }

  /** 分支：脑复制会话日志后返回新会话 id。 */
  fork(input: BrainCall & { atSeq?: number }) {
    return this.jsonValue(`/brain/v1/sessions/${input.sessionId}/fork`, {
      ...input,
      method: 'POST',
      body: input.atSeq === undefined ? {} : { atSeq: input.atSeq },
    })
  }

  selectModel(input: BrainCall) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/model`, {
      ...input,
      method: 'POST',
      body: { modelId: input.modelId },
    })
  }

  /**
   * 执行一条斜杠命令；返回脑侧的结算结果（`CommandExecution`）。
   * 平台自己收口 `/api/commands/execute`，因为 `compact` 这类命令要在会话的
   * initiator 里跑，脑才拿得到该会话的模型密钥。
   */
  executeCommand(input: BrainCall & { line: string; attachments?: readonly unknown[] }) {
    return this.jsonValue(`/brain/v1/sessions/${input.sessionId}/commands`, {
      ...input,
      method: 'POST',
      body: {
        line: input.line,
        ...input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: input.attachments },
      },
    })
  }

  /**
   * 脑组合出来的 Agent 预设目录；平台不缓存，读失败按脑的错误码回给客户端。
   * 脑的 `requireUser` 要求 `x-dsh-user-id` 非空，这里必须带当前成员。
   */
  presets(userId: string) {
    return this.jsonValue('/brain/v1/presets', {
      userId,
      workspaceId: '',
      sessionId: '',
      method: 'GET',
    })
  }

  /** 权限预设目录，同样由脑组合；同样需要成员头。 */
  permissionPresets(userId: string) {
    return this.jsonValue('/brain/v1/permission-presets', {
      userId,
      workspaceId: '',
      sessionId: '',
      method: 'GET',
    })
  }

  /**
   * 会话沙箱里的文件操作。平台只做归属判定，真正的读写由脑经沙箱接缝执行，
   * 平台进程不碰宿主目录。
   */
  async workspaceFiles(input: BrainCall & { action?: 'content' | 'stat' | 'upload'; search: string; bytes?: Buffer }) {
    const suffix = input.action ? `/${input.action}` : ''
    const query = input.search ? `?${input.search}` : ''
    const response = await this.fetch(
      `/brain/v1/sessions/${input.sessionId}/workspace-files${suffix}${query}`,
      input,
      input.bytes === undefined ? 'GET' : 'POST',
      undefined,
      input.bytes,
    )
    if (!response.ok) {
      return { ok: false as const, status: response.status, code: await this.codeOf(response) }
    }
    try {
      return { ok: true as const, value: (await response.json()) as unknown }
    } catch {
      return { ok: true as const, value: null }
    }
  }

  cancel(input: BrainCall & { requestId: string }) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/cancel`, {
      ...input,
      method: 'POST',
      body: { requestId: input.requestId },
    })
  }

  /**
   * 会话实时流：把脑的 SSE 原样转给浏览器。
   * 平台只判归属，帧不解析；下游断开时一并取消上游。
   */
  async pipeSession(input: BrainCall, req: IncomingMessage, res: ServerResponse) {
    const response = await this.fetch(`/brain/v1/sessions/${input.sessionId}/stream`, input, 'GET')
    if (!response.ok) {
      return { ok: false as const, status: response.status, code: await this.codeOf(response) }
    }
    if (!(await this.relay(response, req, res))) {
      return { ok: false as const, status: 502, code: 'brain-unreachable' }
    }
    return { ok: true as const }
  }

  /**
   * 订阅一条会话的 SSE 下行，把每一帧回调给调用方。
   *
   * 与 `pipeSession` 的区别：这里由平台解析帧，用于合成浏览器侧的
   * `session/follow` / `session/control` / `$events` 载体，而不是原样透传。
   * 连接失败时抛错；调用方负责把它变成业务错误。
   */
  async sessionFrames(
    input: BrainCall,
    signal: AbortSignal,
    onFrame: (frame: { readonly type?: string } & Record<string, unknown>) => void,
  ): Promise<void> {
    return this.frames(`/brain/v1/sessions/${input.sessionId}/stream`, input, signal, onFrame)
  }

  /**
   * 从脑的已提交日志回放一段事件。
   *
   * 脑先广播事件、再按批写入 `dsh_session_events`（默认 200ms），所以平台读库
   * 会短暂落后于进程内日志。浏览器 journal 要求每一页严格结束在请求的 cursor
   * 上，落后时只能用脑的 `/events?after=N` 补齐，否则会报
   * `session event stream page did not end at its requested cursor`。
   *
   * `until` 是包含上界；不传就补到连接建立时的日志末尾。会话不在这个副本
   * （404）或脑不可达时返回 `undefined`，调用方退回数据库。
   */
  async eventBacklog(
    input: BrainCall & { after: number; until?: number; maxEvents?: number },
  ): Promise<{ cursor: number; events: BrainEvent[] } | undefined> {
    const events = new Map<number, BrainEvent>()
    const maxEvents = input.maxEvents ?? 2_000
    const deadline = Date.now() + 5_000
    let cursor = -1
    let after = input.after
    let connected = false
    for (let round = 0; round < 25; round += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0 || events.size >= maxEvents) break
      const controller = new AbortController()
      let snapshot = -1
      let replayed = after
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        controller.abort()
      }
      const timer = setTimeout(finish, remaining)
      timer.unref?.()
      const run = this.frames(
        `/brain/v1/sessions/${encodeURIComponent(input.sessionId)}/events?after=${after}`,
        input,
        controller.signal,
        (frame) => {
          if (finished) return
          // `/events` 的 `data` 不带帧名：snapshot 靠 `cursor`、ready 靠 `replayed`、
          // 已提交事件靠 `seq` 区分（assistant 分片没有 seq）。
          if (typeof frame.cursor === 'number' && Number.isSafeInteger(frame.cursor)) {
            connected = true
            snapshot = frame.cursor
            cursor = Math.max(cursor, frame.cursor)
            return
          }
          if (typeof frame.seq === 'number' && Number.isSafeInteger(frame.seq)) {
            const seq = frame.seq
            if (!events.has(seq)) {
              events.set(seq, {
                seq,
                type: typeof frame.type === 'string' ? frame.type : '',
                data: frame.data ?? null,
                ...(frame.ignorable === true ? { ignorable: true } : {}),
                ...(frame.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: frame.sourceEventSeqs }),
                ...(frame.surfaceOp === undefined ? {} : { surfaceOp: frame.surfaceOp }),
              })
            }
            replayed = Math.max(replayed, seq)
            if (events.size >= maxEvents
              || (input.until !== undefined && replayed >= input.until)
              || (snapshot >= 0 && replayed >= snapshot)) {
              finish()
            }
            return
          }
          if (typeof frame.replayed === 'number') {
            // ready 帧：本轮回放结束。`after` 是最后一条回放的 seq。回放被
            // pageSize 截断时本轮到不了 snapshot，得重连再补下一段。
            const at = typeof frame.after === 'number' && Number.isSafeInteger(frame.after) ? frame.after : replayed
            replayed = Math.max(replayed, at)
            finish()
          }
        },
      )
      await run.catch(() => undefined)
      clearTimeout(timer)
      if (!connected && events.size === 0) return undefined
      if (input.until !== undefined && replayed >= input.until) break
      if (snapshot >= 0 && replayed >= snapshot) break
      // 单次回放被 pageSize 截断时接着下一段；没有进展就别空转。
      if (replayed <= after) break
      after = replayed
    }
    if (!connected && events.size === 0) return undefined
    const ordered = [...events.values()].sort((left, right) => left.seq - right.seq)
    return { cursor: Math.max(cursor, ordered.at(-1)?.seq ?? cursor), events: ordered }
  }

  /**
   * 后台任务的 SSE 下行：任务清单（`{type:'rows'}`）或单个任务的输出
   * （`opened` / `output` / `status`）。与 `sessionFrames` 共用同一条读取循环。
   */
  async jobFrames(
    input: BrainCall & { jobId?: string; from?: number },
    signal: AbortSignal,
    onFrame: (frame: { readonly type?: string } & Record<string, unknown>) => void,
  ): Promise<void> {
    const suffix = input.jobId === undefined ? '' : `/${encodeURIComponent(input.jobId)}/output`
    const query = input.from === undefined ? '' : `?from=${input.from}`
    return this.frames(`/brain/v1/sessions/${input.sessionId}/jobs${suffix}${query}`, input, signal, onFrame)
  }

  private async frames(
    path: string,
    input: BrainCall,
    signal: AbortSignal,
    onFrame: (frame: { readonly type?: string } & Record<string, unknown>) => void,
  ): Promise<void> {
    const response = await this.fetch(path, input, 'GET')
    if (!response.ok || response.body === null) {
      throw new Error(`brain-unreachable: HTTP ${response.status}`)
    }
    const reader = response.body.getReader()
    const abort = (): void => { void reader.cancel() }
    signal.addEventListener('abort', abort, { once: true })
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done || signal.aborted) break
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end < 0) break
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = parseSseEvent(block)
          if (event !== undefined) onFrame(event as { readonly type?: string } & Record<string, unknown>)
        }
      }
    } finally {
      signal.removeEventListener('abort', abort)
      void reader.cancel().catch(() => undefined)
    }
  }

  /**
   * 把一次答复交回脑里正在等待的 answerer。
   * 答复的 409 是终态（请求已撤销/不属于该会话），不能像写操作那样重试。
   */
  answer(input: BrainCall & { requestId: string; outcome: unknown }) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/answers`, {
      ...input,
      method: 'POST',
      body: { requestId: input.requestId, outcome: input.outcome },
    }, false)
  }

  /** 硬取消：脑在日志层补写 `turn/end` 并让旧 writer 失效。 */
  forceCancel(input: BrainCall & { requestId: string }) {
    return this.jsonValue(`/brain/v1/sessions/${input.sessionId}/force-cancel`, {
      ...input,
      method: 'POST',
      body: { requestId: input.requestId },
    })
  }

  /**
   * composer 能力面：投影、反馈、命令、目标、预设都在脑里，平台只判归属后转发。
   * 返回脑的原始 JSON，字段由脑和客户端约定。
   */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', input: BrainCall & { path: string; body?: unknown }) {
    return this.jsonValue(input.path, { ...input, method, body: input.body })
  }

  killJob(input: BrainCall & { jobId: string }) {
    return this.jsonValue(`/brain/v1/sessions/${input.sessionId}/jobs/${encodeURIComponent(input.jobId)}/kill`, {
      ...input,
      method: 'POST',
      body: {},
    })
  }

  /** 后台任务的 SSE 流：任务清单或单个任务的输出。 */
  async pipeJobs(
    input: BrainCall & { jobId?: string; from?: number },
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
    const suffix = input.jobId === undefined ? '' : `/${encodeURIComponent(input.jobId)}/output`
    const query = input.from === undefined ? '' : `?from=${input.from}`
    const response = await this.fetch(`/brain/v1/sessions/${input.sessionId}/jobs${suffix}${query}`, input, 'GET')
    if (!response.ok) return { ok: false, status: response.status, code: await this.codeOf(response) }
    if (!(await this.relay(response, req, res))) return { ok: false, status: 502, code: 'brain-unreachable' }
    return { ok: true }
  }

  /**
   * 把脑上的实时事件原样转给浏览器。
   * 脑没接上时返回 false，调用方改从数据库补已经落库的历史。
   */
  async pipeEvents(input: BrainCall & { after: number }, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const deadline = Date.now() + 35_000
    let response: Response | undefined
    for (;;) {
      response = await this.fetch(`/brain/v1/sessions/${input.sessionId}/events?after=${input.after}`, input, 'GET')
      if (response.status !== 409 || Date.now() >= deadline) break
      await delay(2000)
    }
    return this.relay(response, req, res)
  }

  /** 把脑的 SSE 响应原样转给浏览器；没有可用流时返回 false。 */
  private async relay(response: Response | undefined, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!response || !response.ok || !response.body) return false
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // 反代可能攒满缓冲区才发；关掉它，流才是流的。
      'x-accel-buffering': 'no',
    })
    const reader = response.body.getReader()
    let gone = false
    const abort = (): void => {
      gone = true
      void reader.cancel()
    }
    req.on('close', abort)
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done || gone) break
        // 慢消费者只允许积压一个 chunk：写不动就等 drain，而不是无限吃进内存。
        if (!res.write(chunk.value)) {
          await Promise.race([
            new Promise<void>(resolve => res.once('drain', resolve)),
            new Promise<void>(resolve => res.once('close', resolve)),
          ])
        }
      }
    } finally {
      req.off('close', abort)
      res.end()
    }
    return true
  }

  private async json(
    path: string,
    init: BrainCall & { method: string; body?: unknown },
    retryConflict = true,
  ): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
    const response = await this.fetch(path, init, init.method, init.body, undefined, retryConflict)
    if (response.ok) return { ok: true }
    return { ok: false, status: response.status, code: await this.codeOf(response) }
  }

  /** 同上，但把脑返回的 JSON 交回来；读不到就当 `null`。 */
  private async jsonValue(
    path: string,
    init: BrainCall & { method: string; body?: unknown },
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; status: number; code: string }
  > {
    const response = await this.fetch(path, init, init.method, init.body)
    if (!response.ok) {
      return { ok: false, status: response.status, code: await this.codeOf(response) }
    }
    try {
      return { ok: true, value: await response.json() }
    } catch {
      return { ok: true, value: undefined }
    }
  }

  /** 脑的错误体是 `{error:{code,message}}`；拿不到就用原文前缀。 */
  private async codeOf(response: Response): Promise<string> {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown } }
      if (typeof parsed.error?.code === 'string') return parsed.error.code
    } catch {
      /* 非 JSON 就用原文 */
    }
    return text.slice(0, 200) || 'brain-error'
  }

  private async fetch(
    path: string,
    call: BrainCall,
    method: string,
    body?: unknown,
    raw?: Buffer,
    retryConflict = true,
  ): Promise<Response> {
    const deadline = Date.now() + 35_000
    let response: Response | undefined
    const payload = raw !== undefined ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body)
    for (;;) {
      try {
        response = await fetch(`${this.cfg.brain.baseUrl}${path}`, {
          method,
          headers: this.headers(call, raw === undefined && body !== undefined),
          body: payload,
        })
      } catch {
        return new Response('brain-unreachable', { status: 502 })
      }
      if (response.status !== 409 || !retryConflict || Date.now() >= deadline || method === 'GET') return response
      await delay(2000)
    }
  }

  private headers(call: BrainCall, json: boolean): Record<string, string> {
    const oss = this.cfg.aliyun.oss
    const headers: Record<string, string> = {
      'x-app-id': this.cfg.brain.appId,
      'x-app-key': this.cfg.brain.appKey,
      'x-dsh-user-id': call.userId,
      'x-dsh-workspace-id': call.workspaceId,
      sessionid: call.sessionId,
    }
    if (json) headers['content-type'] = 'application/json'
    if (call.requestId) headers['x-request-id'] = call.requestId
    if (call.modelKey) headers['x-dsh-model-key'] = call.modelKey
    if (call.modelBaseUrl) headers['x-dsh-model-base-url'] = call.modelBaseUrl
    if (call.modelId) headers['x-dsh-model-id'] = call.modelId
    if (call.modelIds && call.modelIds.length > 0) headers['x-dsh-model-ids'] = call.modelIds.join(',')
    if (oss.bucket && oss.endpoint && oss.accessKeyId && oss.accessKeySecret) {
      headers['x-dsh-oss-bucket'] = oss.bucket
      headers['x-dsh-oss-endpoint'] = oss.endpoint
      headers['x-dsh-oss-region'] = oss.region
      headers['x-dsh-oss-access-key-id'] = oss.accessKeyId
      headers['x-dsh-oss-access-key-secret'] = oss.accessKeySecret
    }
    return headers
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 脑的 SSE 帧格式固定为 `event: frame` + `data: <JSON>`；注释行直接忽略。 */
function parseSseEvent(block: string): unknown {
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  if (data === '') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}
