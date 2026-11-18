import { describe, expect, it } from 'vitest'
import { HttpError, isUniqueViolation } from '../../src/kernel/errors.js'

describe('errors', () => {
  it('HttpError 携带状态与错误码', () => {
    const error = new HttpError(404, 'not-found')
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(404)
    expect(error.code).toBe('not-found')
    expect(error.message).toBe('not-found')
  })

  it('isUniqueViolation 只认 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true)
    expect(isUniqueViolation({ code: '23503' })).toBe(false)
    expect(isUniqueViolation(new Error('x'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})
