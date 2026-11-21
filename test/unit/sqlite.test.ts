import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/kernel/db.js'
import { isUniqueViolation } from '../../src/kernel/errors.js'
import { normalizeParam, SqliteDb, translate } from '../../src/kernel/sqlite.js'

describe('translate', () => {
  it('占位符换成 ? 并按出现顺序重排参数', () => {
    const out = translate('SELECT * FROM t WHERE a = $2 AND b = $1', ['first', 'second'])
    expect(out.text).toBe('SELECT * FROM t WHERE a = ? AND b = ?')
    expect(out.params).toEqual(['second', 'first'])
  })

  it('now() 换成时间参数，布尔写成 1/0，去掉类型转换与行锁', () => {
    const out = translate(
      'UPDATE t SET a = true, b = false, c = now(), d = $2::jsonb WHERE id = $1 FOR UPDATE SKIP LOCKED',
      ['id-1', '{"x":1}'],
    )
    expect(out.text).toBe('UPDATE t SET a = 1, b = 0, c = ?, d = ? WHERE id = ? ')
    expect(typeof out.params[0]).toBe('string')
    expect(Number.isNaN(Date.parse(String(out.params[0])))).toBe(false)
    expect(out.params.slice(1)).toEqual(['{"x":1}', 'id-1'])
  })

  it('引号里的内容整段跳过', () => {
    const out = translate(`SELECT 'now() $1 ::jsonb true' AS x FROM t WHERE id = $1`, ['id-1'])
    expect(out.text).toBe(`SELECT 'now() $1 ::jsonb true' AS x FROM t WHERE id = ?`)
    expect(out.params).toEqual(['id-1'])
  })
})

describe('normalizeParam', () => {
  it('Date/boolean/Array 归一成 SQLite 能绑的值', () => {
    const iso = new Date('2026-01-02T03:04:05.000Z')
    expect(normalizeParam(iso)).toBe(iso.toISOString())
    expect(normalizeParam(true)).toBe(1)
    expect(normalizeParam(false)).toBe(0)
    expect(normalizeParam(['a', 'b'])).toBe('["a","b"]')
    expect(normalizeParam(undefined)).toBeNull()
  })

  it('Buffer 原样通过', () => {
    const buffer = Buffer.from('abc')
    expect(normalizeParam(buffer)).toBe(buffer)
  })
})

describe('SqliteDb', () => {
  let dir: string
  let db: SqliteDb

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-sqlite-test-'))
    db = await SqliteDb.open(join(dir, 'test.sqlite'))
  })

  afterEach(async () => {
    await db.end().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('upsert + RETURNING 返回行', async () => {
    await db.exec(`CREATE TABLE t (id text PRIMARY KEY, value text, revision integer NOT NULL DEFAULT 1)`)
    const first = await db.query<{ revision: number }>(
      `INSERT INTO t (id, value) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, revision = t.revision + 1
       RETURNING revision`,
      ['a', 'v1'],
    )
    expect(first.rows).toEqual([{ revision: 1 }])
    const second = await db.query<{ value: string; revision: number }>(
      `INSERT INTO t (id, value) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, revision = t.revision + 1
       RETURNING value, revision`,
      ['a', 'v2'],
    )
    expect(second.rows).toEqual([{ value: 'v2', revision: 2 }])
  })

  it('唯一冲突带上 SQLite 错误码，isUniqueViolation 能认出', async () => {
    await db.exec(`CREATE TABLE t (id text PRIMARY KEY)`)
    await db.query(`INSERT INTO t (id) VALUES ($1)`, ['a'])
    await expect(db.query(`INSERT INTO t (id) VALUES ($1)`, ['a'])).rejects.toSatisfy(isUniqueViolation)
  })

  it('租约：无人持有就占上，未过期时第二个认领者拿不到行', async () => {
    await db.exec(`CREATE TABLE leases (id text PRIMARY KEY, owner text NOT NULL, expires_at text NOT NULL)`)
    const claim = (owner: string, expiresAt: string) =>
      db.query<{ owner: string }>(
        `INSERT INTO leases (id, owner, expires_at) VALUES ('s1', $1, $2)
         ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
         WHERE leases.expires_at < now()
         RETURNING owner`,
        [owner, expiresAt],
      )

    const future = new Date(Date.now() + 60_000).toISOString()
    expect((await claim('one', future)).rows).toEqual([{ owner: 'one' }])
    expect((await claim('two', future)).rows).toEqual([])

    const past = new Date(Date.now() - 1_000).toISOString()
    await db.query(`UPDATE leases SET expires_at = $1 WHERE id = 's1'`, [past])
    expect((await claim('two', future)).rows).toEqual([{ owner: 'two' }])
  })

  it('BLOB 原样读写', async () => {
    await db.exec(`CREATE TABLE blobs (id text PRIMARY KEY, body blob NOT NULL)`)
    const body = Buffer.from([0, 1, 2, 250, 255])
    await db.query(`INSERT INTO blobs (id, body) VALUES ($1, $2)`, ['a', body])
    const rows = await db.query<{ body: Uint8Array }>(`SELECT body FROM blobs WHERE id = $1`, ['a'])
    expect(Buffer.from(rows.rows[0]!.body)).toEqual(body)
  })

  it('migrate 给老库补 is_default，并幂等回到可启动状态', async () => {
    // 老库文件里没有 is_default 列，schema 里的默认块唯一索引会引用它。
    await db.exec(`CREATE TABLE dsh_workspaces (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL,
      host_root text NOT NULL,
      guest_root text NOT NULL,
      volume_name text,
      state text NOT NULL DEFAULT 'active',
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_active_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`)

    await migrate(db)
    const column = await db.query(`SELECT name FROM pragma_table_info('dsh_workspaces') WHERE name = 'is_default'`)
    expect(column.rows).toHaveLength(1)

    await db.query(
      `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, is_default) VALUES ('ws_1', 'u1', '默认工作区', '/h', '/desk/ws_1', true)`,
    )
    await expect(
      db.query(
        `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, is_default) VALUES ('ws_2', 'u1', '又一个', '/h', '/desk/ws_2', true)`,
      ),
    ).rejects.toSatisfy(isUniqueViolation)

    // 再跑一次不会报「列已存在」。
    await migrate(db)
  })

  it('migrate 给老库的 dsh_mcp_servers 补 scope，并建公开名唯一索引', async () => {
    // 老库没有 scope 列；公开行依赖它做唯一索引。每个用例都是全新库，这里只建旧表。
    await db.exec(`CREATE TABLE dsh_mcp_servers (
      user_id text NOT NULL,
      server_name text NOT NULL,
      transport text NOT NULL,
      target text NOT NULL,
      config jsonb,
      enabled integer NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, server_name)
    )`)

    await migrate(db)
    const column = await db.query(`SELECT name FROM pragma_table_info('dsh_mcp_servers') WHERE name = 'scope'`)
    expect(column.rows).toHaveLength(1)

    // 同名私有行可以按成员各存一份；公开行按 server_name 唯一。
    await db.query(
      `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, scope) VALUES ('u1', 'search', 'streamable-http', 'https://a', 'private')`,
    )
    await db.query(
      `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, scope) VALUES ('u2', 'search', 'streamable-http', 'https://b', 'private')`,
    )
    await db.query(
      `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, scope) VALUES ('admin', 'shared', 'streamable-http', 'https://c', 'public')`,
    )
    await expect(
      db.query(
        `INSERT INTO dsh_mcp_servers (user_id, server_name, transport, target, scope) VALUES ('other', 'shared', 'streamable-http', 'https://d', 'public')`,
      ),
    ).rejects.toSatisfy(isUniqueViolation)

    // 幂等：第二次迁移不会因为列或索引已存在而失败。
    await migrate(db)
  })

  it('migrate 把老渠道表的 provider 约束放宽到 GitHub，且不带走回信', async () => {
    // 老库只允许飞书；重建表时要保住已有渠道和引用它的回信。
    await db.exec(`
      CREATE TABLE dsh_users (id text PRIMARY KEY, display_name text NOT NULL, password_hash text NOT NULL);
      INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', '一', 'x');
      CREATE TABLE dsh_superagent_channels (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK (provider IN ('feishu')),
        name text NOT NULL DEFAULT '',
        app_id text NOT NULL,
        secret_ciphertext blob NOT NULL,
        secret_key_version integer NOT NULL DEFAULT 1,
        config text NOT NULL DEFAULT '{}',
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
        last_error text,
        last_event_at text,
        created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (user_id, provider, app_id)
      );
      CREATE TABLE dsh_superagent_outbox (
        id text PRIMARY KEY,
        channel_id text NOT NULL REFERENCES dsh_superagent_channels(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'pending',
        next_attempt_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO dsh_superagent_channels (id, user_id, provider, app_id, secret_ciphertext)
        VALUES ('ch_feishu', 'u1', 'feishu', 'cli_1', X'00');
      INSERT INTO dsh_superagent_outbox (id, channel_id) VALUES ('ob_1', 'ch_feishu');
    `)

    await migrate(db)

    // 老渠道和它的回信都还在。
    expect((await db.query(`SELECT id, provider FROM dsh_superagent_channels`)).rows).toEqual([
      { id: 'ch_feishu', provider: 'feishu' },
    ])
    expect((await db.query(`SELECT id FROM dsh_superagent_outbox`)).rows).toEqual([{ id: 'ob_1' }])

    // GitHub 渠道能存进来了，别的值仍然被挡；第二次迁移不会重复重建表。
    await db.query(
      `INSERT INTO dsh_superagent_channels (id, user_id, provider, app_id, secret_ciphertext)
       VALUES ('ch_gh', 'u1', 'github', 'gh_1', X'01')`,
    )
    await expect(
      db.query(
        `INSERT INTO dsh_superagent_channels (id, user_id, provider, app_id, secret_ciphertext)
         VALUES ('ch_x', 'u1', 'gitlab', 'gl_1', X'02')`,
      ),
    ).rejects.toThrow(/CHECK/)
    await migrate(db)
    expect((await db.query(`SELECT count(*) AS n FROM dsh_superagent_channels`)).rows[0]?.n).toBe(2)
  })
})
