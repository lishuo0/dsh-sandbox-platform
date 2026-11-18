import { createHmac, timingSafeEqual } from 'node:crypto'

export interface TokenClaims {
  sub: string
  exp: number
}

export function signToken(secret: string, subject: string, ttlHours: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + ttlHours * 3600 }))
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

export function readToken(secret: string, token: string): TokenClaims | undefined {
  const [header, body, sig] = token.split('.')
  if (!header || !body || !sig) return undefined
  const expected = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  const left = Buffer.from(sig)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined
  let data: Partial<TokenClaims>
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<TokenClaims>
  } catch {
    return undefined
  }
  if (typeof data.sub !== 'string' || !data.sub) return undefined
  if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return undefined
  return { sub: data.sub, exp: data.exp }
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
