/**
 * 平台自己的浏览器启动资产。
 *
 * 这些脚本必须跑在任何客户端模块之前，所以走上游 `renderIndexInjections` 的
 * `script-src` 行：外壳页 head 里得到一个 parser-blocking 的 `<script src>`，
 * 顺序由 HTML 解析保证，而不是把正文内联进每个页面。
 *
 * URL 带内容哈希：内容一变 rev 就变，浏览器可以按 `immutable` 强缓存；
 * 旧页面拿着旧 rev 回来时仍拿得到当前正文，但不写强缓存，避免把新正文
 * 缓存到旧 URL 下。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const BOOT_ASSET_PREFIX = '/dsh-api/platform/v1/client'

export interface BootAsset {
  readonly id: string
  readonly rev: string
  /** 页面里引用的带版本路径。 */
  readonly url: string
  /** classic script 正文，按文件原样下发，不经过任何转译。 */
  readonly body: string
}

interface BootAssetSource {
  readonly id: string
  readonly file: string
}

const SOURCES: readonly BootAssetSource[] = [{ id: 'transport', file: 'transport-client.js' }]

const loaded = new Map<string, BootAsset>()

/** 取一个启动资产；进程内只读一次文件，rev 由正文内容算出。 */
export function bootAsset(id: string): BootAsset {
  const cached = loaded.get(id)
  if (cached !== undefined) return cached
  const source = SOURCES.find((row) => row.id === id)
  if (source === undefined) throw new Error(`unknown boot asset: ${id}`)
  const body = readFileSync(new URL(`./${source.file}`, import.meta.url), 'utf8')
  const rev = createHash('sha256').update(body).digest('hex').slice(0, 12)
  const asset: BootAsset = { id, rev, url: `${BOOT_ASSET_PREFIX}/${id}.js?rev=${rev}`, body }
  loaded.set(id, asset)
  return asset
}

/**
 * 静态路由：`<prefix>/<id>.js?rev=<rev>`。
 * `fresh` 表示请求的 rev 就是当前内容的 rev，可以下发 `immutable` 缓存。
 */
export function matchBootAsset(
  pathname: string,
  rev: string | null,
): { readonly asset: BootAsset; readonly fresh: boolean } | undefined {
  for (const source of SOURCES) {
    if (pathname !== `${BOOT_ASSET_PREFIX}/${source.id}.js`) continue
    const asset = bootAsset(source.id)
    return { asset, fresh: rev === asset.rev }
  }
  return undefined
}
