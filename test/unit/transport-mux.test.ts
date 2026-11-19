import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { ReadableStream } from 'node:stream/web'
import { describe, expect, it } from 'vitest'

/**
 * 浏览器传输适配：逻辑流必须复用**一条**物理 `$mux` 流。
 *
 * 回归点：以前每条 `connection.rpc.open` 都是一条 HTTP SSE。页面常驻五条流，
 * 再加文件树面板就占满浏览器每源 6 条连接，`workspaceFiles/list` 之类 unary
 * 永久排队、文件树永远停在「正在读取…」。这里在 vm 里真跑 classic script，
 * 用假 fetch 验证：两次 `openStream` 只发一次物理 GET，帧按 channel 分发。
 */

const SOURCE = readFileSync(new URL('../../src/client/transport-client.js', import.meta.url), 'utf8')

interface Harness {
  transport: {
    openStream(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<unknown>
    fetch(input: unknown, init?: { method?: string; body?: string }): Promise<Response>
  }
  push(frame: unknown): void
  closeBody(): void
  gets: string[]
  posts: Array<{ url: string; body: { rpcId: string; method: string; payload: { args: Record<string, unknown> } } }>
  /** 假浏览器 WebSocket；`socket: false` 的 harness 里为空。 */
  sockets: FakeSocket[]
}

/** 浏览器 WebSocket 的替身：测试手动决定何时 ready、何时推帧。 */
class FakeSocket {
  readonly sent: Array<Record<string, unknown>> = []
  readyState = 1
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', {})
  }
  /** 把一帧当作服务端下行投给页面。 */
  deliver(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }
  /** 握手失败：页面应退回 SSE 载体。 */
  fail(): void {
    this.emit('error', {})
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function harness(options: { socket?: boolean } = {}): Harness {
  const gets: string[] = []
  const posts: Harness['posts'] = []
  const sockets: FakeSocket[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  /** 每次物理 GET 都是一条新流：重连后旧的 `body` 已经 locked/closed。 */
  const newBody = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  const encoder = new TextEncoder()
  const push = (frame: unknown): void => {
    controller?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
  }
  const closeBody = (): void => controller?.close()
  const ok = (rpcId: string): { ok: true; status: number; text(): Promise<string> } => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { ok: true } } }),
  })
  const fakeFetch = (input: unknown, init: { method?: string; body?: string } = {}): unknown => {
    const url = String(input)
    if (init.method === undefined || init.method === 'GET') {
      gets.push(url)
      return Promise.resolve({ ok: true, status: 200, body: newBody() })
    }
    const parsed = JSON.parse(init.body ?? '{}') as Harness['posts'][number]['body']
    posts.push({ url, body: parsed })
    return Promise.resolve(ok(parsed.rpcId))
  }
  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  const context = createContext({
    fetch: fakeFetch,
    TextEncoder,
    TextDecoder,
    URL,
    Response,
    ReadableStream,
    btoa,
    console,
    setTimeout,
    clearTimeout,
    location: { protocol: 'http:', host: 'platform.test', origin: 'http://platform.test' },
    ...(options.socket === true ? { WebSocket: Socket } : {}),
  })
  runInContext(SOURCE, context)
  const transport = (context as unknown as { __DSH_TRANSPORT__: Harness['transport'] }).__DSH_TRANSPORT__
  return { transport, push, closeBody, gets, posts, sockets }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('浏览器传输的多路复用', () => {
  it('多条逻辑流只开一条物理流，帧按 channel 分发', async () => {
    const { transport, push, gets, posts } = harness()

    const first = transport.openStream('remoteAccess/follow', { args: {} })
    const firstNext = first.next()
    await tick()
    expect(gets.filter((url) => url.includes('/sse/$mux'))).toHaveLength(1)
    push({ type: 'ready', mux: 'mux_1' })
    await tick()

    const firstOpen = posts.find((post) => post.body.method === '$mux/open')
    expect(firstOpen?.body.payload.args).toMatchObject({ mux: 'mux_1', endpoint: 'remoteAccess/follow' })
    const channelOne = String(firstOpen?.body.payload.args.channel)
    push({ type: 'frame', channel: channelOne, value: { type: 'baseline', owner: true } })
    expect(await firstNext).toEqual({ value: { type: 'baseline', owner: true }, done: false })

    // 第二条逻辑流：不再发物理 GET。
    const second = transport.openStream('$events', { args: {} })
    const secondNext = second.next()
    await tick()
    expect(gets.filter((url) => url.includes('/sse/$mux'))).toHaveLength(1)
    const secondOpen = posts.filter((post) => post.body.method === '$mux/open')[1]
    const channelTwo = String(secondOpen?.body.payload.args.channel)
    expect(channelTwo).not.toBe(channelOne)
    push({ type: 'frame', channel: channelTwo, value: { type: 'ready', clientId: 'sse_1' } })
    expect(await secondNext).toEqual({ value: { type: 'ready', clientId: 'sse_1' }, done: false })

    // `end` 结束这条逻辑流，并向服务端回报关闭。
    push({ type: 'end', channel: channelOne })
    expect(await first.next()).toEqual({ value: undefined, done: true })
    await tick()
    expect(posts.some((post) => post.body.method === '$mux/close'
      && post.body.payload.args.channel === channelOne)).toBe(true)

    await second.return(undefined)
  })

  it('错误帧映射成带 code 的异常', async () => {
    const { transport, push, gets, posts } = harness()
    const stream = transport.openStream('session/follow', { args: {} })
    const next = stream.next()
    await tick()
    expect(gets.length).toBeGreaterThan(0)
    push({ type: 'ready', mux: 'mux_2' })
    await tick()
    const channel = String(posts[0]?.body.payload.args.channel)
    push({ type: 'error', channel, error: { code: 'session/not-found', message: 'gone' } })
    await expect(next).rejects.toMatchObject({ message: 'gone', code: 'session/not-found' })
  })

  it('取消信号结束逻辑流，不关物理流', async () => {
    const { transport, push, gets, posts } = harness()
    const abort = new AbortController()
    const stream = transport.openStream('remoteAccess/follow', { args: {} }, abort.signal)
    const next = stream.next()
    await tick()
    push({ type: 'ready', mux: 'mux_3' })
    await tick()
    const channel = String(posts[0]?.body.payload.args.channel)
    abort.abort()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    // 物理流只开了一次；关闭的是逻辑通道。
    expect(gets.filter((url) => url.includes('/sse/$mux'))).toHaveLength(1)
    expect(posts.some((post) => post.body.method === '$mux/close'
      && post.body.payload.args.channel === channel)).toBe(true)
  })

  it('物理流断开时所有逻辑流一起失败，下一条逻辑流重新建连', async () => {
    const { transport, push, closeBody, gets } = harness()
    const stream = transport.openStream('remoteAccess/follow', { args: {} })
    const next = stream.next()
    await tick()
    push({ type: 'ready', mux: 'mux_4' })
    await tick()
    closeBody()
    await expect(next).rejects.toThrow(/mux stream closed/)
    expect(gets.filter((url) => url.includes('/sse/$mux'))).toHaveLength(1)

    // 新逻辑流重新建物理流（gets 里出现第二条 GET）。
    const abort = new AbortController()
    const again = transport.openStream('remoteAccess/follow', { args: {} }, abort.signal)
    const againNext = again.next()
    await tick()
    expect(gets.filter((url) => url.includes('/sse/$mux'))).toHaveLength(2)
    push({ type: 'ready', mux: 'mux_5' })
    await tick()
    abort.abort()
    await expect(againNext).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('浏览器传输的 WSS 载体', () => {
  it('优先用一条 WSS：带内 open、帧按 channel 分发、关闭也走带内', async () => {
    const { transport, gets, posts, sockets } = harness({ socket: true })
    const first = transport.openStream('remoteAccess/follow', { args: {} })
    const firstNext = first.next()
    await tick()
    expect(sockets).toHaveLength(1)
    expect(gets).toHaveLength(0)

    sockets[0]!.deliver({ type: 'ready', mux: 'mux_ws' })
    await tick()
    const open = sockets[0]!.sent.find(message => message.type === 'open')
    expect(open).toMatchObject({ endpoint: 'remoteAccess/follow' })
    sockets[0]!.deliver({
      type: 'server-response',
      rpcId: open?.rpcId as string,
      result: { ok: true, value: { ok: true } },
    })
    await tick()

    sockets[0]!.deliver({ type: 'frame', channel: open?.channel as string, value: { type: 'baseline', owner: true } })
    expect(await firstNext).toEqual({ value: { type: 'baseline', owner: true }, done: false })

    // 第二条逻辑流复用同一条 WSS，不再建连接。
    const second = transport.openStream('$events', { args: {} })
    const secondNext = second.next()
    await tick()
    expect(sockets).toHaveLength(1)
    const secondOpen = sockets[0]!.sent.filter(message => message.type === 'open')[1]
    expect(secondOpen).toBeDefined()
    sockets[0]!.deliver({
      type: 'server-response',
      rpcId: secondOpen?.rpcId as string,
      result: { ok: true, value: { ok: true } },
    })
    await tick()
    sockets[0]!.deliver({
      type: 'frame',
      channel: secondOpen?.channel as string,
      value: { type: 'ready', clientId: 'ws_1' },
    })
    expect(await secondNext).toEqual({ value: { type: 'ready', clientId: 'ws_1' }, done: false })

    await first.return(undefined)
    await tick()
    expect(sockets[0]!.sent.some(message => message.type === 'close' && message.channel === open?.channel)).toBe(true)
    expect(posts).toHaveLength(0)
    await second.return(undefined)
  })

  it('Upgrade 建不起来时退回 SSE 载体', async () => {
    const { transport, gets, push, sockets } = harness({ socket: true })
    const stream = transport.openStream('remoteAccess/follow', { args: {} })
    const next = stream.next()
    await tick()
    expect(sockets).toHaveLength(1)

    sockets[0]!.fail()
    await tick()
    expect(gets.filter(url => url.includes('/sse/$mux'))).toHaveLength(1)
    push({ type: 'ready', mux: 'mux_sse' })
    await tick()
    expect(sockets).toHaveLength(1)

    const abort = new AbortController()
    const again = transport.openStream('remoteAccess/follow', { args: {} }, abort.signal)
    const againNext = again.next()
    await tick()
    abort.abort()
    await expect(againNext).rejects.toMatchObject({ name: 'AbortError' })
    void next
  })

  it('答复带内上行，不再发 HTTP POST', async () => {
    const { transport, posts, sockets } = harness({ socket: true })
    const abort = new AbortController()
    const stream = transport.openStream('remoteAccess/follow', { args: {} }, abort.signal)
    const next = stream.next()
    await tick()
    sockets[0]!.deliver({ type: 'ready', mux: 'mux_ws' })
    await tick()
    const open = sockets[0]!.sent.find(message => message.type === 'open')
    sockets[0]!.deliver({
      type: 'server-response',
      rpcId: open?.rpcId as string,
      result: { ok: true, value: { ok: true } },
    })
    await tick()

    const pending = transport.fetch('/api/$events/result', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-answer',
        method: '$events/result',
        payload: { args: { eventId: 'req_1', outcome: { kind: 'result', value: 'approved' } } },
      }),
    })
    await tick()
    const answer = sockets[0]!.sent.find(message => message.rpcId === 'rpc-answer')
    expect(answer).toMatchObject({
      type: 'answer',
      eventId: 'req_1',
      outcome: { kind: 'result', value: 'approved' },
    })
    sockets[0]!.deliver({
      type: 'server-response',
      rpcId: 'rpc-answer',
      result: { ok: true, value: { accepted: true } },
    })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { ok: true, value: { accepted: true } } })
    expect(posts).toHaveLength(0)
    abort.abort()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
  })
})
