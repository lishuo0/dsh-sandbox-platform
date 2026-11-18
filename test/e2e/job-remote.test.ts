import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { PLATFORM_COOKIE, createClientSurface } from '../../src/client/surface.js'
import type { ClientHost } from '../../src/client/host.js'
import { decodeKey } from '../../src/config.js'
import { startHttp } from '../../src/kernel/http.js'
import { seal } from '../../src/kernel/seal.js'
import { signToken } from '../../src/kernel/tokens.js'
import { identityRoutes } from '../../src/modules/identity/routes.js'
import { freePort, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 浏览器终止后台任务：Remote `job/kill`（`POST P/remote/job/kill`）。
 *
 * 平台先做归属闸：请求里点名别人的会话直接拒掉，自己的再经 `BrainClient`
 * 调脑的 `POST /brain/v1/sessions/:id/jobs/:jobId/kill`，真正的终止仍由脑经
 * 沙箱接缝执行。这里用假脑盯住「转没转发、带了什么」。
 */

const OWNED_SESSION = 's_11111111111111111111111111111111'
const FOREIGN_SESSION = 's_22222222222222222222222222222222'

interface Forwarded {
  path: string
  body: {
    type?: string
    rpcId?: string
    method?: string
    payload?: { args?: { request?: { sessionId?: string; jobId?: string } } }
  }
}

let platform: TestPlatform
let brain: Server
let server: Server
let baseUrl: string
let cookie: string
let adminId = ''
const forwarded: Forwarded[] = []

beforeAll(async () => {
  platform = await startTestPlatform()

  brain = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text ? JSON.parse(text) as Forwarded['body'] : {}
      forwarded.push({ path, body })
      const send = (payload: unknown, status = 200): void => {
        const json = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
        res.end(json)
      }
      if (path === `/brain/v1/sessions/${OWNED_SESSION}/jobs/bash-1/kill`) {
        send({ outcome: 'requested' })
        return
      }
      send({ code: 404, msg: 'not found', data: null }, 404)
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
  const client: ClientHost = {
    indexHtml: '<!doctype html><title>stub</title>',
    shellRoot: platform.storageDir,
    fetchPlugin: async () => undefined,
  }
  const surface = createClientSurface(config, platform.db, client)
  server = startHttp(config, platform.db, identityRoutes(platform.deps), surface)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有监听地址')
  baseUrl = `http://127.0.0.1:${address.port}`

  const admin = await platform.db.query<{ id: string }>(`SELECT id FROM dsh_users WHERE id = $1`, [
    platform.config.auth.adminUsername,
  ])
  adminId = admin.rows[0]?.id ?? ''
  if (!adminId) throw new Error('没有找到管理员')
  cookie = `${PLATFORM_COOKIE}=${signToken(platform.config.auth.tokenSecret, adminId, platform.config.auth.tokenTtlHours)}`

  const credentialsKey = decodeKey(platform.config.credentialsKey)
  await platform.db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    [adminId, 'https://api.example.com/v1', ['deepseek-chat'], 'deepseek-chat'],
  )
  await platform.db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    [adminId, 'model-api-key', 'default', seal(credentialsKey, 'sk-platform-secret')],
  )
  // 终止后台任务要按会话解析工作区；会话必须有归属的工作区。
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ($1, $2, '默认工作区', '/tmp/w_job', '/desk')`,
    ['ws_job000000000000000000000', adminId],
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id, workspace_id, preset_id) VALUES ($1, $2, $3, 'client')`, [
    OWNED_SESSION,
    adminId,
    'ws_job000000000000000000000',
  ])
  await platform.db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u_other_tenant', 'other', 'x')`,
  )
  await platform.db.query(`INSERT INTO dsh_sessions (id, user_id) VALUES ($1, 'u_other_tenant')`, [FOREIGN_SESSION])
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => {
    brain.close(() => resolve())
    brain.closeAllConnections()
  })
  await platform.close()
})

interface Envelope {
  type?: string
  rpcId?: string
  result?: {
    ok: boolean
    value?: unknown
    error?: { code: string; message: string }
  }
}

async function postJobKill(sessionId: string, jobId: string, rpcId: string): Promise<{
  status: number
  body: Envelope
}> {
  const response = await fetch(`${baseUrl}/dsh-api/platform/v1/remote/job/kill`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'job/kill',
      payload: { args: { request: { sessionId, jobId } } },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

describe('后台任务终止（浏览器 → 平台归属闸 → 脑 job Remote）', () => {
  it('自己的会话原样转给脑，回包把终止结果带回浏览器', async () => {
    const before = forwarded.length
    const result = await postJobKill(OWNED_SESSION, 'bash-1', 'rpc-kill-1')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      type: 'server-response',
      rpcId: 'rpc-kill-1',
      result: { ok: true, value: { outcome: 'requested' } },
    })

    const sent = forwarded.slice(before).find(
      (item) => item.path === `/brain/v1/sessions/${OWNED_SESSION}/jobs/bash-1/kill`,
    )
    expect(sent).toBeDefined()
  })

  it('点名别人的会话直接拒掉，脑收不到终止请求', async () => {
    const before = forwarded.length
    const result = await postJobKill(FOREIGN_SESSION, 'bash-1', 'rpc-kill-foreign')

    expect(result.status).toBe(200)
    expect(result.body.result?.ok).toBe(false)
    expect(result.body.result?.error?.code).toBe('session/not-found')
    expect(forwarded.length).toBe(before)
  })
})
