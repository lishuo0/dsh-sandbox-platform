/**
 * 浏览器侧的物理承载：**一个成员一个浏览器一条 WSS**。
 *
 * 页面里的所有逻辑流（`$events`、`session/follow`、`session/control`、
 * `workspace/follow`、文件树……）都复用到这条连接上，开关逻辑通道与交互答复
 * 也在带内上行。和 `P/sse/$mux` 是同一套 mux 语义，只是载体从 SSE 换成
 * WebSocket：逻辑帧仍是 `{type:'frame', channel, value}`，控制面从
 * `POST P/remote/$mux/open` 变成 `{type:'open', …}`。
 *
 * 会话不在这条连接上：连接绑的是成员，逻辑通道自己带会话（`session/follow`
 * 的 payload 里）。所以并发会话数不增加浏览器连接数。
 *
 * 路径固定为 `P/socket`；未登录、被停用、临时口令一律在 Upgrade 阶段回 401，
 * 不进任何下游调用。SSE 载体保留为回退：Upgrade 建不起来（反代不转发、旧页面）
 * 时浏览器自动退回 `P/sse/$mux`。
 *
 * @module client/mux/socket
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { HttpError } from '../../kernel/errors.js'
import { answerForwardedEvent, answerUserQuestion, type RemoteDeps } from './router.js'
import type { Channel, SseRuntime } from './sse.js'
import { mapErrorCode, remoteFailedValue, remoteSucceededValue } from './wire.js'

/** 浏览器 mux 的 Upgrade 路径（统一前缀下）。 */
export const MUX_SOCKET_PATH = '/dsh-api/platform/v1/socket'

/** 上行的最大消息体；与 unary 的请求体上限一致。 */
const MAX_PAYLOAD = 1024 * 1024

const HEARTBEAT_MS = 15_000

/** 一次 Upgrade 的授权结果；授权失败时 `deps` 缺省。 */
export interface SocketCaller {
  readonly deps: RemoteDeps
}

export interface MuxSocketOptions {
  /** 平台会话与成员状态校验；与 HTTP 面共用同一套判定。 */
  readonly resolve: (req: IncomingMessage) => Promise<SocketCaller | undefined>
  readonly sse: SseRuntime
}

export interface MuxSocket {
  /**
   * 接管一条 Upgrade。
   * @returns true 表示路径属于本模块（已处理或已拒绝）；false 交给其它监听者。
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
}

/**
 * 安装浏览器 mux socket。
 * @param options - 授权回调与共用的流运行时。
 * @returns Upgrade 入口与关停函数。
 */
export function createMuxSocket(options: MuxSocketOptions): MuxSocket {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  const sockets = new Set<WebSocket>()

  const accept = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const caller = await options.resolve(req).catch(() => undefined)
    if (caller === undefined) {
      reject(socket, 401, 'unauthorized')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => onOpen(ws, caller.deps))
  }

  const onOpen = (ws: WebSocket, deps: RemoteDeps): void => {
    sockets.add(ws)
    const muxId = options.sse.mount(carrierOf(ws), deps)
    // 和 `P/sse/$mux` 的首帧一致：页面据此认定物理连接可用，之后才发开关。
    send(ws, { type: 'ready', mux: muxId })

    // 半开连接不会触发 close；错过的 pong 直接 terminate，让通道的 close
    // 钩子（watcher 退订、轮询计时器）照常执行。
    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        /* closing */
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    ws.on('pong', () => {
      alive = true
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let message: Record<string, unknown>
      try {
        const parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
        message = parsed as Record<string, unknown>
      } catch {
        return
      }
      void handleUplink(options.sse, ws, muxId, deps, message)
    })

    const finish = (): void => {
      clearInterval(heartbeat)
      sockets.delete(ws)
    }
    ws.on('close', finish)
    ws.on('error', finish)
  }

  return {
    upgrade(req, socket, head) {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path !== MUX_SOCKET_PATH) return false
      void accept(req, socket, head).catch(() => {
        if (!socket.destroyed) socket.destroy()
      })
      return true
    },
    close() {
      for (const ws of sockets) ws.terminate()
      sockets.clear()
      wss.close()
    },
  }
}

/**
 * 一条带内上行消息。
 *
 * - `{type:'open', rpcId, channel, endpoint, payload}`：开逻辑通道，回
 *   `server-response` 信封（与 HTTP 控制面同一形状）；
 * - `{type:'close', channel}`：关逻辑通道，无回执；
 * - `{type:'answer', rpcId, eventId, outcome}`：审批 / 计划评审答复；
 * - `{type:'questions-answer', rpcId, callId, answer}`：提问答复。
 *
 * 答复走带内是为了和下行落在同一条连接上；失败按信封回给页面，页面据此提示，
 * 不再回退 HTTP（同一张待答表，重复结算只会得到 false）。
 */
async function handleUplink(
  sse: SseRuntime,
  ws: WebSocket,
  muxId: string,
  deps: RemoteDeps,
  message: Record<string, unknown>,
): Promise<void> {
  const type = message.type
  if (type === 'close') {
    const channel = text(message.channel)
    if (channel !== undefined) sse.closeChannel(muxId, channel, deps)
    return
  }
  const rpcId = text(message.rpcId) ?? ''
  try {
    if (type === 'open') {
      const channel = text(message.channel)
      const endpoint = text(message.endpoint)
      if (channel === undefined || endpoint === undefined) throw new HttpError(400, 'gateway/bad-request')
      await sse.openChannel(muxId, channel, endpoint, message.payload, deps)
      send(ws, remoteSucceededValue(rpcId, { ok: true }))
      return
    }
    if (type === 'answer') {
      const eventId = text(message.eventId)
      if (eventId === undefined) throw new HttpError(400, 'gateway/bad-request')
      send(ws, remoteSucceededValue(rpcId, await answerForwardedEvent(deps, eventId, message.outcome)))
      return
    }
    if (type === 'questions-answer') {
      const callId = text(message.callId)
      if (callId === undefined) throw new HttpError(400, 'gateway/bad-request')
      send(ws, remoteSucceededValue(rpcId, await answerUserQuestion(deps, callId, message.answer)))
    }
  } catch (error) {
    if (error instanceof HttpError) {
      send(ws, remoteFailedValue(rpcId, mapErrorCode(error.code), error.code, error.details))
      return
    }
    send(ws, remoteFailedValue(rpcId, 'gateway/internal', error instanceof Error ? error.message : 'internal'))
  }
}

function send(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
}

/** 载体：把 ws 适配成 mux 的 `Channel`。 */
function carrierOf(ws: WebSocket): Channel {
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
  const write = (value: unknown): void => {
    if (closed || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(value))
  }
  ws.on('close', finish)
  ws.on('error', finish)
  return {
    get closed() {
      return closed || ws.readyState !== WebSocket.OPEN
    },
    send(value) {
      write(value)
    },
    fail(error) {
      write({
        type: 'error',
        error: { code: error instanceof HttpError ? error.code : 'gateway/internal', message: error instanceof Error ? error.message : String(error) },
      })
      finish()
    },
    close() {
      finish()
      try {
        ws.close(1000)
      } catch {
        /* already closing */
      }
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

/** 拒绝一条不该成为 socket 的 Upgrade。 */
function reject(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed) return
  const body = JSON.stringify({ code: 1, msg: code, data: null })
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Error'}\r\n`
    + 'content-type: application/json; charset=utf-8\r\n'
    + `content-length: ${Buffer.byteLength(body)}\r\n`
    + 'connection: close\r\n'
    + '\r\n'
    + body,
  )
  socket.destroy()
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}