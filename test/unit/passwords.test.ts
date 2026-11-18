import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/kernel/passwords.js'

describe('passwords', () => {
  it('哈希后能校验原密码', () => {
    const stored = hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('错误密码校验失败', () => {
    const stored = hashPassword('admin-password-123')
    expect(verifyPassword('admin-password-124', stored)).toBe(false)
  })

  it('同一密码两次哈希盐不同', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'))
  })

  it('格式非法的存储值校验失败', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'plain$x$y')).toBe(false)
    expect(verifyPassword('x', 'scrypt$onlysalt')).toBe(false)
  })
})
