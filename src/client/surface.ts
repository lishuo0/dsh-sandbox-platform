/**
 * 登录之后把 DSH 客户端页面交给浏览器，并把客户端的 `/api` 转到脑。
 * 转到脑之前先看 `dsh_sessions`：这条会话不属于当前成员，就当作不存在。
 */

import { createReadStream, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { extname, resolve, sep } from 'node:path'
import type { AppConfig } from '../config.js'
import type { Db } from '../kernel/db.js'
import { readToken, signToken } from '../kernel/tokens.js'
import { authenticate } from '../modules/identity/service.js'
import type { ClientHost } from './host.js'
import { decodeFrames, encodeFrame, MessagePump } from './frames.js'
import {
  createdSessionId,
  denied,
  filterSessionPayload,
  hiddenProjection,
  isCreate,
  requestedCwd,
  sessionAccess,
  sessionIdsIn,
  type SessionAccess,
} from './scope.js'

export const PLATFORM_COOKIE = 'platform_session'

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

export interface ClientSurface {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

/** 平台页面：未登录看到登录，登录后是 DSH 客户端。`/api` 原样转到脑。 */
export function createClientSurface(cfg: AppConfig, db: Db, client: ClientHost): ClientSurface {
  return {
    handle: (req, res) => handle(cfg, db, client, req, res),
    upgrade: (req, socket, head) => {
      const userId = currentUser(cfg, req)
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!userId || !path.startsWith('/api')) {
        socket.destroy()
        return
      }
      proxyUpgrade(cfg, db, userId, req, socket, head)
    },
  }
}

async function handle(cfg: AppConfig, db: Db, client: ClientHost, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path.startsWith('/dsh-api/')) return false

  if (path === '/login' && req.method === 'POST') {
    await login(cfg, db, req, res)
    return true
  }
  if (path === '/connect' || path.startsWith('/api')) {
    const userId = currentUser(cfg, req)
    if (!userId) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return true
    }
    await proxyWeb(cfg, db, userId, req, res)
    return true
  }
  if (path.startsWith('/plugins')) {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
    }
    const plugin = await client.fetchPlugin(`${path}${url.search}`, req.method ?? 'GET', headers)
    if (plugin === undefined) return false
    await writeFetch(res, plugin)
    return true
  }
  if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!currentUser(cfg, req)) {
      sendHtml(res, req.method === 'HEAD', loginPage())
      return true
    }
    sendHtml(res, req.method === 'HEAD', client.indexHtml)
    return true
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = safeFile(client.shellRoot, path)
    if (file !== undefined) {
      sendFile(res, req.method === 'HEAD', file)
      return true
    }
  }
  return false
}

async function login(cfg: AppConfig, db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readForm(req)
  const member = await authenticate(db, body.get('username') ?? '', body.get('password') ?? '')
  if (!member) {
    sendHtml(res, false, loginPage('账号或密码不对'), 401)
    return
  }
  const launch = await clientToken(cfg)
  if (!launch) {
    sendHtml(res, false, loginPage('脑还没有准备好，稍后再登录'), 502)
    return
  }
  const token = signToken(cfg.auth.tokenSecret, member.id, cfg.auth.tokenTtlHours)
  const maxAge = cfg.auth.tokenTtlHours * 3600
  res.writeHead(302, {
    location: `/connect?token=${encodeURIComponent(launch)}`,
    'set-cookie': `${PLATFORM_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    'cache-control': 'no-store',
  })
  res.end()
}

async function clientToken(cfg: AppConfig): Promise<string | undefined> {
  try {
    const response = await fetch(`${cfg.brain.baseUrl}/brain/v1/client-token`, {
      headers: {
        'x-app-id': cfg.brain.appId,
        'x-app-key': cfg.brain.appKey,
      },
    })
    if (!response.ok) return undefined
    const body = await response.json() as { token?: string }
    return body.token
  } catch {
    return undefined
  }
}

export function currentUser(cfg: AppConfig, req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const token = bearer || cookie(req, PLATFORM_COOKIE)
  if (!token) return undefined
  return readToken(cfg.auth.tokenSecret, token)?.sub
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

function loginPage(error = ''): string {
  const message = error ? `<p>${escapeHtml(error)}</p>` : ''
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>登录</title></head>
<body>
  <form method="post" action="/login">
    ${message}
    <label>用户名 <input name="username" autocomplete="username" required></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录</button>
  </form>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

function sendHtml(res: ServerResponse, head: boolean, html: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(head ? undefined : html)
}

function safeFile(root: string, path: string): string | undefined {
  const relative = decodeURIComponent(path).replace(/^\/+/, '')
  if (!relative || relative.includes('\0')) return undefined
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  try {
    if (!statSync(target).isFile()) return undefined
  } catch {
    return undefined
  }
  return target
}

function sendFile(res: ServerResponse, head: boolean, file: string): void {
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  if (head) {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

async function writeFetch(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    res.write(chunk.value)
  }
  res.end()
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

async function readBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function proxyWeb(cfg: AppConfig, db: Db, userId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const json = String(req.headers['content-type'] ?? '').includes('application/json')
  const access = sessionAccess(db, userId)
  if (path === '/api/session/uploadFileBinary') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!sessionId || !await access.allows(sessionId)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('session not found')
      return
    }
  }
  let body: Buffer | undefined
  if (req.method === 'POST' && json && path.startsWith('/api/')) {
    body = await readBuffer(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined && await blocks(access, parsed)) {
      const rpcId = typeof parsed === 'object' && parsed !== null ? (parsed as { rpcId?: unknown }).rpcId : undefined
      const text = denied(rpcId)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
  }
  await new Promise<void>((resolve) => {
    const target = new URL(req.url ?? '/', cfg.brain.baseUrl)
    const headers = forwardHeaders(req, body)
    const lib = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = lib(target, { method: req.method, headers }, (up) => {
      const responseHeaders = { ...up.headers }
      const location = responseHeaders.location
      if (typeof location === 'string' && location.includes('remote.mux')) responseHeaders.location = '/'
      const type = String(responseHeaders['content-type'] ?? '')
      if (body !== undefined && type.includes('application/json') && path.startsWith('/api/session/')) {
        const chunks: Buffer[] = []
        up.on('data', (chunk: Buffer) => chunks.push(chunk))
        up.on('end', () => {
          void finishJson(res, up.statusCode ?? 502, responseHeaders, Buffer.concat(chunks), access, path, parsedOf(body)).then(resolve)
        })
        return
      }
      res.writeHead(up.statusCode ?? 502, responseHeaders)
      up.pipe(res)
      res.on('finish', resolve)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('brain-unreachable')
      resolve()
    })
    if (body !== undefined) upstream.end(body)
    else req.pipe(upstream)
  })
}

async function blocks(access: SessionAccess, parsed: unknown): Promise<boolean> {
  const payload = typeof parsed === 'object' && parsed !== null ? (parsed as { payload?: unknown }).payload ?? parsed : parsed
  for (const id of sessionIdsIn(payload)) if (!await access.allows(id)) return true
  return false
}

function parsedOf(body: Buffer | undefined): unknown {
  if (body === undefined) return undefined
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

async function finishJson(
  res: ServerResponse,
  status: number,
  headers: NodeJS.Dict<string | string[] | undefined>,
  raw: Buffer,
  access: SessionAccess,
  path: string,
  request: unknown,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    delete headers['content-length']
    delete headers['transfer-encoding']
    res.writeHead(status, { ...headers, 'content-length': raw.length })
    res.end(raw)
    return
  }
  if (isCreate(path)) {
    const id = createdSessionId(parsed)
    if (id && !await access.allows(id)) await access.claim(id, requestedCwd(request))
  }
  const text = JSON.stringify(filterSessionPayload(parsed, await access.ids()))
  delete headers['content-length']
  delete headers['transfer-encoding']
  res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function forwardHeaders(req: IncomingMessage, body: Buffer | undefined): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: req.headers.host, 'accept-encoding': 'identity' }
  if (body !== undefined) headers['content-length'] = String(body.length)
  return headers
}

function proxyUpgrade(cfg: AppConfig, db: Db, userId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = new URL(req.url ?? '/', cfg.brain.baseUrl)
  const lib = target.protocol === 'https:' ? httpsRequest : httpRequest
  const access = sessionAccess(db, userId)
  const upstream = lib({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers: { ...req.headers, host: req.headers.host },
  })
  upstream.on('upgrade', (up, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? 'Switching Protocols'}`]
    for (const [key, value] of Object.entries(up.headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    bindFrames(access, socket, upSocket, head, upHead)
  })
  upstream.on('error', () => socket.destroy())
  upstream.on('response', () => socket.destroy())
  upstream.end()
}

function bindFrames(access: SessionAccess, browser: Duplex, brain: Duplex, browserHead: Buffer, brainHead: Buffer): void {
  const fromBrowser = new MessagePump()
  const fromBrain = new MessagePump()
  let browserBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let brainBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let browserChain = Promise.resolve()
  let brainChain = Promise.resolve()
  const writeBrain = (chunk: Buffer): void => {
    brain.write(chunk)
  }
  const writeBrowser = (chunk: Buffer): void => {
    browser.write(chunk)
  }
  const takeBrowser = (chunk: Buffer): void => {
    browserBuf = Buffer.concat([browserBuf, chunk])
    let decoded: ReturnType<typeof decodeFrames>
    try {
      decoded = decodeFrames(browserBuf)
    } catch {
      browser.destroy()
      brain.destroy()
      return
    }
    browserBuf = decoded.rest
    for (const frame of decoded.frames) {
      for (const message of fromBrowser.push(frame)) {
        if (message.kind === 'raw') {
          for (const raw of message.frames) writeBrain(raw.raw)
          continue
        }
        browserChain = browserChain.then(() => guardClient(access, message.text, message.raw, writeBrain, writeBrowser)).catch(() => {
          browser.destroy()
          brain.destroy()
        })
      }
    }
  }
  const takeBrain = (chunk: Buffer): void => {
    brainBuf = Buffer.concat([brainBuf, chunk])
    let decoded: ReturnType<typeof decodeFrames>
    try {
      decoded = decodeFrames(brainBuf)
    } catch {
      browser.destroy()
      brain.destroy()
      return
    }
    brainBuf = decoded.rest
    for (const frame of decoded.frames) {
      for (const message of fromBrain.push(frame)) {
        if (message.kind === 'raw') {
          for (const raw of message.frames) writeBrowser(raw.raw)
          continue
        }
        brainChain = brainChain.then(() => guardServer(access, message.text, writeBrowser)).catch(() => {
          browser.destroy()
          brain.destroy()
        })
      }
    }
  }
  browser.on('data', takeBrowser)
  brain.on('data', takeBrain)
  browser.on('error', () => brain.destroy())
  brain.on('error', () => browser.destroy())
  browser.on('end', () => brain.end())
  brain.on('end', () => browser.end())
  if (browserHead.length > 0) takeBrowser(browserHead)
  if (brainHead.length > 0) takeBrain(brainHead)
}

async function guardClient(
  access: SessionAccess,
  text: string,
  raw: Buffer,
  writeBrain: (chunk: Buffer) => void,
  writeBrowser: (chunk: Buffer) => void,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    writeBrain(raw)
    return
  }
  const message = parsed as { type?: unknown; streamId?: unknown; payload?: unknown }
  if (message.type === 'open') {
    const ids = sessionIdsIn(message.payload)
    for (const id of ids) {
      if (await access.allows(id)) continue
      const streamId = typeof message.streamId === 'string' ? message.streamId : ''
      const error = JSON.stringify({
        type: 'error',
        streamId,
        error: { code: 'session/not-found', message: 'session not found', details: {} },
      })
      const end = JSON.stringify({ type: 'end', streamId })
      writeBrowser(encodeFrame(1, Buffer.from(error)))
      writeBrowser(encodeFrame(1, Buffer.from(end)))
      return
    }
  }
  writeBrain(raw)
}

async function guardServer(access: SessionAccess, text: string, writeBrowser: (chunk: Buffer) => void): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    writeBrowser(encodeFrame(1, Buffer.from(text)))
    return
  }
  const owned = await access.ids()
  if (hiddenProjection(parsed, owned)) return
  const filtered = filterSessionPayload(parsed, owned)
  writeBrowser(encodeFrame(1, Buffer.from(JSON.stringify(filtered))))
}
