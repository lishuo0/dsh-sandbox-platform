import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { interceptWorkspace } from '../../src/client/workspaces.js'
import { startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 工作区变更 → 脑重新投影的联合链路。
 *
 * 平台是租户判定的唯一位置：`P/remote/workspace/*` 的创建/改名/删除/归档由平台
 * 落库，随后必须通过真实的 `BrainClient` 打真实 HTTP 到脑路由
 * `/brain/v1/workspaces/sync`，由脑的 `workspaceRegistry.refresh()` 重新投影。
 *
 * 这里给脑装了一个计数的 registry：每一次平台写操作都应该让计数恰好 +1，
 * 这样既验证了「真的通知到了脑」，也验证了不会漏发或重复发。
 */

let stack: JointStack
let refreshes = 0
const OWNED_SESSION = 's_0123456789abcdef0123456789abcdef'

interface Envelope {
  result: {
    ok: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }
}

beforeAll(async () => {
  refreshes = 0
  stack = await startJointStack({
    brainServices: {
      workspaceRegistry: {
        async refresh() {
          refreshes += 1
        },
      },
    },
  })
  // 归档动作只认成员名下的会话；工作区归属不是它的关注点。
  await stack.db.query(
    `INSERT INTO dsh_sessions (id, user_id, title, preset_id) VALUES ($1, $2, '', 'client')`,
    [OWNED_SESSION, stack.userId],
  )
})

afterAll(async () => {
  await stack.close()
})

async function rpc(path: string, request: unknown): Promise<Envelope> {
  const text = await interceptWorkspace(
    path,
    { type: 'client-request', rpcId: 'rpc-sync', payload: { args: { request } } },
    {
      db: stack.platform.deps.db,
      objects: stack.platform.deps.objects,
      brain: stack.platform.deps.brain,
      userId: stack.userId,
    },
  )
  if (text === undefined) throw new Error(`${path} 没有被平台收口`)
  return JSON.parse(text) as Envelope
}

describe('工作区变更通知脑重新投影', () => {
  it('创建：平台落库后脑计数 +1', async () => {
    const before = refreshes
    const envelope = await rpc('workspace/create', { title: '同步工作区' })
    expect(envelope.result.ok).toBe(true)
    const workspace = (envelope.result.value as { workspace: { workspaceId: string; title: string } }).workspace
    expect(workspace.title).toBe('同步工作区')
    expect(refreshes).toBe(before + 1)

    const rows = await stack.db.query<{ user_id: string }>(
      `SELECT user_id FROM dsh_workspaces WHERE id = $1`,
      [workspace.workspaceId],
    )
    expect(rows.rows[0]?.user_id).toBe(stack.userId)
  })

  it('改名：写库成功才通知，脑再取到的是新标题', async () => {
    const created = await rpc('workspace/create', { title: '旧标题' })
    const workspaceId = (created.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId

    const before = refreshes
    const renamed = await rpc('workspace/rename', { workspaceId, title: '新标题' })
    expect(renamed.result.ok).toBe(true)
    expect((renamed.result.value as { workspace: { title: string } }).workspace.title).toBe('新标题')
    expect(refreshes).toBe(before + 1)
  })

  it('改名冲突：不写库也不通知脑', async () => {
    const first = await rpc('workspace/create', { title: '甲' })
    const second = await rpc('workspace/create', { title: '乙' })
    const firstId = (first.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId
    const secondId = (second.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId

    const before = refreshes
    const conflict = await rpc('workspace/rename', { workspaceId: secondId, title: '甲' })
    expect(conflict.result.ok).toBe(false)
    expect(conflict.result.error?.code).toBe('workspace/name-conflict')
    expect(refreshes).toBe(before)

    // 另一块仍是原名。
    const rows = await stack.db.query<{ name: string }>(`SELECT name FROM dsh_workspaces WHERE id = $1`, [secondId])
    expect(rows.rows[0]?.name).toBe('乙')
    expect(firstId).not.toBe(secondId)
  })

  it('归档：只认自己的会话，归档位落库并通知脑', async () => {
    const before = refreshes
    const archived = await rpc('workspace/archiveSession', { sessionId: OWNED_SESSION })
    expect(archived.result.ok).toBe(true)
    expect((archived.result.value as { archivedSessionIds: string[] }).archivedSessionIds).toContain(OWNED_SESSION)
    expect(refreshes).toBe(before + 1)

    const rows = await stack.db.query<{ status: string }>(`SELECT status FROM dsh_sessions WHERE id = $1`, [
      OWNED_SESSION,
    ])
    expect(rows.rows[0]?.status).toBe('archived')
  })

  it('别人的会话：拒绝且不通知脑', async () => {
    const before = refreshes
    const foreign = await rpc('workspace/archiveSession', { sessionId: 's_ffffffffffffffffffffffffffffffff' })
    expect(foreign.result.ok).toBe(false)
    expect(foreign.result.error?.code).toBe('session/not-found')
    expect(refreshes).toBe(before)
  })

  it('删除：清库后通知脑；重复删除是 no-op 也不通知', async () => {
    const created = await rpc('workspace/create', { title: '待删除' })
    const workspaceId = (created.result.value as { workspace: { workspaceId: string } }).workspace.workspaceId

    const before = refreshes
    const removed = await rpc('workspace/delete', { workspaceId })
    expect(removed.result.value).toEqual({ deleted: true })
    expect(refreshes).toBe(before + 1)

    const gone = await stack.db.query(`SELECT id FROM dsh_workspaces WHERE id = $1`, [workspaceId])
    expect(gone.rows).toHaveLength(0)

    const again = await rpc('workspace/delete', { workspaceId })
    expect(again.result.ok).toBe(false)
    expect(again.result.error?.code).toBe('workspace/not-found')
    expect(refreshes).toBe(before + 1)
  })

  it('脑路由本身要求应用凭据，避免任何本地调用都能触发重投影', async () => {
    const response = await fetch(`${stack.brain.baseUrl}/brain/v1/workspaces/sync`, { method: 'POST' })
    expect(response.status).toBe(401)
  })
})
