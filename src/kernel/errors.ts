/** 模块抛出这个错误，HTTP 层负责写成响应。业务规则不碰套接字。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Remote 失败信封里的 `error.details`；默认空对象。 */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

/** PostgreSQL: 23505。SQLite: errcode 2067（UNIQUE）/1555（PRIMARY KEY）。 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, errcode } = error as { code?: unknown; errcode?: unknown }
  if (code === '23505') return true
  return errcode === 2067 || errcode === 1555
}
