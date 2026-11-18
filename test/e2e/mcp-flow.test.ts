import { spawnSync } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionDirectoryService from '../../../dsh-sandbox-brain/packages/dsh-session-directory/src/index.ts'
import UserMcpPlugin from '../../../dsh-sandbox-brain/packages/dsh-user-mcp/src/index.ts'
import { testContext } from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { startMockMcp, type MockMcpServer } from '../../../dsh-sandbox-brain/test/helpers/mcp.ts'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * MCP 全流程联合 e2e：平台 API 关联 → 脑侧挂载 → 真实工具执行。
 *
 *   平台 POST /mcp-servers（https + 密钥头）→ 平台自己封存密钥
 *   → 建工作区时选中这个 server → 发起会话（平台→脑真实 HTTP）
 *   → 脑侧 UserMcpPlugin 在 agent/pre-step 读同一个库、挂载 MCP、注册工具
 *   → 调用工具：解密后的密钥随请求头到 MCP server，结果回到模型面
 *   → 平台停用/启用：下一 pre-step 摘掉/挂回工具
 *
 * 平台只接受 https 的 MCP 地址，所以 mock server 也起在自签 TLS 上；
 * 测试进程临时关掉证书校验。未选中的 server 不应被挂载。
 */

const CREDENTIAL = 'joint-secret-123'

interface ToolDefinitionLike {
  name: string
  execute(args: unknown, execution: unknown): Promise<unknown>
}

interface FakeTools {
  readonly defs: Map<string, ToolDefinitionLike>
  register(definition: ToolDefinitionLike): () => void
}

function createTools(): FakeTools {
  const defs = new Map<string, ToolDefinitionLike>()
  return {
    defs,
    register(definition) {
      defs.set(definition.name, definition)
      return () => {
        defs.delete(definition.name)
      }
    },
  }
}

interface TestAgent {
  session: { id: string }
  ctx: Context
}

/** 手动触发一次 agent/pre-step 瀑布；真实内核由 agent-loop 派发同一个事件。 */
async function preStep(ctx: Context, agent: TestAgent): Promise<void> {
  const waterfall = ctx as unknown as {
    waterfall(event: string, payload: unknown, next: () => unknown): Promise<unknown>
  }
  await waterfall.waterfall('agent/pre-step', { agent }, () => undefined)
}

function toolNames(tools: FakeTools): string[] {
  return [...tools.defs.keys()].sort()
}

let stack: JointStack
let certDir: string
let selected: MockMcpServer
let unselected: MockMcpServer
let brainCtx: Context
let tools: FakeTools
let agent: TestAgent
let disposeAgent: () => Promise<void>
let previousRejectUnauthorized: string | undefined

let workspaceId: string
let sessionId: string

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token, { modelIds: ['deepseek-chat'] })

  certDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-tls-'))
  const generated = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(certDir, 'key.pem'),
      '-out', join(certDir, 'cert.pem'),
      '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  )
  if (generated.status !== 0) throw new Error(`生成自签证书失败:\n${generated.stderr}`)
  const tls = {
    key: await readFile(join(certDir, 'key.pem')),
    cert: await readFile(join(certDir, 'cert.pem')),
  }
  ;[selected, unselected] = await Promise.all([startMockMcp({ tls }), startMockMcp({ tls })])

  // 自签证书只用于本测试自己的 mock server。
  previousRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  // 脑用平台同一把 AES 密钥解开 `cred:mcp/...` 引用。
  process.env.DSH_CREDENTIALS_KEY = stack.platform.config.credentialsKey

  brainCtx = testContext({ db: stack.brainDb, agents: { get: () => undefined } })
  new SessionDirectoryService(brainCtx, { cacheTtlMs: 0 })
  tools = createTools()
  brainCtx.provide('tools', tools)
  new UserMcpPlugin(brainCtx, { mountTimeoutMs: 8_000 })
})

afterAll(async () => {
  if (disposeAgent !== undefined) await disposeAgent()
  if (previousRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousRejectUnauthorized
  delete process.env.DSH_CREDENTIALS_KEY
  await Promise.all([selected.close(), unselected.close()])
  if (certDir !== undefined) await rm(certDir, { recursive: true, force: true })
  await stack.close()
})

describe('MCP 全流程：关联 → 挂载 → 执行', () => {
  it('1. 平台保存 MCP server：地址、明文头落库，密钥只留引用', async () => {
    const created = await api(stack.baseUrl, '/mcp-servers', {
      method: 'POST',
      token: stack.token,
      body: {
        name: 'joint-tools',
        url: selected.url,
        timeoutMs: 20_000,
        headers: {
          'X-Api-Key': { secret: CREDENTIAL },
          'X-Team': { value: 'blue' },
        },
      },
    })
    expect(created.status).toBe(201)

    const notSelected = await api(stack.baseUrl, '/mcp-servers', {
      method: 'POST',
      token: stack.token,
      body: { name: 'unselected-tools', url: unselected.url },
    })
    expect(notSelected.status).toBe(201)

    const detail = await api<{
      name: string
      url: string
      enabled: boolean
      timeoutMs: number | null
      headers: Array<{ name: string; secret?: boolean; value?: string }>
    }>(stack.baseUrl, '/mcp-servers/joint-tools', { token: stack.token })
    expect(detail.status).toBe(200)
    expect(detail.body.data).toMatchObject({
      name: 'joint-tools',
      url: selected.url,
      enabled: true,
      timeoutMs: 20_000,
      headers: [
        { name: 'X-Api-Key', secret: true },
        { name: 'X-Team', secret: false, value: 'blue' },
      ],
    })
  })

  it('2. 建工作区时只勾选一个 server，并发起会话', async () => {
    const workspace = await api<{ id: string; mcpServers: Array<{ name: string; scope: string }> }>(
      stack.baseUrl,
      '/workspaces',
      {
        method: 'POST',
        token: stack.token,
        body: { name: 'MCP 工作区', mcpServers: [{ name: 'joint-tools', scope: 'private' }] },
      },
    )
    expect(workspace.status).toBe(201)
    workspaceId = workspace.body.data.id
    expect(workspace.body.data.mcpServers).toEqual([{ name: 'joint-tools', scope: 'private' }])

    const session = await api<{ id: string; createState: string }>(stack.baseUrl, '/sessions', {
      method: 'POST',
      token: stack.token,
      body: { workspaceId, title: 'MCP 检查' },
    })
    expect(session.status).toBe(201)
    expect(session.body.data.createState).toBe('ready')
    sessionId = session.body.data.id
    // 脑确实接住了这个会话。
    expect(stack.gateway.sessions.has(sessionId)).toBe(true)

    const scope = createScope(brainCtx, { sessionId })
    agent = { session: { id: sessionId }, ctx: scope.ctx }
    disposeAgent = scope.dispose
  })

  it('3. 脑侧按库里现状挂载：只同步选中的 server，未选中的不联系', async () => {
    await preStep(brainCtx, agent)

    expect(toolNames(tools)).toEqual(['mcp__joint-tools__echo'])
    expect(selected.listCalls).toHaveLength(1)
    expect(unselected.listCalls).toHaveLength(0)
  })

  it('4. 执行工具：密钥引用解密后随请求头送到 MCP server', async () => {
    const definition = tools.defs.get('mcp__joint-tools__echo')
    expect(definition).toBeDefined()
    const result = (await definition!.execute({ text: '联合链路' }, { signal: new AbortController().signal })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(result.content).toEqual([{ type: 'text', text: 'echo: 联合链路' }])

    expect(selected.calls).toHaveLength(1)
    expect(selected.calls[0]).toMatchObject({ name: 'echo', args: { text: '联合链路' } })
    // 平台封存、脑解开的密钥原样出现在请求头里。
    expect(selected.calls[0]?.headers['x-api-key']).toBe(CREDENTIAL)
    expect(selected.calls[0]?.headers['x-team']).toBe('blue')
  })

  it('5. 平台停用后下一个 pre-step 摘掉工具，重新启用再挂回', async () => {
    const disabled = await api(stack.baseUrl, '/mcp-servers/joint-tools/disable', {
      method: 'POST',
      token: stack.token,
    })
    expect(disabled.status).toBe(200)

    await preStep(brainCtx, agent)
    expect(toolNames(tools)).toEqual([])

    const enabled = await api(stack.baseUrl, '/mcp-servers/joint-tools/enable', {
      method: 'POST',
      token: stack.token,
    })
    expect(enabled.status).toBe(200)

    await preStep(brainCtx, agent)
    expect(toolNames(tools)).toEqual(['mcp__joint-tools__echo'])
  })
})
