import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM，布局是 nonce(12) + 密文 + tag(16)。
 * 脑读取 MCP 请求头时按同一布局解开，两边必须一致。
 */
export function seal(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export function open(key: Buffer, blob: Buffer): string {
  if (blob.length < 12 + 16) throw new Error('密文太短')
  const nonce = blob.subarray(0, 12)
  const tag = blob.subarray(blob.length - 16)
  const body = blob.subarray(12, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}…${value.slice(-2)}`
}
