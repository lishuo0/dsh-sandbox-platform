import { describe, expect, it } from 'vitest'
import { inboxView } from '../../src/client/mux/sse.js'

/**
 * 平台输入队列 → `inbox` 投影。
 *
 * 客户端按 `source.rpcId` 认回自己那次 `session/prompt` 提交，所以平台必须
 * 用原始 `requestId` 当 rpcId；排队的卡片全部落在 `next-turn`，`next-step` 为空。
 */

describe('inbox 投影', () => {
  it('把队列项按顺序放进 next-turn，rpcId 用原始请求号', () => {
    expect(inboxView([
      { id: 'msg_1', placement: 'queued', rpcId: 'req-1', content: '第一条' },
      { id: 'msg_2', placement: 'queued', rpcId: 'req-2', content: '第二条' },
    ])).toEqual({
      'next-turn': [
        { id: 'msg_1', source: { kind: 'user', rpcId: 'req-1' }, content: '第一条' },
        { id: 'msg_2', source: { kind: 'user', rpcId: 'req-2' }, content: '第二条' },
      ],
      'next-step': [],
    })
  })

  it('空队列给出空的两个槽位，而不是缺字段', () => {
    expect(inboxView([])).toEqual({ 'next-turn': [], 'next-step': [] })
  })
})
