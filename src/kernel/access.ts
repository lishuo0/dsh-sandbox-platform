/**
 * 平台对外 API 的前缀与「临时口令」白名单。
 *
 * 前缀放在这个不依赖任何模块的小文件里：`http` 和 `client/surface` 都要用它，
 * 直接从 `http.ts` 取会形成 `http ↔ surface` 的循环导入。
 */

export const API_PREFIX = '/dsh-api/platform/v1'

/**
 * 无需登录的公开 API（相对 `API_PREFIX` 的路径）。
 *
 * 客户端 surface 会先拦一层 `/dsh-api/`；这里必须放行，否则 `health` /
 * `auth/login` 到不了路由表，未带 cookie 时一律变成明文 401。
 */
export const PUBLIC_API_PATHS = ['/health', '/auth/login'] as const

/**
 * 管理员开户 / 重置密码后的临时口令只能用来换密码。
 *
 * 这几条路由必须放行，否则成员连改密码都发不出去；其余成员和管理员接口一旦
 * 被标了强制改密就统一回 403，不靠浏览器自觉。
 */
export const MUST_CHANGE_ALLOWED = ['/auth/me', '/me', '/me/password'] as const
