import { describe, expect, it } from 'vitest'
import { createAssistantStreamRevisions, EMPTY_ASSISTANT_STREAM } from '../../src/client/mux/assistant-stream.js'

/**
 * 浏览器助手流的 revision 是**通道本地**序号。
 *
 * 回归点：平台曾经把快照固定成 `{revision: 0}`，却原样转发脑侧的
 * `revision`（Agent 实例级、跨回合不重置）。同一会话发第二条消息时，脑的
 * 第一帧是 `start` + `revision: 74`，客户端按 `expected = 0 + 1` 校验，
 * 判定 `session assistant stream skipped revision 1` 并断开整条会话流——
 * 于是回复要刷新页面才能看到。
 */
describe('浏览器助手流 revision', () => {
  it('快照基线为 0，第一帧是 1', () => {
    expect(EMPTY_ASSISTANT_STREAM).toEqual({ revision: 0 })
    const revisions = createAssistantStreamRevisions()
    expect(revisions.next({ type: 'start' }).revision).toBe(1)
  })

  it('任意脑侧起点都重新编号为 1、2、3……', () => {
    const revisions = createAssistantStreamRevisions()
    const wire = [
      revisions.next({ type: 'start', revision: 74, attemptId: 'a', turn: 3, step: 0 }),
      revisions.next({ type: 'chunk', revision: 75, attemptId: 'a', index: 0 }),
      revisions.next({ type: 'chunk', revision: 76, attemptId: 'a', index: 1 }),
      revisions.next({ type: 'end', revision: 77, attemptId: 'a', index: 2 }),
    ]
    expect(wire.map((frame) => frame.revision)).toEqual([1, 2, 3, 4])
    // 客户端循环里的连续性校验：从基线开始，每帧恰好 +1。
    let expected = EMPTY_ASSISTANT_STREAM.revision
    for (const frame of wire) {
      expected += 1
      expect(frame.revision).toBe(expected)
    }
  })

  it('只替换 revision，尝试内容原样透传', () => {
    const revisions = createAssistantStreamRevisions()
    const stream = revisions.next({
      type: 'chunk',
      revision: 9,
      attemptId: 'attempt-1',
      index: 4,
      time: 1234,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    })
    expect(stream).toEqual({
      type: 'chunk',
      revision: 1,
      attemptId: 'attempt-1',
      index: 4,
      time: 1234,
      chunk: { type: 'text-delta', index: 0, text: '你好' },
    })
  })

  it('每条通道独立编号（重连/第二个标签页从 1 重新开始）', () => {
    const first = createAssistantStreamRevisions()
    const second = createAssistantStreamRevisions()
    first.next({ type: 'start' })
    first.next({ type: 'chunk' })
    expect(second.next({ type: 'start' }).revision).toBe(1)
  })
})
