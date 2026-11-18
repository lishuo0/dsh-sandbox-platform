import { describe, expect, it } from 'vitest'
import { appendContiguous, eventRecordOf, tailSeqOf, wireEventOf } from '../../src/client/mux/event.js'

/**
 * 浏览器流的事件信封必须原样带上表面元数据。
 *
 * 回归点：`session/page` 曾只复制 `type/seq/time/data`，`system/message` 到了
 * 浏览器没有 `surfaceOp`，整段历史被 session store 拒绝
 * （`requires a surfaceOp marker`）。
 */
describe('浏览器流的事件信封', () => {
  it('surface 事件保留 append 与 replace 标记', () => {
    const append = wireEventOf({
      type: 'system/message',
      seq: 8,
      time: 1,
      data: { message: { role: 'system' } },
      surfaceOp: 'append',
    })
    expect(append).toEqual({
      type: 'system/message',
      seq: 8,
      time: 1,
      data: { message: { role: 'system' } },
      surfaceOp: 'append',
    })

    const replace = { op: 'replace', startSeq: 8, endSeq: 8 }
    const replaced = wireEventOf({ type: 'system/message', seq: 24, time: 2, data: {}, surfaceOp: replace })
    expect(replaced.surfaceOp).toEqual(replace)
  })

  it('sourceEventSeqs 与 ignorable 一起透传', () => {
    const record = eventRecordOf({
      type: 'user/message',
      seq: 9,
      time: 3,
      data: {},
      surfaceOp: 'append',
      sourceEventSeqs: [8],
      ignorable: true,
    })
    expect(record).toMatchObject({
      type: 'event',
      event: { seq: 9, surfaceOp: 'append', sourceEventSeqs: [8], ignorable: true },
    })
  })

  it('日志独占事件不多带表面字段', () => {
    const event = wireEventOf({ type: 'turn/start', seq: 1, time: 4, data: {} })
    expect(event).not.toHaveProperty('surfaceOp')
    expect(event).not.toHaveProperty('sourceEventSeqs')
    expect(event).not.toHaveProperty('ignorable')
  })

  it('缺字段时给出稳定的信封', () => {
    const event = wireEventOf({})
    expect(event).toMatchObject({ type: 'unknown', seq: 0, data: null })
    expect(typeof event.time).toBe('number')
  })
})

/**
 * follow 快照的 `cursor` 必须等于页内末条 seq。回归点：
 * 并发写入时若用表上 MAX(seq) 当 cursor，页尾会落后于 cursor，
 * 浏览器 journal 报 `page did not end at its requested cursor`。
 */
describe('页尾游标', () => {
  it('取页内最大 seq，空页是上游的 emptyCursor -1', () => {
    expect(tailSeqOf([])).toBe(-1)
    expect(tailSeqOf([{ seq: 3 }, { seq: 9 }, { seq: 5 }])).toBe(9)
    expect(tailSeqOf([{ seq: 0 }])).toBe(0)
  })

  it('忽略非法 seq，不影响真实尾游标', () => {
    expect(tailSeqOf([{ seq: 7 }, {}, { seq: Number.NaN }, { seq: 'x' }])).toBe(7)
  })
})

/**
 * 脑先广播后落库，库尾可能落后于脑的日志末尾。补历史时只能接连续段：
 * 有空洞宁可不补，也不能把不连续的日志交给浏览器的 journal 校验。
 */
describe('补页尾', () => {
  it('从页尾的下一条开始，按 seq 升序接上', () => {
    const base = [{ seq: 10 }, { seq: 11 }]
    const merged = appendContiguous(base, [{ seq: 13 }, { seq: 12 }], 11)
    expect(merged.map(event => event.seq)).toEqual([10, 11, 12, 13])
  })

  it('跳过与页内重叠的事件，遇到空洞立即停止', () => {
    const base = [{ seq: 10 }]
    const merged = appendContiguous(base, [{ seq: 10 }, { seq: 11 }, { seq: 13 }, { seq: 14 }], 10)
    expect(merged.map(event => event.seq)).toEqual([10, 11])
  })

  it('没有可补事件时原样返回', () => {
    const base = [{ seq: 3 }]
    expect(appendContiguous(base, [], 3)).toEqual(base)
    expect(appendContiguous(base, [{ seq: 1 }], 3)).toEqual(base)
  })
})
