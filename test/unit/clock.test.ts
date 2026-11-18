import { describe, expect, it } from 'vitest'
import { MIN_INTERVAL_SECONDS, nextRun, type ScheduleRule } from '../../src/modules/schedule/clock.js'

const at = (iso: string) => new Date(iso)

describe('schedule clock', () => {
  it('一次性任务不能算下一次', () => {
    expect(() => nextRun('after', {}, at('2026-01-01T00:00:00Z'))).toThrow('一次性任务发完即停用')
    expect(() => nextRun('at', {}, at('2026-01-01T00:00:00Z'))).toThrow('一次性任务发完即停用')
  })

  it('未知规则直接拒绝', () => {
    expect(() => nextRun('monthly', {}, at('2026-01-01T00:00:00Z'))).toThrow('未知的定时规则：monthly')
  })

  it('间隔下限是 60 秒', () => {
    expect(MIN_INTERVAL_SECONDS).toBe(60)
    expect(() => nextRun('every', { everySeconds: 30 }, at('2026-01-01T00:00:00Z'))).toThrow('间隔最短 60 秒')
    expect(() => nextRun('every', { everySeconds: 60.5 }, at('2026-01-01T00:00:00Z'))).toThrow('间隔最短 60 秒')
  })

  it('every 按锚点对齐到下个整步', () => {
    const rule: ScheduleRule = { everySeconds: 300, anchor: '2026-01-01T00:00:00Z' }
    expect(nextRun('every', rule, at('2026-01-01T00:01:00Z')).toISOString()).toBe('2026-01-01T00:05:00.000Z')
    expect(nextRun('every', rule, at('2026-01-01T00:05:00Z')).toISOString()).toBe('2026-01-01T00:10:00.000Z')
    expect(nextRun('every', rule, at('2026-01-01T00:06:00Z')).toISOString()).toBe('2026-01-01T00:10:00.000Z')
  })

  it('every 在锚点之前也至少隔一个整步', () => {
    const rule: ScheduleRule = { everySeconds: 300, anchor: '2026-01-01T00:00:00Z' }
    expect(nextRun('every', rule, at('2025-12-31T23:59:00Z')).toISOString()).toBe('2026-01-01T00:05:00.000Z')
  })

  it('every 锚点不合法直接拒绝', () => {
    expect(() => nextRun('every', { everySeconds: 60, anchor: 'nope' }, at('2026-01-01T00:00:00Z'))).toThrow('间隔的锚点不合法')
  })

  it('daily 找下一个钟点', () => {
    const rule: ScheduleRule = { time: '09:30:00', timeZone: 'UTC' }
    expect(nextRun('daily', rule, at('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-01T09:30:00.000Z')
    expect(nextRun('daily', rule, at('2026-01-01T09:30:00Z')).toISOString()).toBe('2026-01-02T09:30:00.000Z')
  })

  it('daily 按指定时区理解钟点', () => {
    const rule: ScheduleRule = { time: '09:30:00', timeZone: 'Asia/Shanghai' }
    // 上海 09:30 = UTC 01:30
    expect(nextRun('daily', rule, at('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-01T01:30:00.000Z')
  })

  it('daily 跳过夏令时不存在的那一天', () => {
    // 纽约 2026-03-08 02:30 不存在，顺延到 03-09 02:30 EDT（UTC 06:30）
    const rule: ScheduleRule = { time: '02:30:00', timeZone: 'America/New_York' }
    expect(nextRun('daily', rule, at('2026-03-07T12:00:00Z')).toISOString()).toBe('2026-03-09T06:30:00.000Z')
  })

  it('weekly 只落在指定星期（ISO 1-7）', () => {
    // 2026-01-01 是周四；只要周五（ISO 5）
    const rule: ScheduleRule = { time: '10:00:00', weekdays: [5], timeZone: 'UTC' }
    const next = nextRun('weekly', rule, at('2026-01-01T00:00:00Z'))
    expect(next.toISOString()).toBe('2026-01-02T10:00:00.000Z')
    expect(next.getUTCDay()).toBe(5)
  })

  it('cron 支持步长与列表', () => {
    expect(nextRun('cron', { expression: '*/15 * * * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:15:00.000Z',
    )
    expect(nextRun('cron', { expression: '5,35 * * * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-01T00:05:00.000Z',
    )
  })

  it('cron 支持范围与月份、星期名', () => {
    expect(nextRun('cron', { expression: '0 9-11 * * *', timeZone: 'UTC' }, at('2026-01-01T08:00:00Z')).toISOString()).toBe(
      '2026-01-01T09:00:00.000Z',
    )
    // 2026-01-01 周四，下一个周一 01-05
    expect(nextRun('cron', { expression: '0 8 * jan mon', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2026-01-05T08:00:00.000Z',
    )
  })

  it('cron 的日与星期都限定时命中任一即可', () => {
    const rule: ScheduleRule = { expression: '0 0 13 * fri', timeZone: 'UTC' }
    // 周五 01-02 先命中
    expect(nextRun('cron', rule, at('2026-01-01T00:00:00Z')).toISOString()).toBe('2026-01-02T00:00:00.000Z')
    // 之后还有周五 01-09，再之后才是 13 号
    expect(nextRun('cron', rule, at('2026-01-02T00:00:00Z')).toISOString()).toBe('2026-01-09T00:00:00.000Z')
  })

  it('cron 分段必须五段', () => {
    expect(() => nextRun('cron', { expression: '* * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('cron 要五段')
    expect(() => nextRun('cron', {}, at('2026-01-01T00:00:00Z'))).toThrow('cron 要五段')
  })

  it('cron 非法字段直接拒绝', () => {
    expect(() => nextRun('cron', { expression: 'x * * * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('cron 不合法')
    expect(() => nextRun('cron', { expression: '*/0 * * * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('cron 不合法')
    expect(() => nextRun('cron', { expression: '0 0 32 * *', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('cron 不合法')
  })

  it('钟点格式错误直接拒绝', () => {
    expect(() => nextRun('daily', { time: '9-30', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('钟点要用 HH:mm:ss')
    expect(() => nextRun('daily', { time: '25:00:00', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('钟点不合法')
    expect(() => nextRun('daily', { time: '12:75:00', timeZone: 'UTC' }, at('2026-01-01T00:00:00Z'))).toThrow('钟点不合法')
  })
})
