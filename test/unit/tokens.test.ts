import { describe, expect, it } from 'vitest'
import { readToken, signToken } from '../../src/kernel/tokens.js'

const SECRET = 'unit-test-secret'

describe('tokens', () => {
  it('签发后能读回主题', () => {
    const token = signToken(SECRET, 'user-a', 1)
    expect(readToken(SECRET, token)).toMatchObject({ sub: 'user-a' })
    expect(readToken(SECRET, token)?.exp).toBeGreaterThan(Date.now() / 1000)
  })

  it('换密钥读取失败', () => {
    const token = signToken(SECRET, 'user-a', 1)
    expect(readToken('another-secret', token)).toBeUndefined()
  })

  it('篡改负载读取失败', () => {
    const token = signToken(SECRET, 'user-a', 1)
    const [header, , sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'user-b', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')
    expect(readToken(SECRET, `${header}.${forged}.${sig}`)).toBeUndefined()
  })

  it('过期令牌读取失败', () => {
    const expired = signToken(SECRET, 'user-a', -1)
    expect(readToken(SECRET, expired)).toBeUndefined()
  })

  it('结构不全的令牌读取失败', () => {
    expect(readToken(SECRET, 'a.b')).toBeUndefined()
    expect(readToken(SECRET, '..')).toBeUndefined()
    expect(readToken(SECRET, '')).toBeUndefined()
  })

  it('签名长度不同的令牌不会崩溃', () => {
    const token = signToken(SECRET, 'user-a', 1)
    const [header, body] = token.split('.')
    expect(readToken(SECRET, `${header}.${body}.short`)).toBeUndefined()
  })
})
