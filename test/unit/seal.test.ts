import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { maskSecret, open, seal } from '../../src/kernel/seal.js'

const KEY = randomBytes(32)

describe('seal', () => {
  it('加解密往返一致', () => {
    const blob = seal(KEY, 'https://mcp.example.com/sse?token=abc')
    expect(open(KEY, blob)).toBe('https://mcp.example.com/sse?token=abc')
  })

  it('布局是 nonce(12)+密文+tag(16)，同明文两次密文不同', () => {
    const a = seal(KEY, 'same')
    const b = seal(KEY, 'same')
    expect(a.length).toBeGreaterThanOrEqual(12 + 16)
    expect(a.equals(b)).toBe(false)
    expect(open(KEY, a)).toBe('same')
    expect(open(KEY, b)).toBe('same')
  })

  it('换密钥解密失败', () => {
    const blob = seal(KEY, 'secret')
    expect(() => open(randomBytes(32), blob)).toThrow()
  })

  it('密文被篡改时解密失败', () => {
    const blob = seal(KEY, 'secret-value')
    const broken = Buffer.from(blob)
    broken[12] = (broken[12] ?? 0) ^ 0xff
    expect(() => open(KEY, broken)).toThrow()
  })

  it('过短的密文直接拒绝', () => {
    expect(() => open(KEY, Buffer.alloc(10))).toThrow('密文太短')
  })

  it('maskSecret 只露头尾', () => {
    expect(maskSecret('sk-1234567890')).toBe('sk…90')
    expect(maskSecret('abcd')).toBe('****')
    expect(maskSecret('abcde')).toBe('ab…de')
  })
})
