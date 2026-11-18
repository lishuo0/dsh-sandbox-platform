/**
 * 组装 DSH 客户端的启动图，并给出带注入的外壳页面。
 *
 * 外壳来自 `@deepseek-ai/dsh-web-frontend`，那是 `@deepseek-ai/dsh-client-web`
 * 编出来的 `AppWebEntry`。会话、侧边栏、文件树和输入框来自客户端插件，不来自 `dsh web` 宿主。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { clientPackages, requiredClientPackages } from './roster.js'
import { patchPluginResponse } from './patch.js'
import { userBadge } from './user-badge.js'
import { platformConsole } from './console.js'
import { workspaceCreate } from './workspace-create.js'
import { filesUpload } from './files-upload.js'
import { platformModelSettings } from './model-settings.js'
import { bootAsset } from './boot-assets.js'

export interface ClientHost {
  /** 注入了 `__DSH_BOOT__` 的外壳页面。 */
  readonly indexHtml: string
  /** 外壳静态文件根目录。 */
  readonly shellRoot: string
  /** 按客户端模块系统应答一条 `/plugins` 请求。未命中时返回 undefined。 */
  fetchPlugin(url: string, method: string, headers: Headers): Promise<Response | undefined>
}

interface PackageManifest {
  exports?: unknown
  dsh?: { client?: { platform?: string; inject?: readonly string[] } }
}

interface LoaderHost {
  create(options: { name: string }): Promise<unknown>
}

interface ModuleHost {
  graph(): { entries: Array<{ id: string }> }
  fetchBundle(request: Request): Promise<Response>
}

/** 启动客户端模块表。某个包的宿主半侧挂起时，浏览器包仍然进图。 */
export async function startClientHost(): Promise<ClientHost> {
  const require = createRequire(import.meta.url)
  const ctx = new Context()
  const baseUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json')).href
  await ctx.plugin(Loader, { baseUrl })
  const loader = (ctx as Context & { loader: LoaderHost }).loader

  await settle(loader.create({ name: '@deepseek-ai/dsh-client-modules' }), '@deepseek-ai/dsh-client-modules')
  const registry = (ctx as Context & { clientModules?: ModuleHost }).clientModules
  if (registry === undefined) throw new Error('客户端模块表没有挂上')

  const pending: string[] = clientPackages.filter((name) => name !== '@deepseek-ai/dsh-client-modules')
  const seen = new Set<string>(['@deepseek-ai/dsh-client-modules'])
  const tasks: Array<Promise<void>> = []
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    const manifest = readManifest(require, name)
    const clientFile = clientBundle(manifest)
    if (manifest.dsh?.client?.platform !== 'web' || clientFile === undefined) {
      throw new Error(`客户端包 ${name} 没有可加载的浏览器包`)
    }
    for (const dep of manifest.dsh.client.inject ?? []) {
      if (typeof dep !== 'string' || !dep.startsWith('@deepseek-ai/')) continue
      // inject 里可能列的是纯库包（例如 ui-primitives），没有浏览器包，
      // 只作为别人的构建依赖存在，不能当客户端插件单独加载。
      const depManifest = peekManifest(require, dep)
      if (depManifest?.dsh?.client?.platform === 'web' && clientBundle(depManifest) !== undefined) {
        pending.push(dep)
      }
    }
    tasks.push(settle(loader.create({ name }), name))
  }
  await Promise.all(tasks)
  let graph = registry.graph()
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && requiredClientPackages.some((name) => !graph.entries.some((entry) => entry.id === name))) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    graph = registry.graph()
  }
  const present = new Set(graph.entries.map((entry) => entry.id))
  const missing = requiredClientPackages.filter((name) => !present.has(name))
  if (missing.length > 0) {
    throw new Error(`客户端启动图缺少：${missing.join('、')}`)
  }

  const shellPkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const shellRoot = resolve(dirname(shellPkg), 'dist')
  // 模型密钥由平台保管，不走官方 DeepSeek 首启配 Key 弹窗。
  const indexHtml = renderIndexInjections(
    readFileSync(resolve(shellRoot, 'index.html'), 'utf8'),
    [
      // 客户端 boot 之前先装传输适配：unary Remote 走 `P/remote`，逻辑流走
      // `P/sse`，页面不再建立全局 WebSocket。脚本按内容哈希的静态资产下发，
      // 不内联进 HTML。
      { kind: 'script-src', placement: 'head', src: bootAsset('transport').url },
      ...bootInjections(graph),
      {
        kind: 'global',
        name: '__DSH_MODELS_ONBOARDING__',
        value: { credentialOnboarding: false },
      },
      // 侧边栏底部自带的「设置」入口由左下角头像菜单取代。
      // 官方设置改成右侧页面：不盖住左侧菜单；设置里的「通用设置 / 模型」导航保留。
      {
        kind: 'style',
        text: [
          '[class*="_settingsArea"]{display:none!important}',
          // 不要再写 inset:auto，会把同规则里的 top/left 一并冲掉；用 inset 一次钉死右侧铺满。
          // overlay 本身不接事件，只让设置面板接，避免透明层挡住左侧菜单。
          'body>div:has([data-shortcut-modal="settings"]){position:fixed!important;inset:0 0 0 var(--dsh-platform-sidebar-width,280px)!important;width:auto!important;height:auto!important;align-items:stretch!important;justify-content:stretch!important;display:flex!important;transform:none!important;pointer-events:none!important}',
          'body>div:has([data-shortcut-modal="settings"]) [class*="_mask"]{display:none!important;pointer-events:none!important}',
          'body>div:has([data-shortcut-modal="settings"]) [data-shortcut-modal="settings"]{width:100%!important;max-width:none!important;height:100%!important;max-height:none!important;border-radius:0!important;box-shadow:none!important;margin:0!important;pointer-events:auto!important}',
        ].join(''),
      },
      // 平台自己的 Skills / MCP 配置页；账号菜单负责打开。
      { kind: 'html', placement: 'body', html: platformConsole() },
      // 设置 → 模型：抄上游样式，数据对接平台 /settings/model。
      { kind: 'html', placement: 'body', html: platformModelSettings() },
      // 侧边栏工作区标题旁的「新增工作区」入口：名称 + 选择 Skills / MCP。
      { kind: 'html', placement: 'body', html: workspaceCreate() },
      // 右侧文件树的页头上传按钮：文件直接写进工作区的对象前缀。
      { kind: 'html', placement: 'body', html: filesUpload() },
      // DSH 客户端没有账号入口，登录身份由平台补充在侧边栏左下角。
      { kind: 'html', placement: 'body', html: userBadge() },
    ],
  )

  return {
    indexHtml,
    shellRoot,
    fetchPlugin: async (url, method, headers) => {
      if (!url.startsWith('/plugins/') && url !== '/plugins') return undefined
      const response = await registry.fetchBundle(new Request(`http://dsh.local${url}`, { method, headers }))
      // 上游设置页会挂「打开配置文件」按钮；平台部署里它指向脑宿主的配置文件。
      return patchPluginResponse(response, method)
    },
  }
}

function readManifest(require: NodeJS.Require, name: string): PackageManifest {
  let manifestPath: string
  try {
    manifestPath = require.resolve(`${name}/package.json`)
  } catch {
    throw new Error(`没有安装客户端包 ${name}。在平台目录执行 npm install。`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
  const relative = clientBundle(manifest)
  if (relative !== undefined && !existsSync(join(dirname(manifestPath), relative))) {
    throw new Error(`客户端包 ${name} 的浏览器包不在磁盘上`)
  }
  return manifest
}

/** 只看清单，不校验浏览器包；用于区分客户端插件和纯库依赖。 */
function peekManifest(require: NodeJS.Require, name: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as PackageManifest
  } catch {
    return undefined
  }
}

function clientBundle(manifest: PackageManifest): string | undefined {
  const exp = manifest.exports
  if (typeof exp !== 'object' || exp === null) return undefined
  const client = (exp as Record<string, unknown>)['./client']
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null && typeof (client as { default?: unknown }).default === 'string') {
    return (client as { default: string }).default
  }
  return undefined
}

/** 宿主插件在等服务时 create() 不返回。条目进表即可，不必等它变成 active。 */
function settle(task: Promise<unknown>, name: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    task.then(finish, (error: unknown) => {
      console.error(`客户端包 ${name} 没有挂上：${error instanceof Error ? error.message : String(error)}`)
      finish()
    })
    setTimeout(finish, 3000).unref?.()
  })
}
