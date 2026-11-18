import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainCall, BrainClient } from '../../src/brain/client.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { forceCancelSession } from '../../src/modules/sessions/service.js'

/**
 * 硬取消只转发给脑：平台校验归属和 request_id，
 * 脑上没有活跃会话时按幂等成功处理。
 */

let dir: string
let db: SqliteDb
let calls: Array<BrainCall & { requestId: string }>
let next: { ok: true; value: unknown } | { ok: false; status: number; code: string }
let brain: BrainClient

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-force-cancel-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x'), ('u2', '二', 'x')`)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ('w1', 'u1', '工作区', '/var/w1', '/desk')`,
  )
  await db.query(`INSERT INTO dsh_sessions (id, user_id, workspace_id) VALUES ('s1', 'u1', 'w1')`)

  calls = []
  next = { ok: true, value: { forceClosed: true } }
  brain = {
    forceCancel: vi.fn(async (input: BrainCall & { requestId: string }) => {
      calls.push(input)
      return next
    }),
  } as unknown as BrainClient
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('forceCancelSession', () => {
  it('带上成员、工作区和客户端 request_id 转发', async () => {
    expect(await forceCancelSession(db, brain, 'u1', 's1', 'req-abc.1')).toEqual({ forceClosed: true })
    expect(calls[0]).toMatchObject({ userId: 'u1', workspaceId: 'w1', sessionId: 's1', requestId: 'req-abc.1' })
  })

  it('没带 request_id 时生成一个，不带空白', async () => {
    await forceCancelSession(db, brain, 'u1', 's1')
    await forceCancelSession(db, brain, 'u1', 's1', '   ')
    expect(calls[0]?.requestId).toMatch(/^[0-9a-f]{16}$/)
    expect(calls[1]?.requestId).toMatch(/^[0-9a-f]{16}$/)
    expect(calls[0]?.requestId).not.toBe(calls[1]?.requestId)
  })

  it('格式不对 400，且不碰脑', async () => {
    for (const requestId of ['bad id!', 'x'.repeat(129), '回车\n']) {
      await expect(forceCancelSession(db, brain, 'u1', 's1', requestId)).rejects.toThrowError(
        expect.objectContaining({ status: 400, code: 'invalid-request-id' }),
      )
    }
    expect(calls).toEqual([])
  })

  it('别人的会话 404，且不碰脑', async () => {
    await expect(forceCancelSession(db, brain, 'u2', 's1', 'req-1')).rejects.toThrowError(
      expect.objectContaining({ status: 404, code: 'not-found' }),
    )
    expect(calls).toEqual([])
  })

  it('脑上没有活跃会话按幂等成功处理', async () => {
    next = { ok: false, status: 404, code: 'session-not-found' }
    expect(await forceCancelSession(db, brain, 'u1', 's1', 'req-1')).toEqual({ forceClosed: false })
  })

  it('脑的其他错误原样回给调用方', async () => {
    next = { ok: false, status: 502, code: 'brain-unreachable' }
    await expect(forceCancelSession(db, brain, 'u1', 's1', 'req-1')).rejects.toThrowError(
      expect.objectContaining({ status: 502, code: 'brain-unreachable' }),
    )
  })
})
