/*
 * 浏览器侧的传输适配（classic script）。由 boot-assets.ts 作为内容寻址的启动
 * 资产登记，外壳页 head 里用 `<script src>` 在客户端 boot 之前加载。
 *
 * 不要改写成 TypeScript 再用 `Function#toString()` 注入：tsx/esbuild 会给函数体
 * 补函数命名之类的辅助调用，浏览器里没有这些标识符，整段注入脚本会直接抛
 * ReferenceError。这个文件按 classic script 原样跑，不经过任何转译。
 *
 * 官方 `@deepseek-ai/dsh-client-connection` 在页面里读 `globalThis.__DSH_TRANSPORT__`：
 * 给了 `fetch` 与 `openStream` 就完全不用它的 `fetch`/WebSocket 默认值。
 *
 * - unary Remote：`connection.rpc.call('/api', '<endpoint>', {args})` 会 POST
 *   `<页面相对路径 api/<endpoint>`；这里改写成 `P/remote/<endpoint>`，请求体原样
 *   转发（`{type:'client-request', rpcId, method, payload}`）。
 * - 逻辑流：`connection.rpc.open('/api', endpoint, payload, signal)` 复用一条
 *   `GET P/sse/$mux` 物理流，用 `POST P/remote/$mux/open|$mux/close` 开关逻辑通道，
 *   逐帧 `data:` 解出 `{type:'frame',channel,value}` 后 yield。
 *   客户端见到 `open` 存在就不会启动它的 WebSocket 多路复用，页面不再建立全局 WSS。
 * - 上传：`fileUpload` 的 `postRaw` 用 `__DSH_FILE_UPLOAD__.fetch(path, init)`；
 *   这里把 `api/session/uploadFileBinary?<query>` 改写到 `P/upload?<query>`。
 */
;(function installTransport() {
  var prefix = '/dsh-api/platform/v1'
  var globals = globalThis
  /** 原生 fetch：下面会把 `globalThis.fetch` 包一层，内部一律用它避免自递归。 */
  var nativeFetch = globalThis.fetch.bind(globalThis)

  /** 页面里的相对路由统一按站点根解析，避免被当前 history 路径带偏。 */
  function routeOf(input) {
    var raw = typeof input === 'string' ? input : input.href
    var path = raw.replace(/^\/+/, '')
    return new URL('/' + path, globalThis.location.origin)
  }

  function failure(code, message, status) {
    var text = JSON.stringify({
      type: 'server-response',
      rpcId: '',
      result: { ok: false, error: { code: code, message: message, details: {} } },
    })
    return new Response(text, { status: status, headers: { 'content-type': 'application/json' } })
  }

  /** 官方 unary 载体：只认 `/api` 通道，改写后原样转发。 */
  async function transportFetch(input, init) {
    var url = routeOf(input)
    var path = url.pathname.replace(/^\/+/, '')
    if (path.slice(0, 4) !== 'api/') {
      return failure('gateway/not-found', 'This channel is not available to the browser.', 404)
    }
    var endpoint = path.slice(4)
    if (endpoint === '') return failure('gateway/not-found', 'The endpoint is missing.', 404)
    return globalThis.fetch(prefix + '/remote/' + endpoint + url.search, init)
  }

  /**
   * 逻辑流承载：**所有**逻辑流复用一条物理 SSE（`P/sse/$mux`）。
   *
   * 浏览器对同一源只允许 6 条 HTTP/1.1 连接；页面常驻 `$events`、`session/follow`、
   * `session/control`、`workspace/follow`、`remoteAccess/follow` 五条流，再开一个
   * 文件树面板（`workspaceFiles/changes`）就占满，之后任何 unary 请求
   * （如 `workspaceFiles/list`）都会永久排队。逻辑流改走
   * `POST $mux/open` / `$mux/close` 在物理流上开关的通道后，
   * 连接数与 UI 面板数量无关。
   *
   * 物理流帧：`{type:'ready',mux}`，之后 `{type:'frame',channel,value}`、
   * `{type:'error',channel,error}`、`{type:'end',channel}`。
   */
  function makeSink() {
    var queue = []
    var waiters = []
    var ended = false
    var failure = undefined
    function next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
      if (ended) {
        return failure === undefined
          ? Promise.resolve({ value: undefined, done: true })
          : Promise.reject(failure)
      }
      return new Promise(function (resolve, reject) {
        waiters.push({ resolve: resolve, reject: reject })
      })
    }
    function deliver(value) {
      if (ended) return
      var waiter = waiters.shift()
      if (waiter !== undefined) waiter.resolve({ value: value, done: false })
      else queue.push(value)
    }
    function finish(error) {
      if (ended) return
      ended = true
      failure = error
      while (waiters.length > 0) {
        var waiter = waiters.shift()
        if (error === undefined) waiter.resolve({ value: undefined, done: true })
        else waiter.reject(error)
      }
    }
    return { next: next, deliver: deliver, finish: finish }
  }

  function errorFrom(detail) {
    var message = typeof detail === 'object' && detail !== null && typeof detail.message === 'string'
      ? String(detail.message)
      : 'Remote stream failed'
    var error = new Error(message)
    if (typeof detail === 'object' && detail !== null && typeof detail.code === 'string') {
      error.code = String(detail.code)
    }
    return error
  }

  function abortError() {
    var error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    return error
  }

  var mux = null

  function muxHandle() {
    if (mux !== null) return mux
    var state = { id: null, channels: new Map(), closed: false, ready: null, resolveReady: null, rejectReady: null }
    state.ready = new Promise(function (resolve, reject) {
      state.resolveReady = resolve
      state.rejectReady = reject
    })
    var promise = (async function () {
      var response = await nativeFetch(prefix + '/sse/$mux', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'text/event-stream' },
      })
      if (!response.ok || response.body === null) {
        throw new Error('Remote mux stream failed with HTTP ' + String(response.status))
      }
      void pumpMux(state, response.body)
      return state
    })()
    var handle = { promise: promise, state: state }
    mux = handle
    // 物理流建不起来时清掉缓存，下一次 `openStream` 重新连。
    promise.catch(function () {
      if (mux !== null && mux.promise === promise) mux = null
      state.rejectReady(new Error('Remote mux stream is unavailable'))
    })
    return handle
  }

  async function pumpMux(state, body) {
    var reader = body.getReader()
    var decoder = new TextDecoder()
    var buffer = ''
    try {
      for (;;) {
        var chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        var cut = buffer.indexOf('\n\n')
        while (cut >= 0) {
          var block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          cut = buffer.indexOf('\n\n')
          var parsed = parseEvent(block)
          if (parsed === undefined || typeof parsed.data !== 'object' || parsed.data === null) continue
          var frame = parsed.data
          if (frame.type === 'ready') {
            state.id = String(frame.mux)
            state.resolveReady(state)
            continue
          }
          var sink = state.channels.get(String(frame.channel))
          if (sink === undefined) continue
          if (frame.type === 'frame') sink.deliver(frame.value)
          else if (frame.type === 'error') sink.finish(errorFrom(frame.error))
          else if (frame.type === 'end') sink.finish(undefined)
        }
      }
      failMux(state, new Error('Remote mux stream closed'))
    } catch (error) {
      failMux(state, error)
    } finally {
      try {
        await reader.cancel()
      } catch (error) {
        /* 已关闭 */
      }
    }
  }

  function failMux(state, error) {
    if (state.closed) return
    state.closed = true
    state.channels.forEach(function (sink) { sink.finish(error) })
    state.channels.clear()
    state.rejectReady(error)
    if (mux !== null && mux.state === state) mux = null
  }

  function channelId() {
    return 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }

  function muxCall(method, args, options) {
    return nativeFetch(prefix + '/remote/' + method, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: method.replace('/', '-') + '-' + String(args.channel),
        method: method,
        payload: { args: args },
      }),
      keepalive: options !== undefined && options.keepalive === true,
    })
  }

  async function* openStream(endpoint, payload, signal) {
    if (signal !== undefined && signal !== null && signal.aborted) throw abortError()
    var handle = muxHandle()
    var state = await handle.promise
    if (state.id === null) await state.ready
    var channel = channelId()
    var sink = makeSink()
    state.channels.set(channel, sink)
    var opener = await muxCall('$mux/open', {
      mux: state.id,
      channel: channel,
      endpoint: endpoint,
      payload: payload == null ? { args: {} } : payload,
    })
    if (!opener.ok) {
      state.channels.delete(channel)
      throw new Error('Remote stream ' + endpoint + ' failed with HTTP ' + String(opener.status))
    }
    var opened = JSON.parse(await opener.text())
    if (typeof opened !== 'object' || opened === null || !opened.result || opened.result.ok !== true) {
      state.channels.delete(channel)
      throw errorFrom(opened !== null && typeof opened === 'object' && opened.result ? opened.result.error : undefined)
    }
    var onAbort = function () { sink.finish(abortError()) }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }
    try {
      for (;;) {
        var item = await sink.next()
        if (item.done) return
        yield item.value
      }
    } finally {
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      if (state.channels.get(channel) === sink) state.channels.delete(channel)
      if (!state.closed) {
        void muxCall('$mux/close', { mux: state.id, channel: channel }, { keepalive: true }).catch(function () {
          /* 物理流已断时关闭是幂等的 */
        })
      }
    }
  }

  function parseEvent(block) {
    var event = 'message'
    var data = []
    var lines = block.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line === '' || line.charAt(0) === ':') continue
      if (line.slice(0, 5) === 'data:') {
        var value = line.slice(5)
        data.push(value.charAt(0) === ' ' ? value.slice(1) : value)
        continue
      }
      if (line.slice(0, 6) === 'event:') {
        var name = line.slice(6)
        event = (name.charAt(0) === ' ' ? name.slice(1) : name).trim()
      }
    }
    if (data.length === 0) return undefined
    var text = data.join('\n')
    try {
      return { event: event, data: JSON.parse(text) }
    } catch (error) {
      return undefined
    }
  }

  /** 上传载体的字节直传：路径里的查询串原样带到平台上传面。 */
  function uploadFetch(input, init) {
    var url = routeOf(input)
    return globalThis.fetch(prefix + '/upload' + url.search, init)
  }

  /**
   * `dsh-context` 的浏览器半把 `api/dsh-context/<x>` 当相对路由直接 fetch，
   * 没有可配置的载体。这里包一层全局 fetch，只把这一段改写进统一前缀，
   * 其它请求（包括上面的传输适配）原样交给原生 fetch。
   */
  var CONTEXT_LEGACY = 'api/dsh-context/'
  function contextFetch(input, init) {
    if (typeof input === 'string') {
      var path = input.replace(/^\/+/, '')
      if (path.slice(0, CONTEXT_LEGACY.length) === CONTEXT_LEGACY) {
        return nativeFetch(prefix + '/context/' + path.slice(CONTEXT_LEGACY.length), init)
      }
    }
    return nativeFetch(input, init)
  }
  globalThis.fetch = contextFetch

  globals.__DSH_TRANSPORT__ = {
    // 页面自己声明拥有宿主：没有别的进程能替它接这条连接，回环判定不适用。
    ownsHost: true,
    fetch: transportFetch,
    openStream: openStream,
  }
  globals.__DSH_FILE_UPLOAD__ = { fetch: uploadFetch }
})();
