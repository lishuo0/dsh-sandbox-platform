import type { Deps } from '../../app/deps.js'
import type { Route } from '../../kernel/http.js'
import { signToken } from '../../kernel/tokens.js'
import { authenticate, createMember, ensureAdmin, listMembers, setMemberRole, updateMember, type MemberPatch } from './service.js'

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
          data: { userId: ctx.actor!.id, displayName: ctx.actor!.displayName, role: ctx.actor!.role },
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
        const member = await createMember(deps.db, {
          username: body.username ?? '',
          displayName: body.displayName,
          password: body.password ?? '',
          role: body.role === 'admin' ? 'admin' : 'member',
        })
        ctx.send(201, { code: 0, msg: 'ok', data: member })
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
