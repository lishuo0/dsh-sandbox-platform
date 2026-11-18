import { describe, expect, it } from 'vitest'
import { GENUI_ASSET_PREFIX, genuiAsset } from '../../src/client/genui-assets.js'

describe('genui 懒加载资产', () => {
  it('白名单里的扁平脚本解析到安装包内', () => {
    for (const name of ['echarts-core', 'echarts-full', 'mermaid', 'three', 'icons', 'maplibre']) {
      const file = genuiAsset(`${GENUI_ASSET_PREFIX}${name}.js`)
      expect(file, name).toBeDefined()
      expect(file).toMatch(new RegExp(`/lib/assets/${name}\\.js$`))
    }
  })

  it('目录穿越、子目录、非白名单和非 .js 一律拒绝', () => {
    expect(genuiAsset(`${GENUI_ASSET_PREFIX}../index.js`)).toBeUndefined()
    expect(genuiAsset(`${GENUI_ASSET_PREFIX}nested/mermaid.js`)).toBeUndefined()
    expect(genuiAsset(`${GENUI_ASSET_PREFIX}standalone.js`)).toBeUndefined()
    expect(genuiAsset(`${GENUI_ASSET_PREFIX}mermaid.css`)).toBeUndefined()
    expect(genuiAsset(`${GENUI_ASSET_PREFIX}not-listed.js`)).toBeUndefined()
  })

  it('前缀之外不接管', () => {
    expect(genuiAsset('/plugins/@changfenhuang/dsh-genui/other/mermaid.js')).toBeUndefined()
    expect(genuiAsset('/plugins/other/assets/mermaid.js')).toBeUndefined()
  })
})
