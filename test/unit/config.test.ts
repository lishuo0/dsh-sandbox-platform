import { describe, expect, it } from 'vitest'
import { parseSuperagentConfig } from '../../src/config.js'

/**
 * 部署级接单兜底：`config.yaml` 的 `superagent` 段。
 *
 * 这一层是给「别人部署、不想改代码」的人用的：写错要在启动时就报错，
 * 不能悄悄退回默认值，让人以为规则生效了其实没有。
 */

describe('parseSuperagentConfig', () => {
  it('没写就返回 undefined，行为与以前一致', () => {
    expect(parseSuperagentConfig(undefined)).toBeUndefined()
    expect(parseSuperagentConfig(null)).toBeUndefined()
  })

  it('规则去掉空行和首尾空格', () => {
    expect(
      parseSuperagentConfig({
        defaultRules: ['  前端改动可以接  ', '', '   ', '数据库迁移不要动'],
      }),
    ).toEqual({
      defaultRules: ['前端改动可以接', '数据库迁移不要动'],
    })
  })

  it('规则全是空行时不留下空数组，交给内置默认范围', () => {
    expect(parseSuperagentConfig({ defaultRules: ['', '  '] })).toEqual({})
  })

  it('旧的 defaultAcceptMode 会明确报错，不悄悄忽略', () => {
    expect(() => parseSuperagentConfig({ defaultAcceptMode: 'yolo' })).toThrowError(
      /defaultAcceptMode/,
    )
    expect(() => parseSuperagentConfig({ defaultAcceptMode: 'auto' })).toThrowError(/已移除/)
  })

  it('规则不是字符串数组直接报错', () => {
    expect(() => parseSuperagentConfig({ defaultRules: '前端改动可以接' })).toThrowError(
      /defaultRules/,
    )
    expect(() => parseSuperagentConfig({ defaultRules: ['可以接', 42] })).toThrowError(
      /defaultRules/,
    )
  })

  it('整段不是对象也报错', () => {
    expect(() => parseSuperagentConfig(['auto'])).toThrowError(/superagent/)
  })
})