/**
 * 行取值的方言归一。
 *
 * PostgreSQL 直接返回对象、布尔、Buffer；SQLite 把 JSON 存成文本、
 * 布尔存成 0/1、字节存成 Uint8Array。这里让服务层拿到的形状一致，
 * PostgreSQL 的值原样通过。
 */

export function asJson<T = Record<string, unknown>>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't'
}

export function asNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return Number(value)
}

export function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(value as Uint8Array)
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  }
  return []
}
