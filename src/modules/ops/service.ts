import type { Querier } from '../../kernel/db.js'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

export interface AdminSandboxView {
  sandbox_id: string
  user_id: string
  user_display_name: string
  workspace_id: string
  workspace_name: string
  session_id: string
  scope: string
  platform: string
  state: string
  endpoint: string
  unknown: boolean
  last_used_at: string
  expires_at: string
}

export interface AdminSandboxPage {
  items: AdminSandboxView[]
  total: number
  page: number
  page_size: number
}

/** 管理员排障面：只读共享库里的沙箱注册表，不碰会话内容。 */
export async function listSandboxes(
  db: Querier,
  options: { page?: number; pageSize?: number } = {},
): Promise<AdminSandboxPage> {
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1)
  const requested = Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE
  const pageSize = requested < 1 ? DEFAULT_PAGE_SIZE : Math.min(requested, MAX_PAGE_SIZE)
  try {
    const total = await db.query<{ total: unknown }>(`SELECT count(*) AS total FROM dsh_sandboxes`)
    const rows = await db.query(
      `SELECT s.sandbox_id, s.user_id, COALESCE(u.display_name, '') AS user_display_name,
              s.workspace_id, COALESCE(w.name, '') AS workspace_name, s.session_id,
              s.scope, s.platform, s.state, s.endpoint, s.last_used_at, s.expires_at
         FROM dsh_sandboxes s
         LEFT JOIN dsh_users u ON u.id = s.user_id
         LEFT JOIN dsh_workspaces w ON w.id = s.workspace_id
        ORDER BY s.last_used_at DESC, s.sandbox_id
        LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    )
    return {
      items: rows.rows.map((row) => ({
        sandbox_id: String(row.sandbox_id ?? ''),
        user_id: String(row.user_id ?? ''),
        user_display_name: String(row.user_display_name ?? ''),
        workspace_id: String(row.workspace_id ?? ''),
        workspace_name: String(row.workspace_name ?? ''),
        session_id: String(row.session_id ?? ''),
        scope: String(row.scope ?? ''),
        platform: String(row.platform ?? ''),
        state: String(row.state ?? ''),
        endpoint: String(row.endpoint ?? ''),
        // 平台不直连 E2B；实时状态由脑维护，这里只显示库里最后一次已知状态。
        unknown: true,
        last_used_at: iso(row.last_used_at),
        expires_at: iso(row.expires_at),
      })),
      total: Number(total.rows[0]?.total ?? 0),
      page,
      page_size: pageSize,
    }
  } catch (error) {
    // 脑还没建表（新部署或只跑平台）时按空列表处理。
    if (!isMissingTable(error)) throw error
    return { items: [], total: 0, page, page_size: pageSize }
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : ''
}

function isMissingTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const shaped = error as { code?: unknown; message?: unknown }
  return shaped.code === '42P01' || (typeof shaped.message === 'string' && shaped.message.includes('no such table'))
}
