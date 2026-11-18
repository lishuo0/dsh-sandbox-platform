import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { HttpError } from './errors.js'
import type { AppConfig } from '../config.js'
import type { Db } from './db.js'
import type { ClientSurface } from '../client/surface.js'
import { currentUser } from '../client/surface.js'

export { API_PREFIX, MUST_CHANGE_ALLOWED } from './access.js'
import { API_PREFIX, MUST_CHANGE_ALLOWED } from './access.js'

const JSON_LIMIT = 1_000_000
const RAW_LIMIT = 64 * 1024 * 1024

export interface Actor {
  id: string
  displayName: string
  role: 'admin' | 'member'
  status: string
  /** 管理员开户 / 重置密码后为真；客户端据此强制弹改密框。 */
  mustChangePassword: boolean
}

export interface RequestCtx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  actor?: Actor
  json<T>(): Promise<T>
  raw(): Promise<Buffer>
  send(status: number, body: unknown): void
}

export interface Route {
  method: string
  path: string
  auth: 'public' | 'member' | 'admin'
  handle(ctx: RequestCtx): Promise<void>
}

interface CompiledRoute extends Route {
  names: string[]
  pattern: RegExp
}

export function startHttp(cfg: AppConfig, db: Db, routes: Route[], surface: ClientSurface): Server {
  const compiled = routes.map(compile)
  const server = createServer((req, res) => {
    void (async () => {
      if (await surface.handle(req, res)) return
      await dispatch(cfg, db, compiled, req, res)
    })()
  })
  // 平台没有 Upgrade 面：客户端所有逻辑流都走统一前缀下的 SSE。未注册
  // `upgrade` 监听时 Node 会直接断开（非 101），不会把浏览器放进任何隧道。
  server.listen(cfg.http.port, cfg.http.host)
  return server
}

async function dispatch(cfg: AppConfig, db: Db, routes: CompiledRoute[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.startsWith(API_PREFIX)
    ? url.pathname.slice(API_PREFIX.length) || '/'
    : ''
  if (path === '') {
    send(res, 404, { code: 1, msg: 'not-found', data: null })
    return
  }
  const hits = routes.filter((route) => route.pattern.test(path))
  const route = hits.find((item) => item.method === req.method)
  if (!route) {
    send(res, hits.length ? 405 : 404, { code: 1, msg: hits.length ? 'method-not-allowed' : 'not-found', data: null })
    return
  }
  let params: Record<string, string>
  try {
    params = readParams(route, path)
  } catch {
    // 畸形百分号编码不该变成 500；路径参数不合法就是坏请求。
    send(res, 400, { code: 1, msg: 'invalid-path', data: null })
    return
  }
  const ctx: RequestCtx = {
    req,
    res,
    url,
    params,
    json: async <T>() => parseJson<T>(await readBody(req, JSON_LIMIT)),
    raw: () => readBody(req, RAW_LIMIT),
    send: (status, body) => send(res, status, body),
  }
  try {
    if (route.auth !== 'public') {
      ctx.actor = await actorOf(cfg, db, req)
      if (!ctx.actor) {
        send(res, 401, { code: 1, msg: 'unauthorized', data: null })
        return
      }
      if (route.auth === 'admin' && ctx.actor.role !== 'admin') {
        send(res, 403, { code: 1, msg: 'forbidden', data: null })
        return
      }
      if (ctx.actor.mustChangePassword && !(MUST_CHANGE_ALLOWED as readonly string[]).includes(path)) {
        send(res, 403, { code: 1, msg: 'must-change-password', data: null })
        return
      }
    }
    await route.handle(ctx)
  } catch (error) {
    if (res.headersSent) return
    if (error instanceof HttpError) {
      send(res, error.status, { code: 1, msg: error.code, data: null })
      return
    }
    if (error instanceof SyntaxError) {
      send(res, 400, { code: 1, msg: 'invalid-json', data: null })
      return
    }
    send(res, 500, { code: 1, msg: error instanceof Error ? error.message : 'internal', data: null })
  }
}

function compile(route: Route): CompiledRoute {
  const names: string[] = []
  const source = route.path
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { ...route, names, pattern: new RegExp(`^${source}$`) }
}

function readParams(route: CompiledRoute, path: string): Record<string, string> {
  const match = route.pattern.exec(path)
  const params: Record<string, string> = {}
  route.names.forEach((name, index) => {
    params[name] = decodeURIComponent(match?.[index + 1] ?? '')
  })
  return params
}

async function actorOf(cfg: AppConfig, db: Db, req: IncomingMessage): Promise<Actor | undefined> {
  const userId = currentUser(cfg, req)
  if (!userId) return undefined
  const rows = await db.query(
    `SELECT id, display_name, role, status, must_change_password FROM dsh_users WHERE id = $1`,
    [userId],
  )
  const row = rows.rows[0] as
    | { id: string; display_name: string; role: string; status: string; must_change_password: unknown }
    | undefined
  if (!row || row.status !== 'active') return undefined
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'member',
    status: row.status,
    mustChangePassword: row.must_change_password === true || row.must_change_password === 1 || row.must_change_password === '1' || row.must_change_password === 't',
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new HttpError(413, 'body-too-large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson<T>(body: Buffer): T {
  if (!body.length) return {} as T
  return JSON.parse(body.toString('utf8')) as T
}
