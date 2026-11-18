import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { bootAsset } from '../../src/client/boot-assets.js'

/**
 * 注入到外壳页的传输适配脚本。
 *
 * 它决定官方客户端到底把请求打到哪：unary → `P/remote/*`、逻辑流 → `P/sse/*`、
 * 上传 → `P/upload`、上下文 → `P/context/*`。浏览器里没有测试框架，所以这里在
 * `vm` 里跑同一段脚本，用一个假的 `fetch` 盯住改写后的 URL 与请求体。
 */

interface FakeCall {
  input: string | URL
  init: RequestInit | undefined
}

interface Harness {
  calls: FakeCall[]
  globals: Record<string, unknown>
}

function install(): Harness {
  const calls: FakeCall[] = []
  const sandbox: Record<string, unknown> = {
    location: { origin: 'https://host.example' },
    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
    // vm 上下文不继承 Node 的全局对象，脚本用到的都要显式给。
    URL,
    Response,
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
  }
  runInNewContext(bootAsset('transport').body, sandbox)
  return { calls, globals: sandbox }
}

interface Transport {
  ownsHost: boolean
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
}

function transportOf(harness: Harness): Transport {
  return harness.globals.__DSH_TRANSPORT__ as Transport
}

function textOf(input: string | URL): string {
  return typeof input === 'string' ? input : input.href
}

/** 浏览器里相对路由按站点根解析；vm 里没有浏览器，用同一个 origin 补全。 */
function absolute(input: string | URL): string {
  return new URL(textOf(input), 'https://host.example').href
}

describe('浏览器传输适配', () => {
  it('注入脚本是纯 classic script，不夹带 tsx/esbuild 的转译辅助标识符', () => {
    // tsx 会给 `install.toString()` 补 `__name(fn,"fn")`，浏览器里没有 `__name`
    // 会直接 ReferenceError，整段脚本连 `__DSH_TRANSPORT__` 都装不上。
    const script = bootAsset('transport').body
    expect(script).not.toMatch(/\b__name\b/)
    expect(script).not.toMatch(/\b__(?:toESM|toCommonJS|spreadValues|spreadArray|asyncToGenerator)\b/)
    expect(script).toContain('__DSH_TRANSPORT__')
  })

  it('unary 调用改写到 P/remote/<endpoint>，请求体原样', async () => {
    const harness = install()
    const init = { method: 'POST', body: '{"x":1}' }
    await transportOf(harness).fetch('api/session/list', init)

    expect(harness.calls).toHaveLength(1)
    expect(absolute(harness.calls[0]!.input)).toBe('https://host.example/dsh-api/platform/v1/remote/session/list')
    expect(harness.calls[0]!.init).toBe(init)
  })

  it('带前导斜杠的旧相对路由也能改写，查询串保留', async () => {
    const harness = install()
    await transportOf(harness).fetch('/api/workspace/list?limit=5')
    expect(absolute(harness.calls[0]!.input)).toBe('https://host.example/dsh-api/platform/v1/remote/workspace/list?limit=5')
  })

  it('非 /api 通道与空端点直接回 404 信封，不打网络', async () => {
    const harness = install()
    const wrong = await transportOf(harness).fetch('other/path')
    expect(wrong.status).toBe(404)
    const envelope = await wrong.json() as { result: { ok: boolean; error: { code: string } } }
    expect(envelope.result).toMatchObject({ ok: false, error: { code: 'gateway/not-found' } })

    const empty = await transportOf(harness).fetch('api/')
    expect(empty.status).toBe(404)
    expect(harness.calls).toHaveLength(0)
  })

  it('文件字节上传走到 P/upload，查询串原样', async () => {
    const harness = install()
    const upload = harness.globals.__DSH_FILE_UPLOAD__ as { fetch(input: string | URL, init?: RequestInit): Promise<Response> }
    await upload.fetch('api/session/uploadFileBinary?sessionId=s1&name=a.png', { method: 'POST' })
    expect(absolute(harness.calls[0]!.input)).toBe('https://host.example/dsh-api/platform/v1/upload?sessionId=s1&name=a.png')
  })

  it('dsh-context 的旧相对路由被全局 fetch 包进统一前缀，其它请求放行', async () => {
    const harness = install()
    const wrapped = harness.globals.fetch as (input: string | URL, init?: RequestInit) => Promise<Response>
    await wrapped('api/dsh-context/projects?x=1')
    await wrapped('https://elsewhere.example/api/other')
    expect(absolute(harness.calls[0]!.input)).toBe('https://host.example/dsh-api/platform/v1/context/projects?x=1')
    expect(textOf(harness.calls[1]!.input)).toBe('https://elsewhere.example/api/other')
  })

  /** 装一条物理 `$mux` 流：GET 回 SSE 流，POST 回成功信封，测试自己推帧。 */
  function installMux(harness: Harness): {
    send(frame: unknown): void
    openArgs(): { mux: string; channel: string; endpoint: string; payload: unknown } | undefined
  } {
    let controller: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const encoder = new TextEncoder()
    harness.globals.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      harness.calls.push({ input, init })
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: 'rpc', result: { ok: true, value: { ok: true } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 重新注入，让 openStream 用新的 fetch。
    runInNewContext(bootAsset('transport').body, harness.globals)
    return {
      send(frame) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      },
      openArgs() {
        const call = harness.calls.find((item) => textOf(item.input).includes('$mux/open'))
        if (call?.init?.body === undefined) return undefined
        const envelope = JSON.parse(String(call.init.body)) as { payload: { args: { mux: string; channel: string; endpoint: string; payload: unknown } } }
        return envelope.payload.args
      },
    }
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  it('逻辑流把 payload 交给 $mux/open，物理流上的帧逐条 yield', async () => {
    const harness = install()
    const mux = installMux(harness)
    const payload = { args: { request: { sessionId: 's1' } } }
    const frames: unknown[] = []
    const stream = transportOf(harness).openStream('session/follow', payload, new AbortController().signal)
    const consume = (async () => {
      for await (const frame of stream) frames.push(frame)
    })()

    await flush()
    // 物理流先给 ready，再按 channel 分发逻辑帧。
    mux.send({ type: 'ready', mux: 'mux_1' })
    await flush()
    const args = mux.openArgs()
    expect(args).toMatchObject({ mux: 'mux_1', endpoint: 'session/follow', payload })

    expect(absolute(harness.calls[0]!.input)).toBe('https://host.example/dsh-api/platform/v1/sse/$mux')
    const channel = String(args?.channel)
    mux.send({ type: 'frame', channel, value: { type: 'snapshot' } })
    mux.send({ type: 'frame', channel, value: { type: 'event' } })
    mux.send({ type: 'end', channel })
    await consume

    expect(frames).toEqual([{ type: 'snapshot' }, { type: 'event' }])
  })

  it('流的 error 帧抛出带 code 的错误', async () => {
    const harness = install()
    const mux = installMux(harness)
    const stream = transportOf(harness).openStream('session/follow', { args: {} }, new AbortController().signal)
    const consume = (async () => {
      for await (const _frame of stream) { /* 不该有正常帧 */ }
    })()

    await flush()
    mux.send({ type: 'ready', mux: 'mux_2' })
    await flush()
    const channel = String(mux.openArgs()?.channel)
    mux.send({ type: 'error', channel, error: { code: 'session/not-found', message: 'gone' } })

    await expect(consume).rejects.toMatchObject({ code: 'session/not-found', message: 'gone' })
  })

  it('声明 ownsHost，客户端不会去启动全局 WSS', () => {
    expect(transportOf(install()).ownsHost).toBe(true)
  })
})
