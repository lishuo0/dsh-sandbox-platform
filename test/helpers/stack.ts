import type { Context } from '@deepseek-ai/cordis'
import type { Db } from '../../src/kernel/db.js'
import { DEFAULT_HEADERS } from '../../../dsh-sandbox-brain/packages/dsh-platform-api/src/auth.ts'
import { createOwnershipGuard } from '../../../dsh-sandbox-brain/packages/dsh-platform-api/src/ownership.ts'
import { registerRoutes } from '../../../dsh-sandbox-brain/packages/dsh-platform-api/src/routes.ts'
import {
  FakeWebServer,
  MemoryGateway,
  startBrainServer,
  testContext,
  type BrainServer,
} from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { api, freePort, login, startTestPlatform, type TestPlatform } from './app.js'
import { createTestDatabase, type TestDatabase } from './pg.js'

/** 一套真实平台 + 真实脑路由的联合环境。 */
export interface JointStack {
  platform: TestPlatform
  brain: BrainServer
  gateway: MemoryGateway
  database: TestDatabase
  /** 平台侧句柄：`query → { rows, rowCount }`。 */
  db: Db
  /** 脑侧句柄：`query → rows[]`，形状等同 `ctx.db`。 */
  brainDb: {
    readonly dialect: string
    query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>
    transaction<T>(body: (run: (text: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T>
  }
  /** 平台 API 根地址。 */
  baseUrl: string
  /** 管理员令牌。 */
  token: string
  /** 管理员用户 id（就是用户名）。 */
  userId: string
  close(): Promise<void>
}

export interface JointOptions {
  /** 给平台模型配置用的 API Key，默认一个占位值。 */
  modelApiKey?: string
  /** 额外的脑侧服务，例如可观测的 `workspaceRegistry`。 */
  brainServices?: Record<string, unknown>
}

/**
 * 起一套完整链路：
 *
 *   平台（真实路由 + 真实 PG + 本地对象目录）
 *     → 真实 HTTP → 脑路由 `registerRoutes`（真实鉴权 + 真实归属校验）
 *       → MemoryGateway（内存事件日志 + 订阅分发）
 *
 * 平台和脑共用同一个测试库，所以脑的归属校验读的是平台写下的 dsh_sessions。
 * 不启动真正的 DSH 内核和 LLM：技能执行在 MockPlatform 里另起子进程验证。
 */
export async function startJointStack(options: JointOptions = {}): Promise<JointStack> {
  const database = await createTestDatabase(['platform', 'brain'])
  const port = await freePort()
  const platform = await startTestPlatform({
    database,
    brainBaseUrl: `http://127.0.0.1:${port}`,
  })
  const token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  const userId = platform.config.auth.adminUsername

  // 脑端的 db 服务契约是 `query() → rows[]`；平台句柄返回 { rows, rowCount }。
  const ctx: Context = testContext({ webServer: new FakeWebServer() })
  const brainDb = {
    dialect: database.pool.dialect,
    query: async <T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]> =>
      (await database.pool.query<T>(text, params)).rows,
    transaction: async <T>(body: (run: (text: string, params?: readonly unknown[]) => Promise<unknown[]>) => Promise<T>): Promise<T> =>
      database.pool.transaction((run) => body(async (text, params = []) => (await run.query(text, params)).rows)),
  }
  ctx.provide('db', brainDb)
  for (const [name, value] of Object.entries(options.brainServices ?? {})) ctx.provide(name, value)
  const gateway = new MemoryGateway()
  const modelKeys = new Map<string, string>()
  registerRoutes(ctx, {
    gateway,
    ownership: createOwnershipGuard(ctx),
    credentials: [{ appId: platform.config.brain.appId, appKey: platform.config.brain.appKey }],
    headers: DEFAULT_HEADERS,
    requireUser: true,
    modelKeys: {
      get: sessionId => modelKeys.get(sessionId),
      set: (sessionId, key) => void modelKeys.set(sessionId, key),
      delete: sessionId => void modelKeys.delete(sessionId),
    },
  })
  const brain = await startBrainServer(ctx, port)

  return {
    platform,
    brain,
    gateway,
    database,
    db: database.pool,
    brainDb,
    baseUrl: platform.baseUrl,
    token,
    userId,
    async close() {
      // 脑先关：平台的 close() 会结束连接池并删库。
      await brain.close()
      await platform.close()
    },
  }
}

/** 给用户配好模型，之后才能开会话。 */
export async function configureModel(
  baseUrl: string,
  token: string,
  overrides: { baseUrl?: string; apiKey?: string; modelIds?: string[]; defaultModel?: string } = {},
): Promise<void> {
  const modelIds = overrides.modelIds ?? ['claude-sonnet-4-6']
  const response = await api(baseUrl, '/settings/model', {
    method: 'POST',
    token,
    body: {
      baseUrl: overrides.baseUrl ?? 'https://llm.test/v1',
      apiKey: overrides.apiKey ?? 'sk-test-0123456789',
      modelIds,
      defaultModel: overrides.defaultModel ?? modelIds[0],
    },
  })
  if (response.status !== 200) throw new Error(`配置模型失败: ${response.status} ${response.text}`)
}
