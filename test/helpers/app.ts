import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AppConfig } from '../../src/config.js'
import type { Db } from '../../src/kernel/db.js'
import { createDeps, type Deps } from '../../src/app/deps.js'
import { startHttp } from '../../src/kernel/http.js'
import type { Route } from '../../src/kernel/http.js'
import { attachmentRoutes } from '../../src/modules/attachments/routes.js'
import { feedbackRoutes } from '../../src/modules/feedback/routes.js'
import { groupRoutes } from '../../src/modules/groups/routes.js'
import { bootstrapAdmin, identityRoutes } from '../../src/modules/identity/routes.js'
import { mcpRoutes } from '../../src/modules/mcp/routes.js'
import { modelRoutes } from '../../src/modules/models/routes.js'
import { opsRoutes } from '../../src/modules/ops/routes.js'
import { scheduleRoutes } from '../../src/modules/schedule/routes.js'
import { sessionRoutes } from '../../src/modules/sessions/routes.js'
import { skillRoutes } from '../../src/modules/skills/routes.js'
import { superagentRoutes } from '../../src/modules/superagent/routes.js'
import { workspaceRoutes } from '../../src/modules/workspaces/routes.js'
import { createTestDatabase, testSecrets, type TestDatabase } from './pg.js'

export const API = '/dsh-api/platform/v1'

const routeFactories = [
  identityRoutes,
  modelRoutes,
  workspaceRoutes,
  sessionRoutes,
  skillRoutes,
  mcpRoutes,
  groupRoutes,
  feedbackRoutes,
  attachmentRoutes,
  scheduleRoutes,
  superagentRoutes,
  opsRoutes,
]

export interface TestPlatform {
  baseUrl: string
  config: AppConfig
  deps: Deps
  db: Db
  storageDir: string
  server: Server
  close(): Promise<void>
}

export interface StartOptions {
  brainBaseUrl?: string
  /** 复用一个外部的测试库（联合测试用）。 */
  database?: TestDatabase
  /** 额外的路由，例如联合测试里不需要。 */
  extraRoutes?: Route[]
  /** 覆盖测试配置里的字段，例如 `tokenPlan`。 */
  config?: Partial<AppConfig>
}

/** 构造一份完全在内存里的 AppConfig，不读 config.yaml。 */
export function testConfig(overrides: Partial<AppConfig> & { storageDir: string; databaseUrl?: string }): AppConfig {
  const secrets = testSecrets()
  const { databaseUrl, ...rest } = overrides
  return {
    database: rest.database ?? { url: databaseUrl ?? 'postgres://127.0.0.1:1/none' },
    aliyun: {
      sandbox: { apiKey: '', apiUrl: 'https://sandbox.invalid', domain: 'sandbox.invalid', template: '', roleArn: '' },
      oss: { region: 'cn-test', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' },
    },
    http: { host: '127.0.0.1', port: overrides.http?.port ?? 0 },
    auth: {
      tokenSecret: secrets.tokenSecret,
      tokenTtlHours: 24,
      adminUsername: 'admin',
      adminPassword: 'admin-password-123',
    },
    credentialsKey: secrets.credentialKey,
    brain: {
      baseUrl: overrides.brainBaseUrl ?? 'http://127.0.0.1:1',
      appId: 'platform',
      appKey: secrets.appKey,
    },
    storage: { dir: rest.storageDir },
    ...rest,
  } as AppConfig
}

/** 启动一个真实的平台 HTTP 服务（真实路由、真实 PG、本地对象目录）。 */
export async function startTestPlatform(options: StartOptions = {}): Promise<TestPlatform> {
  const database = options.database ?? (await createTestDatabase(['platform']))
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-platform-objects-'))
  const port = await freePort()
  const config = testConfig({
    ...(options.config ?? {}),
    database: database.config,
    storageDir,
    brainBaseUrl: options.brainBaseUrl,
    http: { host: '127.0.0.1', port },
  })
  const deps = createDeps(config, database.pool)
  // 和 src/main.ts 一样先建管理员，测试才能用 config 里的凭据登录。
  await bootstrapAdmin(deps)
  const routes = routeFactories.flatMap((mount) => mount(deps))
  // 默认测试栈只接统一前缀下的 HTTP 面；需要 Upgrade 的用例自己装配 surface。
  const server = startHttp(config, database.pool, [...routes, ...(options.extraRoutes ?? [])], {
    handle: async () => false,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    deps,
    db: database.pool,
    storageDir,
    server,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await database.drop()
      await rm(storageDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('无法分配端口'))
        else resolve(address.port)
      })
    })
  })
}

export interface ApiResponse<T = unknown> {
  status: number
  body: { code: number; msg: string; data: T }
  text: string
}

/** 发一次平台 API 请求。 */
export async function api<T = unknown>(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  let body: BodyInit | undefined
  if (init.raw !== undefined) {
    body = new Uint8Array(init.raw)
    headers['content-type'] ??= 'application/octet-stream'
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers['content-type'] ??= 'application/json'
  }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  const response = await fetch(`${baseUrl}${API}${path}`, { method: init.method ?? 'GET', headers, body })
  const text = await response.text()
  let parsed: { code: number; msg: string; data: T } = { code: 1, msg: text, data: null as T }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    /* 非 JSON 保持原文 */
  }
  return { status: response.status, body: parsed, text }
}

/**
 * 登录并返回 token。
 *
 * 管理员开户 / 重置密码后的临时口令会被平台强制要求改密（数据面一律 403），
 * 和浏览器打开时的弹窗一样，这里先用旧口令把密码换掉，再拿 token 继续跑用例。
 * 需要断言强制改密状态的用例直接调 `/auth/login`，不要走这个 helper。
 */
export async function login(baseUrl: string, username: string, password: string): Promise<string> {
  let response = await api<{ accessToken: string; mustChangePassword?: boolean }>(baseUrl, '/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  // 同一个用例文件里重复登录同一个成员时，前一次已经把临时口令换成派生口令了。
  if (response.status === 401) {
    response = await api<{ accessToken: string; mustChangePassword?: boolean }>(baseUrl, '/auth/login', {
      method: 'POST',
      body: { username, password: `${password}-changed` },
    })
  }
  if (response.status !== 200) throw new Error(`登录失败: ${response.status} ${response.text}`)
  const { accessToken, mustChangePassword } = response.body.data
  if (mustChangePassword === true) {
    const changed = await api(baseUrl, '/me/password', {
      method: 'PATCH',
      token: accessToken,
      body: { currentPassword: password, newPassword: `${password}-changed` },
    })
    if (changed.status !== 200) throw new Error(`首次改密失败: ${changed.status} ${changed.text}`)
  }
  return accessToken
}

/** 浏览器 Remote 面：`POST P/remote/<endpoint>`。 */
export const REMOTE = `${API}/remote`

export interface RemoteEnvelope<T = unknown> {
  type: string
  rpcId: string
  result: {
    ok: boolean
    value?: T
    error?: { code: string; message: string; details: unknown }
  }
}

/**
 * 发一次浏览器 Remote 调用。
 *
 * `cookie` 是浏览器登录态（`platform_session=…`）；`args` 直接作为
 * `payload.args`，和官方 `connection.rpc.call` 的线上形状一致。
 */
export async function remote<T = unknown>(
  baseUrl: string,
  endpoint: string,
  args: unknown = {},
  init: { rpcId?: string; cookie?: string; token?: string; status?: number } = {},
): Promise<RemoteEnvelope<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.cookie !== undefined) headers.cookie = init.cookie
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`
  const response = await fetch(`${baseUrl}${REMOTE}/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: init.rpcId ?? `rpc-${endpoint}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (init.status !== undefined) {
    const text = await response.text()
    if (response.status !== init.status) {
      throw new Error(`Remote ${endpoint} expected ${init.status}, got ${response.status}: ${text}`)
    }
    return JSON.parse(text || '{}') as RemoteEnvelope<T>
  }
  return await response.json() as RemoteEnvelope<T>
}

/** 打开一条 `P/sse/<endpoint>` 流并读若干帧；abort 时关闭。 */
export async function openSse(
  baseUrl: string,
  endpoint: string,
  payload: unknown,
  init: { cookie?: string; signal: AbortSignal },
): Promise<Response> {
  const query = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const headers: Record<string, string> = { accept: 'text/event-stream' }
  if (init.cookie !== undefined) headers.cookie = init.cookie
  return await fetch(`${baseUrl}${API}/sse/${endpoint}?payload=${encodeURIComponent(query)}`, {
    signal: init.signal,
    headers,
  })
}

/** 逐帧读 SSE，遇到 `predicate` 为真的帧时 resolve；超时 reject。 */
export async function readSseUntil(
  response: Response,
  predicate: (value: unknown) => boolean,
  timeoutMs = 5_000,
): Promise<unknown> {
  if (response.body === null) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE frame')
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timed out')), Math.max(1, deadline - Date.now()))),
      ])
      if (chunk.done) throw new Error('SSE closed before the expected frame')
      buffer += decoder.decode(chunk.value, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        cut = buffer.indexOf('\n\n')
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '') continue
        const value = JSON.parse(data) as unknown
        if (predicate(value)) return value
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
