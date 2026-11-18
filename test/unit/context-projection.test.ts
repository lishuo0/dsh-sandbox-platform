import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Deps } from '../../src/app/deps.js'
import type { AppConfig } from '../../src/config.js'
import { migrate } from '../../src/kernel/db.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { projectUsage } from '../../src/modules/context/projection.js'

let dir: string
let db: SqliteDb

function deps(config: Partial<AppConfig> = {}): Deps {
  return {
    config: {
      pricing: {
        models: {
          'user/deepseek-chat': { input: 1, cacheRead: 0.1, cacheWrite: 0.5, output: 2 },
        },
      },
      ...config,
    } as AppConfig,
    db,
  } as unknown as Deps
}

async function brainTables(): Promise<void> {
  await db.exec(`CREATE TABLE dsh_session_headers (
    session_id text PRIMARY KEY,
    header text NOT NULL,
    inherited_count integer NOT NULL DEFAULT 0,
    next_seq integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 1
  )`)
  await db.exec(`CREATE TABLE IF NOT EXISTS dsh_session_events (
    session_id text NOT NULL,
    seq integer NOT NULL,
    event text NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`)
}

function message(seq: number, usage: Record<string, number>, provider = 'user', model = 'deepseek-chat'): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: Date.UTC(2026, 10, 1, 12, 0, seq),
    data: {
      message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } },
      usage,
    },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-context-unit-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  await brainTables()
  await db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'one', 'x')`)
  await db.query(`INSERT INTO dsh_sessions (id, user_id, title) VALUES ('s1', 'u1', '会话一')`)
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

describe('用量投影', () => {
  it('把 assistant/message 的用量按价目写进 dsh_usage_steps，并推进游标', async () => {
    await db.query(
      `INSERT INTO dsh_session_headers (session_id, header, next_seq) VALUES ('s1', '{}', 5)`,
    )
    await db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event) VALUES
         ('s1', 1, $1), ('s1', 2, $2)`,
      [
        message(1, { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500, totalTokens: 3500 }),
        JSON.stringify({ type: 'user/message', seq: 2, time: 1, data: {} }),
      ],
    )

    expect(await projectUsage(deps())).toBe(1)

    const steps = await db.query<Record<string, unknown>>(
      `SELECT session_id, seq, user_id, provider, model, input_tokens, cache_read_tokens,
              output_tokens, amount, price_version
         FROM dsh_usage_steps`,
    )
    expect(steps.rows).toHaveLength(1)
    expect(steps.rows[0]).toMatchObject({
      session_id: 's1',
      seq: 1,
      user_id: 'u1',
      provider: 'user',
      model: 'deepseek-chat',
      input_tokens: 1000,
      cache_read_tokens: 2000,
      output_tokens: 500,
    })
    // 1000*1 + 2000*0.1 + 500*2 = 0.0022 美元（按百万 token 计价）
    expect(Number(steps.rows[0]?.amount)).toBeCloseTo(0.0022, 10)
    expect(String(steps.rows[0]?.price_version ?? '')).toHaveLength(12)

    const cursor = await db.query<{ seq: number }>(`SELECT seq FROM dsh_usage_cursors WHERE session_id = 's1'`)
    expect(cursor.rows[0]?.seq).toBe(4)
  })

  it('重复投影不重复记账；没有会话行的子代理事件不进入用户用量', async () => {
    await db.query(
      `INSERT INTO dsh_session_headers (session_id, header, next_seq) VALUES ('s1', '{}', 2), ('s2', '{}', 2)`,
    )
    await db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event) VALUES
         ('s1', 1, $1), ('s2', 1, $2)`,
      [
        message(1, { inputTokens: 10, outputTokens: 1 }),
        message(1, { inputTokens: 999, outputTokens: 999 }),
      ],
    )
    expect(await projectUsage(deps())).toBe(1)
    expect(await projectUsage(deps())).toBe(0)
    const steps = await db.query<Record<string, unknown>>(`SELECT session_id FROM dsh_usage_steps`)
    expect(steps.rows.map((row) => row.session_id)).toEqual(['s1'])
  })

  it('没配价目的模型金额留空，游标仍然推进', async () => {
    await db.query(
      `INSERT INTO dsh_session_headers (session_id, header, next_seq) VALUES ('s1', '{}', 2)`,
    )
    await db.query(
      `INSERT INTO dsh_session_events (session_id, seq, event) VALUES ('s1', 1, $1)`,
      [message(1, { inputTokens: 10, outputTokens: 1 }, 'user', 'unpriced')],
    )
    expect(await projectUsage(deps({ pricing: { models: {} } }))).toBe(1)
    const row = await db.query<Record<string, unknown>>(
      `SELECT amount, price_version FROM dsh_usage_steps WHERE session_id = 's1'`,
    )
    expect(row.rows[0]?.amount).toBeNull()
    expect(row.rows[0]?.price_version).toBeNull()
  })

  it('脑还没建事件表时安静跳过，不拖垮启动', async () => {
    await db.exec(`DROP TABLE dsh_session_events`)
    await db.exec(`DROP TABLE dsh_session_headers`)
    expect(await projectUsage(deps())).toBe(0)
  })
})
