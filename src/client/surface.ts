/**
 * 登录之后把 DSH 客户端页面交给浏览器，并在统一前缀
 * `/dsh-api/platform/v1` 下提供它要的全部接口。
 *
 * 前缀之外没有平台路由：客户端页面不再直接请求脑，也不再建立全局
 * WebSocket。所有 Remote 调用由 `__DSH_TRANSPORT__` 改写到 `P/remote`，
 * 所有逻辑流走 `P/sse`，会话实时面是 `P/sessions/{id}/stream`。
 */

import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { decodeKey, type AppConfig } from '../config.js'
import type { Db } from '../kernel/db.js'
import { createObjectStore, type ObjectStore } from '../kernel/objects.js'
import { HttpError } from '../kernel/errors.js'
import { readToken, signToken } from '../kernel/tokens.js'
import { BrainClient } from '../brain/client.js'
import { authenticate } from '../modules/identity/service.js'
import { CONTEXT_PREFIX, handleContext } from '../modules/context/api.js'
import { handleWorkspaceUpload } from '../modules/workspaces/upload.js'
import type { ClientHost } from './host.js'
import { prepareClientHome } from './workspaces.js'
import { GENUI_ASSET_PREFIX, genuiAsset } from './genui-assets.js'
import { BOOT_ASSET_PREFIX, matchBootAsset } from './boot-assets.js'
import { createSessionStreamRelay, type SessionStreamRelay } from './mux/stream.js'
import { handleRemote, type RemoteDeps } from './mux/router.js'
import { createSseRuntime, type SseRuntime } from './mux/sse.js'
import { createQueueService, type QueueService } from './mux/queue.js'
import { createSessionWatchers, type SessionWatchers } from './mux/watchers.js'
import { createForwardedEvents, type ForwardedEvents } from './mux/events.js'
import { remoteEndpoint, sseEndpoint } from './mux/wire.js'
import { handleSessionUpload } from './upload.js'

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
}

/** 平台页面：未登录看到登录，登录后是跑在平台载体上的 DSH 客户端。 */
export function createClientSurface(cfg: AppConfig, db: Db, client: ClientHost): ClientSurface {
  const brain = new BrainClient(cfg)
  const credentialsKey = decodeKey(cfg.credentialsKey)
  const objects = createObjectStore(cfg)
  // 会话级 SSE：一条流一个会话，平台自己做授权与到脑的中转。
  const sessionStream = createSessionStreamRelay({
    db,
    objects,
    brain,
    resolveUser: (req) => currentUser(cfg, req),
    isActiveUser: (userId) => activeUser(db, userId),
  })
  // 统一前缀下的 Remote 面：一条 unary 分发 + 一条 SSE 承载 + 平台自己的输入队列。
  const queue = createQueueService({ db, objects, brain })
  const watchers = createSessionWatchers({ brain })
  const events = createForwardedEvents()
  const sse = createSseRuntime()
  recoverQueue(db, queue)
  return {
    handle: (req, res) => handle(cfg, db, client, brain, objects, credentialsKey, sessionStream, {
      queue,
      watchers,
      events,
      sse,
    }, req, res),
  }
}

/** 统一前缀下的 Remote 运行时：unary、SSE 与平台输入队列。 */
interface ClientMux {
  readonly queue: QueueService
  readonly watchers: SessionWatchers
  readonly events: ForwardedEvents
  readonly sse: SseRuntime
}

async function handle(
  cfg: AppConfig,
  db: Db,
  client: ClientHost,
  brain: BrainClient,
  objects: ObjectStore,
  credentialsKey: Buffer,
  sessionStream: SessionStreamRelay,
  mux: ClientMux,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const remote = remoteEndpoint(path)
  const stream = sseEndpoint(path)
  if (remote !== undefined || stream !== undefined) {
    // 统一前缀下的所有面都先认人；跨租户在分发器里按「不存在」处理。
    const userId = currentUser(cfg, req)
    if (!userId || !(await activeUser(db, userId))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return true
    }
    const deps: RemoteDeps = {
      db,
      objects,
      brain,
      credentialsKey,
      userId,
      queue: mux.queue,
      watchers: mux.watchers,
      events: mux.events,
    }
    if (remote !== undefined) {
      // 多路复用控制面：逻辑流的开关必须落在发起它的那条物理流上。
      if (remote === '$mux/open' || remote === '$mux/close') {
        return await mux.sse.control(req, res, remote, deps)
      }
      return handleRemote(req, res, remote, deps)
    }
    try {
      return await mux.sse.handle(req, res, stream as string, deps)
    } catch (error) {
      // 流还没开：按平台错误信封回，浏览器侧不会把半截 SSE 当真。
      if (res.headersSent) {
        res.end()
        return true
      }
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'gateway/internal'
      const text = JSON.stringify({ code: 1, msg: code, data: null })
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      })
      res.end(text)
      return true
    }
  }
  if (path.startsWith('/dsh-api/')) {
    // 会话实时面在统一前缀下，但要走流式响应与自己的授权顺序，所以先于 Route 表。
    if (await sessionStream.handleStream(req, res, path)) return true
    if (await sessionStream.handleAnswer(req, res, path)) return true
    // 不是会话流：继续落到统一前缀下的其它平台面（上传、上下文、外壳）。
  }
  // 启动资产（如传输适配）：内容寻址的 classic script。和外壳静态文件一样
  // 不认人——正文对所有成员相同、不含租户数据。rev 命中下发 immutable 强缓存；
  // 旧页面带来的旧 rev 仍返回当前正文，但不写强缓存。
  if (path.startsWith(`${BOOT_ASSET_PREFIX}/`)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return true
    }
    const matched = matchBootAsset(path, url.searchParams.get('rev'))
    if (matched === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return true
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(matched.asset.body),
      'cache-control': matched.fresh ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : matched.asset.body)
    return true
  }

  if (path === '/login' && req.method === 'POST') {
    await login(cfg, db, req, res)
    return true
  }
  if (path === '/logout' && req.method === 'POST') {
    // 只清平台会话；脑侧的连接 cookie 随下次加载页面重新签发。
    res.writeHead(204, {
      'set-cookie': `${PLATFORM_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureSuffix(req)}`,
      'cache-control': 'no-store',
    })
    res.end()
    return true
  }
  // 平台浏览器面的其余入口都在统一前缀下：字节直传、工作区文件上传、
  // 上下文洞察。认人失败直接 401，不进入任何下游调用。
  if (
    path === '/dsh-api/platform/v1/upload'
    || path === '/dsh-api/platform/v1/workspaceFiles/upload'
    || path.startsWith(CONTEXT_PREFIX)
  ) {
    const userId = currentUser(cfg, req)
    if (!userId || !(await activeUser(db, userId))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return true
    }
    if (path === '/dsh-api/platform/v1/workspaceFiles/upload') {
      await handleWorkspaceUpload({ db, objects, userId }, req, res)
      return true
    }
    if (path.startsWith(CONTEXT_PREFIX)) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      let body: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse((await readBuffer(req)).toString('utf8') || '{}') as unknown
        body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined
      } catch {
        body = undefined
      }
      await handleContext({ config: cfg, db, objects, brain, credentialsKey }, userId, path, body, res)
      return true
    }
    await handleSessionUpload({ db, objects, credentialsKey, userId }, req, res)
    return true
  }
  // genui 的懒加载脚本是 `.js`，client-modules 的 `/plugins` 路由只放行图片，
  // 必须在通用 `/plugins` 分支之前单独应答。
  if (path.startsWith(GENUI_ASSET_PREFIX)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return true
    }
    const file = genuiAsset(path)
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return true
    }
    sendAssetFile(res, req.method === 'HEAD', file)
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
    const userId = currentUser(cfg, req)
    if (!userId || !(await activeUser(db, userId))) {
      sendHtml(res, req.method === 'HEAD', loginPage())
      return true
    }
    // 首页的输入框要等成员选中一块工作区才解锁（选择器只列脑投影里的工作区）。
    // 先保证成员至少有一块默认工作区，并让脑重新投影；脑暂时不可达不挡页面。
    if (req.method === 'GET') {
      try {
        await prepareClientHome({ db, objects, brain, userId })
      } catch {
        // 登录后连不上脑本来就会在客户端提示，这里不让页面 500。
      }
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

/** 重启后把落库的排队消息重新挂上泵；队列本身不丢。 */
function recoverQueue(db: Db, queue: QueueService): void {
  void (async () => {
    const rows = await db.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM dsh_session_queue`,
    ).catch(() => undefined)
    for (const row of rows?.rows ?? []) queue.wake(row.session_id)
  })()
}

async function login(cfg: AppConfig, db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readForm(req)
  const member = await authenticate(db, body.get('username') ?? '', body.get('password') ?? '')
  if (!member) {
    sendHtml(res, false, loginPage('账号或密码不对'), 401)
    return
  }
  const token = signToken(cfg.auth.tokenSecret, member.id, cfg.auth.tokenTtlHours)
  const maxAge = cfg.auth.tokenTtlHours * 3600
  res.writeHead(302, {
    location: '/',
    'set-cookie': `${PLATFORM_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secureSuffix(req)}`,
    'cache-control': 'no-store',
  })
  res.end()
}

/**
 * 只有确实走 HTTPS 时才加 `Secure`。
 *
 * 本地开发是明文 HTTP，加上 `Secure` 浏览器就不会回传登录 cookie。反代后面
 * 由 `x-forwarded-proto` 告诉平台真实协议。
 */
function secureSuffix(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted)
  return encrypted || proto === 'https' ? '; Secure' : ''
}

export function currentUser(cfg: AppConfig, req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const token = bearer || cookie(req, PLATFORM_COOKIE)
  if (!token) return undefined
  return readToken(cfg.auth.tokenSecret, token)?.sub
}

/**
 * 平台会话 cookie 里的成员是否还能用。
 *
 * 签名只证明 token 是自己签的；成员被停用或删除后，token 在过期前依然有效。
 * 管理接口那边（`actorOf`）一直回查 `dsh_users.status`，客户端代理面也必须一致，
 * 否则被移除的成员还能继续读写自己的工作区和历史。
 */
async function activeUser(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query(`SELECT 1 FROM dsh_users WHERE id = $1 AND status = 'active'`, [userId])
  return rows.rows.length > 0
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
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : ''
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>登录 · Agent 平台</title>
<link rel="icon" href="/favicon.svg">
<style>
  :root {
    --page: #f5f7fa;
    --card: #ffffff;
    --text: #0f1115;
    --muted: #61666b;
    --border: rgba(0, 0, 0, 0.1);
    --field: #ffffff;
    --ring: rgba(65, 118, 230, 0.32);
    --accent: #4176e6;
    --button: #0f1115;
    --button-text: #ffffff;
    --button-hover: #2c2c2e;
    --error: #ec1313;
    --shadow: 0 16px 48px rgba(15, 17, 21, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #151517;
      --card: #1b1b1c;
      --text: #f9fafb;
      --muted: #adb2b8;
      --border: rgba(255, 255, 255, 0.12);
      --field: #212123;
      --ring: rgba(122, 170, 255, 0.32);
      --accent: #7aaaff;
      --button: #f9fafb;
      --button-text: #0f1115;
      --button-hover: #e9ecf2;
      --error: #f25a5a;
      --shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--page);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 360px;
    padding: 28px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 24px;
  }
  .brand img { width: 26px; height: 26px; }
  .brand strong { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .brand span { color: var(--muted); font-size: 12px; }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .sub { margin: 0 0 22px; color: var(--muted); }
  label { display: block; margin-bottom: 16px; font-size: 13px; color: var(--muted); }
  label span { display: block; margin-bottom: 6px; }
  input {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--field);
    color: var(--text);
    font: inherit;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
  button {
    width: 100%;
    height: 40px;
    border: 0;
    border-radius: 10px;
    background: var(--button);
    color: var(--button-text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, transform 0.05s;
  }
  button:hover { background: var(--button-hover); }
  button:active { transform: translateY(1px); }
  .error {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--error) 10%, transparent);
    color: var(--error);
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><img src="/favicon.svg" alt=""><strong>Agent 平台</strong><span>DSH</span></div>
  <h1>登录</h1>
  <p class="sub">使用平台账号继续</p>
  ${message}
  <form method="post" action="/login">
    <label><span>用户名</span><input name="username" autocomplete="username" required autofocus></label>
    <label><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录</button>
  </form>
</main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

function sendHtml(res: ServerResponse, head: boolean, html: string, status = 200, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(status, headers)
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

/** genui 引擎脚本按版本固定，可以长缓存；禁止浏览器猜类型。 */
function sendAssetFile(res: ServerResponse, head: boolean, file: string): void {
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
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
