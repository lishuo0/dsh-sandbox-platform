import { describe, expect, it } from 'vitest'
import { API_PREFIX } from '../../src/kernel/http.js'
import {
  answersPath,
  answersSessionId,
  parseAnswer,
  SESSION_STREAM_PREFIX,
  sessionStreamId,
  sessionStreamPath,
} from '../../src/client/mux/protocol.js'

/** 实时面只挂在统一前缀下，且只认 `P/sessions/{id}/stream|answers` 两个模板。 */

describe('会话流路径', () => {
  it('前缀与平台的 API_PREFIX 一致', () => {
    expect(SESSION_STREAM_PREFIX).toBe(`${API_PREFIX}/sessions/`)
  })

  it('解析会话 id 并支持百分号编码', () => {
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}s_abc/stream`)).toBe('s_abc')
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}s%2Fabc/stream`)).toBe('s/abc')
    expect(sessionStreamPath('s/abc')).toBe(`${SESSION_STREAM_PREFIX}s%2Fabc/stream`)
    expect(answersSessionId(`${SESSION_STREAM_PREFIX}s%2Fabc/answers`)).toBe('s/abc')
    expect(answersPath('s/abc')).toBe(`${SESSION_STREAM_PREFIX}s%2Fabc/answers`)
  })

  it('拒绝前缀之外的路径与多段路径', () => {
    expect(sessionStreamId('/api/remote.mux')).toBeUndefined()
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}/stream`)).toBeUndefined()
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}a/b/stream`)).toBeUndefined()
    expect(sessionStreamId(`${API_PREFIX}/sessions/s_abc/events`)).toBeUndefined()
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}s_abc/stream/extra`)).toBeUndefined()
    expect(answersSessionId(`${SESSION_STREAM_PREFIX}s_abc/stream`)).toBeUndefined()
  })

  it('畸形的百分号编码当作不匹配', () => {
    expect(sessionStreamId(`${SESSION_STREAM_PREFIX}%E0%A4%A/stream`)).toBeUndefined()
  })
})

describe('上行答复体', () => {
  const sessionId = 's_abc'

  it('接受 result 与 rejected', () => {
    expect(parseAnswer({ requestId: 'r1', outcome: { kind: 'result', value: 'approved' } }, sessionId)).toEqual({
      ok: true,
      body: { requestId: 'r1', outcome: { kind: 'result', value: 'approved' } },
    })
    expect(parseAnswer({ requestId: 'r1', outcome: { kind: 'rejected', error: 'nope' } }, sessionId)).toEqual({
      ok: true,
      body: { requestId: 'r1', outcome: { kind: 'rejected', error: 'nope' } },
    })
    expect(parseAnswer({ requestId: 'r1', outcome: { kind: 'rejected' } }, sessionId)).toEqual({
      ok: true,
      body: { requestId: 'r1', outcome: { kind: 'rejected' } },
    })
  })

  it('拒绝形状不对的体', () => {
    expect(parseAnswer('nope', sessionId)).toEqual({ ok: false, code: 'invalid-answer' })
    expect(parseAnswer([], sessionId)).toEqual({ ok: false, code: 'invalid-answer' })
    expect(parseAnswer({ outcome: { kind: 'result' } }, sessionId)).toEqual({ ok: false, code: 'invalid-answer' })
    expect(parseAnswer({ requestId: 'r1' }, sessionId)).toEqual({ ok: false, code: 'invalid-answer' })
    expect(parseAnswer({ requestId: 'r1', outcome: { kind: 'approved' } }, sessionId)).toEqual({
      ok: false,
      code: 'invalid-answer',
    })
  })

  it('体里点名别的会话时直接拒绝', () => {
    expect(parseAnswer({ requestId: 'r1', sessionId: 's_other', outcome: { kind: 'result' } }, sessionId)).toEqual({
      ok: false,
      code: 'session/mismatch',
    })
  })
})
