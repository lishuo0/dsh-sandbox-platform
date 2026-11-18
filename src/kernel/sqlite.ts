/**
 * SQLite 版本的数据库适配。
 *
 * 本地默认一条连接、一个文件。SQL 仍按 PostgreSQL 的写法（`$1` 占位、`now()`、
 * `::jsonb` 等），进这里后翻译成 SQLite 能跑的形式。这样服务层只有一套 SQL。
 *
 * 注意：脑仓库 `packages/dsh-database/src/sqlite.ts` 是同一套翻译，改一边要同步另一边。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Db, Dialect, Querier, QueryResult } from './db.js'

export class SqliteDb implements Db {
  readonly dialect: Dialect = 'sqlite'
  /** 串行化所有访问：一条连接不能被并发读写。 */
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(private readonly db: DatabaseSync) {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
  }

  /** `node:sqlite` 是内置模块；旧 Node 打开 SQLite 模式时才需要报错。 */
  static async open(file: string): Promise<SqliteDb> {
    mkdirSync(dirname(file), { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    return new SqliteDb(new DatabaseSync(file))
  }

  query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.exclusive(() => this.execute<T>(text, params))
  }

  exec(sql: string): Promise<void> {
    return this.exclusive(() => {
      this.db.exec(sql)
    })
  }

  transaction<T>(run: (q: Querier) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const value = await run({ query: (text, params = []) => Promise.resolve(this.execute(text, params)) })
        this.db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* 事务可能已经被 SQLite 回滚 */
        }
        throw error
      }
    })
  }

  end(): Promise<void> {
    return this.exclusive(() => {
      this.db.close()
    })
  }

  private execute<T>(text: string, params: readonly unknown[]): QueryResult<T> {
    const translated = translate(text, params)
    const values = translated.params as SQLInputValue[]
    const statement = this.db.prepare(translated.text)
    if (statement.columns().length > 0) {
      const rows = statement.all(...values) as T[]
      return { rows, rowCount: rows.length }
    }
    const info = statement.run(...values)
    return { rows: [], rowCount: Number(info.changes) }
  }

  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export interface Translated {
  text: string
  params: unknown[]
}

const TOKEN =
  /('(?:[^']|'')*')|(\$(\d+))|\bnow\s*\(\s*\)|\btrue\b|\bfalse\b|::[A-Za-z_][A-Za-z0-9_]*(?:\[\])?|\bFOR\s+UPDATE(?:\s+SKIP\s+LOCKED)?\b/gi

/**
 * 把 PostgreSQL 风格的 SQL 翻成 SQLite：占位符换 `?`、`now()` 换时间参数、
 * 去掉类型转换和行锁、布尔字面量写成 1/0。引号里的内容整段跳过。
 */
export function translate(text: string, params: readonly unknown[] = []): Translated {
  const ordered: unknown[] = []
  const sql = text.replace(TOKEN, (match, quoted: string | undefined, _placeholder, index: string | undefined) => {
    if (quoted !== undefined) return quoted
    if (index !== undefined) {
      ordered.push(normalizeParam(params[Number(index) - 1]))
      return '?'
    }
    if (/^now/i.test(match)) {
      ordered.push(new Date().toISOString())
      return '?'
    }
    if (/^true$/i.test(match)) return '1'
    if (/^false$/i.test(match)) return '0'
    if (match.startsWith('::')) return ''
    return '' // FOR UPDATE [SKIP LOCKED]
  })
  return { text: sql, params: ordered }
}

/** SQLite 只接受 null / number / bigint / string / Uint8Array。 */
export function normalizeParam(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value)
  return value
}
