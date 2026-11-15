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
      if (typeof dep === 'string' && dep.startsWith('@deepseek-ai/')) pending.push(dep)
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
  const indexHtml = renderIndexInjections(
    readFileSync(resolve(shellRoot, 'index.html'), 'utf8'),
    bootInjections(graph),
  )

  return {
    indexHtml,
    shellRoot,
    fetchPlugin: (url, method, headers) => {
      if (!url.startsWith('/plugins/') && url !== '/plugins') return Promise.resolve(undefined)
      return registry.fetchBundle(new Request(`http://dsh.local${url}`, { method, headers }))
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
