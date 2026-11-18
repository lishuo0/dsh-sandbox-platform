/**
 * 平台配置页的视图清单。
 *
 * 左侧菜单、左下角账号菜单的「管理」子菜单、视图白名单和「仅管理员可见」的
 * 判定都以这里为准；`console.ts` 把这份数据注入浏览器端脚本（`__CONSOLE_VIEWS__`），
 * 服务端和测试不再各维护一份名字。
 */

export type ConsoleViewId = 'skills' | 'mcp' | 'users' | 'sandboxes'

/** 入口位置：侧栏一级菜单，还是左下角头像菜单里的「管理」子菜单。 */
export type ConsoleMenu = 'sidebar' | 'account'

export interface ConsoleView {
  readonly view: ConsoleViewId
  readonly label: string
  readonly icon: 'skills' | 'mcp' | 'users' | 'sandbox'
  readonly menu: ConsoleMenu
  /** 只有管理员能在菜单里看到并用它打开。 */
  readonly adminOnly?: boolean
}

export const CONSOLE_VIEWS: readonly ConsoleView[] = [
  { view: 'skills', label: 'Skills', icon: 'skills', menu: 'sidebar' },
  { view: 'mcp', label: 'MCP', icon: 'mcp', menu: 'sidebar' },
  { view: 'users', label: '用户', icon: 'users', menu: 'account', adminOnly: true },
  { view: 'sandboxes', label: '沙箱', icon: 'sandbox', menu: 'account', adminOnly: true },
]

export function visibleConsoleViews(role: 'admin' | 'member'): ConsoleView[] {
  return CONSOLE_VIEWS.filter((entry) => entry.adminOnly !== true || role === 'admin')
}

/** 侧栏一级菜单只放 Skills / MCP；管理员视图收在头像菜单的「管理」里。 */
export function sidebarConsoleViews(role: 'admin' | 'member'): ConsoleView[] {
  return visibleConsoleViews(role).filter((entry) => entry.menu === 'sidebar')
}

/** 左下角头像弹出菜单里「管理」子菜单的入口。 */
export function accountConsoleViews(role: 'admin' | 'member'): ConsoleView[] {
  return visibleConsoleViews(role).filter((entry) => entry.menu === 'account')
}

/** 未知视图或没权限的视图一律退回 Skills，避免拼错的名字打开空白页。 */
export function resolveConsoleView(role: 'admin' | 'member', raw: unknown): ConsoleViewId {
  const known = visibleConsoleViews(role)
  const match = known.find((entry) => entry.view === raw)
  return match?.view ?? 'skills'
}
