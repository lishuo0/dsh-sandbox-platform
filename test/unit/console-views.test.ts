import { describe, expect, it } from 'vitest'
import {
  CONSOLE_VIEWS,
  accountConsoleViews,
  resolveConsoleView,
  sidebarConsoleViews,
  visibleConsoleViews,
} from '../../src/client/console-views.js'

/**
 * 平台配置页的视图清单只有一份：侧栏菜单、头像菜单的「管理」子菜单、
 * 白名单和权限都从这里推，服务端注入给浏览器的也是同一份 JSON。
 */
describe('平台配置页视图清单', () => {
  it('成员只看 Skills / MCP，管理员多出用户和沙箱', () => {
    expect(CONSOLE_VIEWS.map((entry) => entry.view)).toEqual(['skills', 'mcp', 'users', 'sandboxes'])
    expect(visibleConsoleViews('member').map((entry) => entry.view)).toEqual(['skills', 'mcp'])
    expect(visibleConsoleViews('admin').map((entry) => entry.view)).toEqual([
      'skills',
      'mcp',
      'users',
      'sandboxes',
    ])
  })

  it('侧栏一级菜单只放 Skills / MCP，用户和沙箱收在头像菜单的「管理」里', () => {
    expect(sidebarConsoleViews('admin').map((entry) => entry.view)).toEqual(['skills', 'mcp'])
    expect(sidebarConsoleViews('member').map((entry) => entry.view)).toEqual(['skills', 'mcp'])
    expect(accountConsoleViews('admin').map((entry) => entry.view)).toEqual(['users', 'sandboxes'])
    expect(accountConsoleViews('member')).toEqual([])
    for (const entry of CONSOLE_VIEWS) {
      expect(['sidebar', 'account']).toContain(entry.menu)
    }
  })

  it('管理员专属视图都标了 adminOnly，标签和图标齐全', () => {
    for (const entry of CONSOLE_VIEWS) {
      expect(typeof entry.label).toBe('string')
      expect(entry.label.length).toBeGreaterThan(0)
      expect(['skills', 'mcp', 'users', 'sandbox']).toContain(entry.icon)
    }
    const adminOnly = CONSOLE_VIEWS.filter((entry) => entry.adminOnly === true).map((entry) => entry.view)
    expect(adminOnly).toEqual(['users', 'sandboxes'])
  })

  it('未知视图或没权限的视图一律退回 Skills', () => {
    expect(resolveConsoleView('admin', 'users')).toBe('users')
    expect(resolveConsoleView('admin', 'sandboxes')).toBe('sandboxes')
    expect(resolveConsoleView('member', 'users')).toBe('skills')
    expect(resolveConsoleView('member', 'sandboxes')).toBe('skills')
    for (const raw of [undefined, null, '', 'files', 'feedback', 42]) {
      expect(resolveConsoleView('admin', raw)).toBe('skills')
    }
  })
})
