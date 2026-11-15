import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = stored.split('$')
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false
  const hash = scryptSync(password, Buffer.from(saltB64, 'base64'), 32)
  const expected = Buffer.from(hashB64, 'base64')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}
