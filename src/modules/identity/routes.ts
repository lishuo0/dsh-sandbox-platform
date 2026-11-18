import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { signToken } from '../../kernel/tokens.js'
import {
  authenticate,
  changeOwnPassword,
  createMemberAccount,
  ensureAdmin,
  listMembers,
  resetMemberPassword,
  setMemberRole,
  updateMember,
  type MemberPatch,
} from './service.js'

export function identityRoutes(deps: Deps): Route[] {
  return [
    { method: 'GET', path: '/health', auth: 'public', handle: async (ctx) => ctx.send(200, { ok: true }) },
    {
      method: 'POST',
      path: '/auth/login',
      auth: 'public',
      handle: async (ctx) => {
        const body = await ctx.json<{ username?: string; password?: string }>()
        const member = await authenticate(deps.db, body.username ?? '', body.password ?? '')
        if (!member) {
          ctx.send(401, { code: 1, msg: 'unauthorized', data: null })
          return
        }
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: {
            userId: member.id,
            displayName: member.displayName,
            role: member.role,
            mustChangePassword: member.mustChangePassword,
            accessToken: signToken(deps.config.auth.tokenSecret, member.id, deps.config.auth.tokenTtlHours),
            tokenType: 'bearer',
          },
        })
      },
    },
    {
      method: 'GET',
      path: '/auth/me',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: {
            userId: ctx.actor!.id,
            displayName: ctx.actor!.displayName,
            role: ctx.actor!.role,
            mustChangePassword: ctx.actor!.mustChangePassword === true,
          },
        })
      },
    },
    {
      method: 'GET',
      path: '/me',
      auth: 'member',
      handle: async (ctx) => {
        ctx.send(200, { code: 0, msg: 'ok', data: { user_id: ctx.actor!.id, display_name: ctx.actor!.displayName } })
      },
    },
    {
      method: 'GET',
      path: '/admin/users',
      auth: 'admin',
      handle: async (ctx) => ctx.send(200, { code: 0, msg: 'ok', data: await listMembers(deps.db) }),
    },
    {
      method: 'POST',
      path: '/admin/users',
      auth: 'admin',
      handle: async (ctx) => {
        const body = await ctx.json<{ username?: string; displayName?: string; password?: string; role?: string }>()
        const created = await createMemberAccount(deps.db, {
          username: body.username ?? '',
          displayName: body.displayName,
          password: body.password,
          role: body.role === 'admin' ? 'admin' : 'member',
        })
        // initialPassword 只在服务端生成时出现一次；客户端必须提示管理员抄走。
        ctx.send(201, { code: 0, msg: 'ok', data: created })
      },
    },
    {
      method: 'POST',
      path: '/admin/users/:id/password',
      auth: 'admin',
      handle: async (ctx) => {
        const body = await ctx.json<{ password?: string }>().catch(() => ({ password: undefined }))
        ctx.send(200, {
          code: 0,
          msg: 'ok',
          data: await resetMemberPassword(deps.db, ctx.params.id, body.password),
        })
      },
    },
    {
      method: 'PATCH',
      path: '/me/password',
      auth: 'member',
      handle: async (ctx) => {
        const body = await ctx.json<{ currentPassword?: string; newPassword?: string }>()
        await changeOwnPassword(deps.db, ctx.actor!.id, body.currentPassword ?? '', body.newPassword ?? '')
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
    {
      method: 'PATCH',
      path: '/admin/users/:id/role',
      auth: 'admin',
      handle: async (ctx) => {
        const body = await ctx.json<{ role?: unknown }>()
        const updated = await setMemberRole(deps.db, ctx.actor!.id, ctx.params.id, body.role)
        ctx.send(200, { code: 0, msg: 'ok', data: updated })
      },
    },
    {
      method: 'PATCH',
      path: '/admin/users/:id',
      auth: 'admin',
      handle: async (ctx) => {
        const body = await ctx.json<MemberPatch & { role?: string; status?: string }>()
        if (body.role && body.role !== 'admin' && body.role !== 'member') {
          ctx.send(422, { code: 1, msg: 'invalid-role', data: null })
          return
        }
        if (body.status && body.status !== 'active' && body.status !== 'disabled') {
          ctx.send(422, { code: 1, msg: 'invalid-status', data: null })
          return
        }
        // 不能顺手把自己停掉：和「不能降级自己」一样，避免把管理入口锁死。
        if (ctx.params.id === ctx.actor!.id && body.status === 'disabled') {
          ctx.send(422, { code: 1, msg: 'cannot-disable-self', data: null })
          return
        }
        await updateMember(deps.db, ctx.params.id, {
          displayName: body.displayName,
          role: body.role as MemberPatch['role'],
          status: body.status as MemberPatch['status'],
          password: body.password,
        })
        ctx.send(200, { code: 0, msg: 'ok', data: null })
      },
    },
  ]
}

export async function bootstrapAdmin(deps: Deps): Promise<void> {
  await ensureAdmin(deps.db, deps.config.auth.adminUsername, deps.config.auth.adminPassword)
}
