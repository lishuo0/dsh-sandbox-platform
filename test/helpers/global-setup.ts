import { ensureCluster, TEST_DIALECT } from './pg.js'

/** 默认 SQLite 不需要外部服务；`TEST_DB=postgres` 时共用一套本地集群（端口 55432）。 */
export async function setup(): Promise<void> {
  if (TEST_DIALECT === 'postgres') await ensureCluster()
}
