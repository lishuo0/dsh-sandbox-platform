import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { AppConfig } from '../config.js'

export type Db = pg.Pool
export type Querier = Pick<pg.Pool | pg.PoolClient, 'query'>

export function openDb(cfg: AppConfig): Db {
  return new pg.Pool({ connectionString: cfg.database.url })
}

export async function migrate(db: Db): Promise<void> {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../schema.sql')
  await db.query(readFileSync(file, 'utf8'))
}

export async function withTx<T>(db: Db, run: (db: Querier) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
