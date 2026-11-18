import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOOT_ASSET_PREFIX, bootAsset, matchBootAsset } from '../../src/client/boot-assets.js'

/**
 * 启动资产决定客户端 boot 之前加载什么。传输适配是第一个资产：URL 必须带
 * 内容哈希，正文必须原样取自 `transport-client.js`（不经过转译）。
 */

describe('启动资产', () => {
  it('传输适配按内容哈希下发', () => {
    const body = readFileSync(new URL('../../src/client/transport-client.js', import.meta.url), 'utf8')
    const rev = createHash('sha256').update(body).digest('hex').slice(0, 12)
    const asset = bootAsset('transport')
    expect(asset.body).toBe(body)
    expect(asset.rev).toBe(rev)
    expect(asset.url).toBe(`${BOOT_ASSET_PREFIX}/transport.js?rev=${rev}`)
  })

  it('进程内重复读取返回同一份内容', () => {
    expect(bootAsset('transport')).toBe(bootAsset('transport'))
  })

  it('未知资产直接报错', () => {
    expect(() => bootAsset('missing')).toThrow('unknown boot asset')
  })

  it('路由只认完整路径，rev 命中才可强缓存', () => {
    const asset = bootAsset('transport')
    expect(matchBootAsset(`${BOOT_ASSET_PREFIX}/transport.js`, asset.rev)).toEqual({ asset, fresh: true })
    expect(matchBootAsset(`${BOOT_ASSET_PREFIX}/transport.js`, 'stale')?.fresh).toBe(false)
    expect(matchBootAsset(`${BOOT_ASSET_PREFIX}/transport.js`, null)?.fresh).toBe(false)
    expect(matchBootAsset(`${BOOT_ASSET_PREFIX}/transport.js/x`, asset.rev)).toBeUndefined()
    expect(matchBootAsset('/elsewhere/transport.js', asset.rev)).toBeUndefined()
  })

  it('正文不夹带 tsx 辅助函数', () => {
    const body = bootAsset('transport').body
    expect(body).toContain('__DSH_TRANSPORT__')
    expect(body).not.toContain('__name(')
  })
})
