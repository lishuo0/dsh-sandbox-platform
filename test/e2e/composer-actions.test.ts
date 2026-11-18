import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { decodeKey } from '../../src/config.js'
import { startHttp } from '../../src/kernel/http.js'
import { seal } from '../../src/kernel/seal.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 输入框「+」菜单背后的真实链路：文件 / 目标 / 计划 / 反馈 / 压缩 / 权限 / 模型。
 *
 * 浏览器只有统一前缀：模型选择、附件上传由平台自己完成（`P/upload`），
 * 命令/目标/反馈/权限目录经 `BrainClient` 转到脑的 `/brain/v1/*`。这里用一个
 * 假脑记录平台真正发出去的东西（模型头、会话、命令原文、RPC 请求体），并验证
 * 跨租户被挡住、附件不再经过脑。
 */

const OWNED = 's_10000000000000000000000000000001'
const OTHER = 's_20000000000000000000000000000002'
const WORKSPACE = 'ws_composer0000000000000000000'
const OTHER_WORKSPACE = 'ws_other000000000000000000000'

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl = ''
let cookie = ''
let userId = ''

interface BrainCall {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}
const adoptions: BrainCall[] = []
const commands: BrainCall[] = []
const goals: BrainCall[] = []
const feedbacks: BrainCall[] = []
const catalogs: BrainCall[] = []

beforeAll(async () => {
  platform = await startTestPlatform()
  userId = platform.config.auth.adminUsername

  brain = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw.toString('utf8'))
      const call = { path: req.url ?? '', headers: req.headers, body }
      const json = (value: unknown, status = 200): void => {
        const text = JSON.stringify(value)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
        res.end(text)
      }
      if (req.url === '/brain/v1/sessions' && req.method === 'POST') {
        adoptions.push(call)
        json({ sessionId: OWNED, requestId: 'adopt' }, 201)
        return
      }
      if (req.url?.startsWith('/brain/v1/sessions/') && req.url.endsWith('/commands')) {
        commands.push(call)
        json({ result: { kind: 'success', text: 'No compactable history yet.' } })
        return
      }
      if (req.url === `/brain/v1/sessions/${OWNED}/goal` && req.method === 'GET') {
        goals.push(call)
        json({ goal: null })
        return
      }
      if (req.url === `/brain/v1/sessions/${OWNED}/feedback` && req.method === 'POST') {
        feedbacks.push(call)
        json({ recorded: true })
        return
      }
      if (req.url === '/brain/v1/permission-presets' && req.method === 'GET') {
        catalogs.push(call)
        json({
          options: [{ value: 'workspace-write', name: 'workspace-write' }],
          defaultOptions: [{ value: 'workspace-write', name: 'workspace-write' }],
          defaultPreset: 'workspace-write',
        })
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
  })
  const brainPort = await freePort()
  await new Promise<void>((resolve, reject) => {
    brain.listen(brainPort, '127.0.0.1', () => resolve())
    brain.once('error', reject)
  })

  const config = {
    ...platform.config,
    brain: { ...platform.config.brain, baseUrl: `http://127.0.0.1:${brainPort}` },
    http: { host: '127.0.0.1', port: await freePort() },
  }
  const client: ClientHost = { indexHtml: '', shellRoot: '', fetchPlugin: async () => undefined }
  const surface = createClientSurface(config, platform.db, client)
  server = startHttp(config, platform.db, identityRoutes(platform.deps), surface)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有监听地址')
  baseUrl = `http://127.0.0.1:${address.port}`

  const token = signToken(platform.config.auth.tokenSecret, userId, platform.config.auth.tokenTtlHours)
  cookie = `${PLATFORM_COOKIE}=${token}`

  const credentialsKey = decodeKey(platform.config.credentialsKey)
  await platform.db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    [userId, 'https://api.example.com/v1', ['deepseek-chat', 'deepseek-reasoner'], 'deepseek-chat'],
  )
  await platform.db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    [userId, 'model-api-key', 'default', seal(credentialsKey, 'sk-platform-secret')],
  )
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('other', 'other', 'x')`,
  )
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES
       ($1, $3, '工作区', '/tmp/w_composer', '/desk'),
       ($2, 'other', '别人的工作区', '/tmp/w_other', '/desk')`,
    [WORKSPACE, OTHER_WORKSPACE, userId],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES
       ($1, $3, $4, '我的会话'),
       ($2, 'other', $5, '别人的会话')`,
    [OWNED, OTHER, userId, WORKSPACE, OTHER_WORKSPACE],
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

interface RemoteResult {
  type: string
  rpcId: string
  result: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string; details: unknown }
  }
}

async function rpc(method: string, payload: unknown, rpcId = 'rpc-test'): Promise<RemoteResult> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  expect(response.status).toBe(200)
  return await response.json() as RemoteResult
}

async function storedModel(sessionId: string): Promise<string | null> {
  const rows = await platform.db.query<{ model_id: string | null }>(
    `SELECT model_id FROM dsh_sessions WHERE id = $1`,
    [sessionId],
  )
  return rows.rows[0]?.model_id ?? null
}

describe('输入框 + → 模型选择', () => {
  it('平台把选择登记到脑并落库，回 Remote 成功信封', async () => {
    const response = await rpc('session/selectModel', {
      args: { request: { sessionId: OWNED, provider: 'user', model: 'deepseek-reasoner' } },
    })
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toEqual({ selected: { provider: 'user', model: 'deepseek-reasoner' } })
    expect(await storedModel(OWNED)).toBe('deepseek-reasoner')

    // 脑收到的登记带上了密钥、地址、选中模型和全部可选模型。
    const call = adoptions.at(-1)
    expect(call?.body).toMatchObject({ sessionId: OWNED })
    expect(call?.headers['x-dsh-model-id']).toBe('deepseek-reasoner')
    expect(call?.headers['x-dsh-model-ids']).toBe('deepseek-chat,deepseek-reasoner')
    expect(call?.headers['x-dsh-model-key']).toBe('sk-platform-secret')
  })

  it('名单外的模型回 model-config-required，不动库也不打扰脑', async () => {
    const before = adoptions.length
    const response = await rpc('session/selectModel', {
      args: { request: { sessionId: OWNED, model: 'gpt-unknown' } },
    })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('session/model-config-required')
    expect(adoptions.length).toBe(before)
    expect(await storedModel(OWNED)).toBe('deepseek-reasoner')
  })

  it('别人的会话选不了模型', async () => {
    const response = await rpc('session/selectModel', {
      args: { request: { sessionId: OTHER, model: 'deepseek-chat' } },
    })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('session/not-found')
  })
})

describe('输入框 + → 压缩', () => {
  it('压缩走 /brain/v1 命令接口，参数是 agentId + line，结果原样回客户端', async () => {
    const response = await rpc('commands/execute', {
      args: { agentId: OWNED, line: '/compact' },
    })
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toEqual({ kind: 'success', text: 'No compactable history yet.' })

    const call = commands.at(-1)
    expect(call?.path).toBe(`/brain/v1/sessions/${OWNED}/commands`)
    expect(call?.body).toEqual({ line: '/compact' })
    // 命令执行前先把会话模型补给脑，压缩摘要才有模型可用。
    expect(call?.headers['x-dsh-model-id']).toBe('deepseek-reasoner')
    expect(adoptions.at(-1)?.headers['x-dsh-model-id']).toBe('deepseek-reasoner')
  })

  it('缺会话或命令为空时回 bad-request', async () => {
    const missing = await rpc('commands/execute', { args: { line: '/compact' } })
    expect(missing.result.ok).toBe(false)
    expect(missing.result.error?.code).toBe('session/id-invalid')

    const empty = await rpc('commands/execute', { args: { agentId: OWNED } })
    expect(empty.result.ok).toBe(false)
    expect(empty.result.error?.code).toBe('gateway/bad-request')
  })

  it('别人的会话跑不了命令', async () => {
    const before = commands.length
    const response = await rpc('commands/execute', { args: { agentId: OTHER, line: '/compact' } })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('session/not-found')
    expect(commands.length).toBe(before)
  })
})

async function upload(query: string, body: Buffer | string): Promise<{
  status: number
  body: { ok: boolean; value?: unknown; error?: { code: string } }
}> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/upload?${query}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/octet-stream' },
    body,
  })
  return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown; error?: { code: string } } }
}

/** 一张最小合法的 PNG 头：8 字节签名 + IHDR 长度/类型 + 宽高。 */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe('输入框 + → 文件 / 图片', () => {
  it('文件直接落到平台的工作区存储面，不再经过脑', async () => {
    const before = adoptions.length
    const result = await upload(`sessionId=${OWNED}&name=notes.txt`, 'hello')
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    const value = result.body.value as { receiptId: string; file: { attachmentId: string; name: string; bytes: number } }
    expect(value.receiptId.startsWith('upload_')).toBe(true)
    expect(value.file.name).toBe('notes.txt')
    expect(value.file.bytes).toBe(5)
    expect(value.file.attachmentId.startsWith('ws:')).toBe(true)
    expect(adoptions.length).toBe(before)
  })

  it('粘贴图片带 mediaType 走同一个上传口，回读图片尺寸', async () => {
    const result = await upload(`sessionId=${OWNED}&mediaType=image%2Fpng&name=paste.png`, png(3, 2))
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    const value = result.body.value as {
      image: { mediaType: string; bytes: number; width: number; height: number; name: string }
    }
    expect(value.image.mediaType).toBe('image/png')
    expect(value.image.bytes).toBe(33)
    expect(value.image.width).toBe(3)
    expect(value.image.height).toBe(2)
    expect(value.image.name).toBe('paste.png')
  })

  it('别人的会话、或者没有会话的上传都挡在平台', async () => {
    const foreign = await upload(`sessionId=${OTHER}&name=secret.txt`, 'x')
    expect(foreign.status).toBe(200)
    expect(foreign.body.ok).toBe(false)
    expect(foreign.body.error?.code).toBe('not-found')

    const missing = await upload('name=secret.txt', 'x')
    expect(missing.status).toBe(200)
    expect(missing.body.ok).toBe(false)
    expect(missing.body.error?.code).toBe('session/id-invalid')
  })
})

describe('输入框 + → 目标', () => {
  it('目标读取转发到脑的 /goal，agentId 原样保留', async () => {
    const response = await rpc('goals/get', { args: { agentId: OWNED } })
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toBeUndefined()

    const call = goals.at(-1)
    expect(call?.path).toBe(`/brain/v1/sessions/${OWNED}/goal`)
  })

  it('别人的会话当 agent 读不了目标', async () => {
    const before = goals.length
    const response = await rpc('goals/get', { args: { agentId: OTHER } })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('session/not-found')
    expect(goals.length).toBe(before)
  })
})

describe('输入框 + → 计划', () => {
  it('/plan 与压缩走同一条命令接口', async () => {
    const response = await rpc('commands/execute', { args: { agentId: OWNED, line: '/plan' } })
    expect(response.result.ok).toBe(true)

    const call = commands.at(-1)
    expect(call?.path).toBe(`/brain/v1/sessions/${OWNED}/commands`)
    expect(call?.body).toEqual({ line: '/plan' })
  })
})

describe('输入框 + → 反馈', () => {
  it('反馈按会话转发到脑，文本与分类都保留', async () => {
    const response = await rpc('sessionFeedback/record', {
      args: { sessionId: OWNED, text: '回答得不错', category: 'task-result' },
    })
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toEqual({ recorded: true })

    const call = feedbacks.at(-1)
    expect(call?.path).toBe(`/brain/v1/sessions/${OWNED}/feedback`)
    expect(call?.body).toEqual({ sessionId: OWNED, text: '回答得不错', category: 'task-result' })
  })

  it('别人的会话写不了反馈', async () => {
    const before = feedbacks.length
    const response = await rpc('sessionFeedback/record', { args: { sessionId: OTHER, text: 'x' } })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('session/not-found')
    expect(feedbacks.length).toBe(before)
  })
})

describe('输入框 + → 权限', () => {
  it('权限目录从脑的 /brain/v1/permission-presets 读', async () => {
    const response = await rpc('permissionPresets/catalog', { args: {} })
    expect(response.result.ok).toBe(true)
    expect(response.result.value).toMatchObject({ defaultPreset: 'workspace-write' })

    const call = catalogs.at(-1)
    expect(call?.path).toBe('/brain/v1/permission-presets')
  })

  it('切换预设按会话走命令接口', async () => {
    const response = await rpc('commands/execute', { args: { agentId: OWNED, line: '/permission read-only' } })
    expect(response.result.ok).toBe(true)

    const call = commands.at(-1)
    expect(call?.path).toBe(`/brain/v1/sessions/${OWNED}/commands`)
    expect(call?.body).toEqual({ line: '/permission read-only' })
  })

  it('进程级的权限默认值在浏览器面上不存在', async () => {
    const response = await rpc('settings/mutate', {
      args: { ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }], revision: 1 },
    })
    expect(response.result.ok).toBe(false)
    expect(response.result.error?.code).toBe('gateway/not-found')
  })
})
