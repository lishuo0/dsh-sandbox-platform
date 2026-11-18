import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { AppConfig } from '../config.js'
import { SqliteDb } from './sqlite.js'

export type Dialect = 'postgres' | 'sqlite'

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[]
  rowCount: number | null
}

export type Querier = {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>
}

/** 平台和脑共用一个库：本地是 SQLite 文件，部署是 PostgreSQL。 */
export interface Db extends Querier {
  readonly dialect: Dialect
  exec(sql: string): Promise<void>
  transaction<T>(run: (q: Querier) => Promise<T>): Promise<T>
  end(): Promise<void>
}

export async function openDb(cfg: AppConfig): Promise<Db> {
  if (cfg.database.file) return SqliteDb.open(cfg.database.file)
  if (!cfg.database.url) throw new Error('config.yaml 缺少 database.file 或 database.url')
  return pgDb(new pg.Pool({ connectionString: cfg.database.url }))
}

/** 把一个 pg 池包成 `Db`；测试也用它来造 PostgreSQL 方言的句柄。 */
export function pgDb(pool: pg.Pool): Db {
  return new PgDb(pool)
}

export async function migrate(db: Db): Promise<void> {
  const dir = dirname(fileURLToPath(import.meta.url))
  const file = resolve(dir, db.dialect === 'sqlite' ? '../schema.sqlite.sql' : '../schema.sql')
  // 老库文件里的 dsh_workspaces 还没有 is_default；schema 里的唯一索引会引用它，
  // 所以先补列再跑 schema（`CREATE TABLE IF NOT EXISTS` 不会给已有表加列）。
  await addColumnIfMissing(db, 'dsh_workspaces', 'is_default', {
    sqlite: `ALTER TABLE dsh_workspaces ADD COLUMN is_default integer NOT NULL DEFAULT 0`,
    postgres: `ALTER TABLE dsh_workspaces ADD COLUMN is_default boolean NOT NULL DEFAULT false`,
  })
  // 公开 MCP 依赖新加的 scope 列和它的唯一索引。
  await addColumnIfMissing(db, 'dsh_mcp_servers', 'scope', {
    sqlite: `ALTER TABLE dsh_mcp_servers ADD COLUMN scope text NOT NULL DEFAULT 'private'`,
    postgres: `ALTER TABLE dsh_mcp_servers ADD COLUMN scope text NOT NULL DEFAULT 'private'`,
  })
  // 老工作区没配过 Skill / MCP 选择，保持 false 才能沿用「全部启用」。
  await addColumnIfMissing(db, 'dsh_workspaces', 'selection_configured', {
    sqlite: `ALTER TABLE dsh_workspaces ADD COLUMN selection_configured integer NOT NULL DEFAULT 0`,
    postgres: `ALTER TABLE dsh_workspaces ADD COLUMN selection_configured boolean NOT NULL DEFAULT false`,
  })
  // 每个会话可以选不同模型；脑重启后要靠这一列把选择补回去。
  await addColumnIfMissing(db, 'dsh_sessions', 'model_id', {
    sqlite: `ALTER TABLE dsh_sessions ADD COLUMN model_id text`,
    postgres: `ALTER TABLE dsh_sessions ADD COLUMN model_id text`,
  })
  // 工作区 / 会话的显示顺序和置顶由平台按成员落库；脑只读投影，不能再用自己的进程状态。
  await addColumnIfMissing(db, 'dsh_workspaces', 'sort_order', {
    sqlite: `ALTER TABLE dsh_workspaces ADD COLUMN sort_order integer NOT NULL DEFAULT 0`,
    postgres: `ALTER TABLE dsh_workspaces ADD COLUMN sort_order integer NOT NULL DEFAULT 0`,
  })
  await addColumnIfMissing(db, 'dsh_sessions', 'sort_order', {
    sqlite: `ALTER TABLE dsh_sessions ADD COLUMN sort_order integer NOT NULL DEFAULT 0`,
    postgres: `ALTER TABLE dsh_sessions ADD COLUMN sort_order integer NOT NULL DEFAULT 0`,
  })
  await addColumnIfMissing(db, 'dsh_sessions', 'pinned_at', {
    sqlite: `ALTER TABLE dsh_sessions ADD COLUMN pinned_at text`,
    postgres: `ALTER TABLE dsh_sessions ADD COLUMN pinned_at timestamptz`,
  })
  // 技能 / MCP 的分组归属；老行没有分组，保持 NULL。
  await addColumnIfMissing(db, 'dsh_skills', 'group_id', {
    sqlite: `ALTER TABLE dsh_skills ADD COLUMN group_id text`,
    postgres: `ALTER TABLE dsh_skills ADD COLUMN group_id text`,
  })
  await addColumnIfMissing(db, 'dsh_mcp_servers', 'group_id', {
    sqlite: `ALTER TABLE dsh_mcp_servers ADD COLUMN group_id text`,
    postgres: `ALTER TABLE dsh_mcp_servers ADD COLUMN group_id text`,
  })
  // 管理员开户 / 重置密码后强制成员改密；老账号没有这一列，默认 false 不影响登录。
  await addColumnIfMissing(db, 'dsh_users', 'must_change_password', {
    sqlite: `ALTER TABLE dsh_users ADD COLUMN must_change_password integer NOT NULL DEFAULT 0`,
    postgres: `ALTER TABLE dsh_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false`,
  })
  await db.exec(readFileSync(file, 'utf8'))
  await migrateLegacyModelProviders(db)
}

/** 把旧的单行 `dsh_user_models` 迁到可多条的 `dsh_user_model_providers`。 */
async function migrateLegacyModelProviders(db: Db): Promise<void> {
  const legacy = await db.query<{
    user_id: string
    base_url: string
    api: string
    model_ids: unknown
    default_model: string
  }>(`SELECT user_id, base_url, api, model_ids, default_model FROM dsh_user_models`)
  for (const row of legacy.rows) {
    const existing = await db.query(`SELECT 1 FROM dsh_user_model_providers WHERE user_id = $1 LIMIT 1`, [row.user_id])
    if (existing.rows.length > 0) continue
    const id = `mp_legacy_${row.user_id}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64)
    await db.query(
      `INSERT INTO dsh_user_model_providers (id, user_id, display_name, base_url, api, model_ids, default_model, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [id, row.user_id, '', row.base_url, row.api || 'openai-completions', row.model_ids, row.default_model],
    )
    // 旧密钥 name=default → 挂到新 provider id；已有同名则不动。
    const secret = await db.query(
      `SELECT ciphertext, key_version FROM dsh_user_credentials
       WHERE user_id = $1 AND kind = 'model-api-key' AND name = 'default'`,
      [row.user_id],
    )
    const cipher = secret.rows[0]
    if (cipher?.ciphertext !== undefined) {
      await db.query(
        `INSERT INTO dsh_user_credentials (user_id, kind, name, ciphertext, key_version)
         VALUES ($1, 'model-api-key', $2, $3, $4)
         ON CONFLICT (user_id, kind, name) DO NOTHING`,
        [row.user_id, id, cipher.ciphertext, cipher.key_version ?? 1],
      )
    }
  }
}

async function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  ddl: { sqlite: string; postgres: string },
): Promise<void> {
  const present = db.dialect === 'sqlite'
    ? await db.query(`SELECT name FROM pragma_table_info('${table}') WHERE name = $1`, [column])
    : await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      )
  if (present.rows.length > 0) return
  const exists = db.dialect === 'sqlite'
    ? await db.query(`SELECT name FROM pragma_table_info('${table}') LIMIT 1`)
    : await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name = $1`, [table])
  if (exists.rows.length === 0) return
  await db.exec(db.dialect === 'sqlite' ? ddl.sqlite : ddl.postgres)
}

export async function withTx<T>(db: Db, run: (db: Querier) => Promise<T>): Promise<T> {
  return db.transaction(run)
}

class PgDb implements Db {
  readonly dialect: Dialect = 'postgres'

  constructor(private readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pool.query(text, [...params])
    return { rows: result.rows as T[], rowCount: result.rowCount }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async transaction<T>(run: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await run({
        query: async <R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) => {
          const result = await client.query(text, [...params])
          return { rows: result.rows as R[], rowCount: result.rowCount }
        },
      })
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async end(): Promise<void> {
    await this.pool.end()
  }
}
