import { createDeps } from './app/deps.js'
import { startPlatform } from './app/server.js'
import { loadConfig } from './config.js'
import { migrate, openDb } from './kernel/db.js'
import { HttpError } from './kernel/errors.js'
import { bootstrapAdmin } from './modules/identity/routes.js'
import { startScheduleLoop } from './modules/schedule/loop.js'

const config = loadConfig()
const db = openDb(config)
await migrate(db)
const deps = createDeps(config, db)
try {
  await bootstrapAdmin(deps)
} catch (error) {
  if (error instanceof HttpError) {
    throw new Error('还没有管理员。请在 config.yaml 填写 auth.adminUsername 和至少 12 位的 auth.adminPassword')
  }
  throw error
}
startScheduleLoop(deps)
await startPlatform(deps)
console.log(`platform http://${config.http.host}:${config.http.port}`)
