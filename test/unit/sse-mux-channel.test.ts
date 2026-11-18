import { describe, expect, it } from 'vitest'
import { createMuxChannel, type Channel } from '../../src/client/mux/sse.js'

/**
 * 物理 `$mux` 流上的逻辑通道。
 *
 * 浏览器每源只允许 6 条 HTTP/1.1 连接，页面常驻流已经占 5 条；逻辑流必须能
 * 无限复用到一条物理流上。通道的语义要和直连 SSE 一一对应：
 * `frame` = 一个 `data:`，`error` = `event: error`，`end` = 关流。
 */
function fakeCarrier() {
  const frames: unknown[] = []
  const closes: Array<() => void> = []
  let closed = false
  const channel: Channel = {
    get closed() {
      return closed
    },
    send(value) {
      frames.push(value)
    },
    fail() {
      closed = true
    },
    close() {
      closed = true
      for (const listener of closes.splice(0)) listener()
    },
    onClose(listener) {
      closes.push(listener)
    },
  }
  return { channel, frames, closes, hang: () => { closed = true } }
}

describe('$mux 逻辑通道', () => {
  it('send 包装成 {type:"frame",channel,value}', () => {
    const { channel, frames } = fakeCarrier()
    const logical = createMuxChannel(channel, 'c1')
    logical.send({ hello: 1 })
    logical.send('text')
    expect(frames).toEqual([
      { type: 'frame', channel: 'c1', value: { hello: 1 } },
      { type: 'frame', channel: 'c1', value: 'text' },
    ])
  })

  it('close 发 end 并触发清理钩子，之后不再写帧', () => {
    const { channel, frames } = fakeCarrier()
    const logical = createMuxChannel(channel, 'c2')
    let closedCalls = 0
    logical.onClose(() => { closedCalls += 1 })
    logical.close()
    logical.close()
    logical.send({ late: true })
    expect(closedCalls).toBe(1)
    expect(logical.closed).toBe(true)
    expect(frames).toEqual([{ type: 'end', channel: 'c2' }])
  })

  it('fail 发带错误码的 error 帧；HttpError 保留平台错误码', () => {
    const { channel, frames } = fakeCarrier()
    const logical = createMuxChannel(channel, 'c3')
    const error = new Error('boom') as Error & { code?: string }
    error.code = 'session/not-found'
    logical.fail(error)
    expect(frames).toEqual([{
      type: 'error',
      channel: 'c3',
      error: { code: 'gateway/internal', message: 'boom' },
    }])
    expect(logical.closed).toBe(true)
  })

  it('物理流断开时逻辑通道一起关闭并清理', () => {
    const carrier = fakeCarrier()
    const first = createMuxChannel(carrier.channel, 'c4')
    const second = createMuxChannel(carrier.channel, 'c5')
    let firstClosed = 0
    let secondClosed = 0
    first.onClose(() => { firstClosed += 1 })
    second.onClose(() => { secondClosed += 1 })
    carrier.channel.close()
    expect(firstClosed).toBe(1)
    expect(secondClosed).toBe(1)
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(true)
    // 物理流已关：逻辑通道的 send 是静默 no-op，不再往上写。
    const before = carrier.frames.length
    first.send({ after: true })
    expect(carrier.frames.length).toBe(before)
  })
})
