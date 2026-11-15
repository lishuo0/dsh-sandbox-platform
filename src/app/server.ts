import type { Deps } from './deps.js'
import { startClientHost } from '../client/host.js'
import { createClientSurface } from '../client/surface.js'
import { startHttp, type Route } from '../kernel/http.js'
import { attachmentRoutes } from '../modules/attachments/routes.js'
import { identityRoutes } from '../modules/identity/routes.js'
import { mcpRoutes } from '../modules/mcp/routes.js'
import { modelRoutes } from '../modules/models/routes.js'
import { opsRoutes } from '../modules/ops/routes.js'
import { sessionRoutes } from '../modules/sessions/routes.js'
import { skillRoutes } from '../modules/skills/routes.js'
import { workspaceRoutes } from '../modules/workspaces/routes.js'

/** 新能力在这里挂上自己的路由。模块之间不互相注册。 */
const modules: Array<(deps: Deps) => Route[]> = [
  identityRoutes,
  modelRoutes,
  workspaceRoutes,
  sessionRoutes,
  skillRoutes,
  mcpRoutes,
  attachmentRoutes,
  opsRoutes,
]

export async function startPlatform(deps: Deps): Promise<void> {
  const client = await startClientHost()
  const surface = createClientSurface(deps.config, deps.db, client)
  startHttp(deps.config, deps.db, modules.flatMap((mount) => mount(deps)), surface)
}
