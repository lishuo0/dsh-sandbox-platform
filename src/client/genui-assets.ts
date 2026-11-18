/**
 * genui 的懒加载引擎脚本。
 *
 * 浏览器半请求 `/plugins/@changfenhuang/dsh-genui/assets/<name>.js`；平台的
 * `/plugins` 由 client-modules 应答，只放行图片，`.js` 一律 404。这里单独从
 * 平台安装的包里读扁平文件名，白名单与插件自己的资产列表一致。
 */

import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const GENUI_ASSET_PREFIX = '/plugins/@changfenhuang/dsh-genui/assets/'

/** 插件的懒加载资产（`lib/assets/<name>.js`）。standalone 由宿主内联，不走这条路由。 */
const ASSET_NAMES = new Set(['echarts-core', 'echarts-full', 'mermaid', 'three', 'icons', 'maplibre'])

const FLAT_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.js$/

/** 请求路径命中 genui 资产前缀时返回磁盘路径；越界、非白名单或不存在返回 undefined。 */
export function genuiAsset(path: string): string | undefined {
  if (!path.startsWith(GENUI_ASSET_PREFIX)) return undefined
  const file = path.slice(GENUI_ASSET_PREFIX.length)
  if (file.includes('/') || file.includes('..')) return undefined
  const match = FLAT_FILE.exec(file)
  if (match === null || !ASSET_NAMES.has(match[1])) return undefined
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('@changfenhuang/dsh-genui/package.json')
    const target = resolve(dirname(manifest), 'lib/assets', file)
    return statSync(target).isFile() ? target : undefined
  } catch {
    return undefined
  }
}
