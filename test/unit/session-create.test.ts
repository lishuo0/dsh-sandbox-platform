import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainClient, BrainCall } from '../../src/brain/client.js'
import { migrate } from '../../src/kernel/db.js'
import { HttpError } from '../../src/kernel/errors.js'
import type { ObjectStore } from '../../src/kernel/objects.js'
import { seal } from '../../src/kernel/seal.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { openSession } from '../../src/modules/sessions/service.js'

const objects: ObjectStore = {
  enabled: () => false,
  put: () => Promise.resolve(),
  get: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ files: [], directories: [], truncated: false }),
}

const key = randomBytes(32)
let dir: string
let db: SqliteDb
let calls: Array<BrainCall & { cwd: string }>
let brain: BrainClient

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-session-create-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x')`)
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u2', 'u2', 'x')`)
  await db.query(
    `INSERT INTO dsh_user_models (user_id, base_url, model_ids, default_model) VALUES ($1, $2, $3, $4)`,
    ['u1', 'https://api.example.com/v1', ['deepseek-chat'], 'deepseek-chat'],
  )
  await db.query(
    `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext) VALUES ($1, $2, $3, $4)`,
    ['u1', 'model-api-key', 'default', seal(key, 'sk-unit-secret')],
  )
  calls = []
  brain = {
    openSession: (input: BrainCall & { cwd: string }) => {
      calls.push(input)
      return Promise.resolve({ ok: true as const })
    },
  } as unknown as BrainClient
})

afterEach(async () => {
  await db.end().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('openSession 沿用客户端分配的会话 id', () => {
  it('把客户端 id 传给脑并落库', async () => {
    const requested = 's_3c5a5232a89772ebc37f222a219b2bf5'
    const opened = await openSession(db, objects, brain, key, 'u1', { sessionId: requested })

    expect(opened.id).toBe(requested)
    expect(opened.createState).toBe('ready')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe(requested)

    const rows = await db.query<{ user_id: string; workspace_id: string }>(
      `SELECT user_id, workspace_id FROM dsh_sessions WHERE id = $1`,
      [requested],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.user_id).toBe('u1')
    expect(rows.rows[0]?.workspace_id).toBeTruthy()
  })

  it('同一个 id 重试只保留一条会话，也不重复调脑', async () => {
    const requested = 's_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const first = await openSession(db, objects, brain, key, 'u1', { sessionId: requested })
    const second = await openSession(db, objects, brain, key, 'u1', { sessionId: requested })

    expect(first.id).toBe(requested)
    expect(second.id).toBe(requested)
    expect(calls).toHaveLength(1)
    const rows = await db.query(`SELECT id FROM dsh_sessions WHERE id = $1`, [requested])
    expect(rows.rows).toHaveLength(1)
  })

  it('上一次没建成功时，同一个 id 重试会再调一次脑', async () => {
    const requested = 's_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    await db.query(`INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ($1, 'u1', '', 'platform')`, [requested])
    await db.query(`INSERT INTO dsh_platform_session_ops (session_id, user_id, state, error_code) VALUES ($1, 'u1', 'failed', 'boom')`, [
      requested,
    ])

    const opened = await openSession(db, objects, brain, key, 'u1', { sessionId: requested })
    expect(opened.createState).toBe('ready')
    expect(calls).toHaveLength(1)
    const ops = await db.query<{ state: string; error_code: string | null }>(
      `SELECT state, error_code FROM dsh_platform_session_ops WHERE session_id = $1`,
      [requested],
    )
    expect(ops.rows[0]).toEqual({ state: 'ready', error_code: null })
  })

  it('别人占用的 id 不能接管', async () => {
    const requested = 's_cccccccccccccccccccccccccccccccc'
    await db.query(`INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ($1, 'u2', '', 'client')`, [requested])

    await expect(openSession(db, objects, brain, key, 'u1', { sessionId: requested })).rejects.toMatchObject({
      code: 'session/id-conflict',
    })
    await expect(
      openSession(db, objects, brain, key, 'u1', { sessionId: requested }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(calls).toHaveLength(0)
  })
})
