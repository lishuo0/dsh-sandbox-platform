import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

/**
 * 「+ → 反馈」/ `/feedback` 写到脑的事件，经平台出口读回来。
 * 事件只读；归属按会话成员判定，管理员汇总全部。
 */

interface FeedbackEntry {
  sessionId: string
  seq: number
  at: string
  text: string
  category: string
  sessionTitle: string
  userId: string
  displayName: string
  workspaceId: string
}

let platform: TestPlatform
let adminToken = ''
let memberToken = ''

function event(seq: number, text: string, category: string, time: number): string {
  return JSON.stringify({ type: 'feedback/record', seq, time, data: { text, category } })
}

beforeAll(async () => {
  platform = await startTestPlatform()
  adminToken = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
  await api(platform.baseUrl, '/admin/users', {
    method: 'POST',
    token: adminToken,
    body: { username: 'member', password: 'member-password-1234' },
  })
  memberToken = await login(platform.baseUrl, 'member', 'member-password-1234')

  const events = platform.db.dialect === 'sqlite' ? 'text' : 'jsonb'
  await platform.db.exec(`CREATE TABLE IF NOT EXISTS dsh_session_events (
    session_id text NOT NULL,
    seq integer NOT NULL,
    event ${events} NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`)
  await platform.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES
       ('w_admin', $1, '管理员工作区', '/tmp/w_admin', '/desk'),
       ('w_member', 'member', '成员工作区', '/tmp/w_member', '/desk')`,
    [platform.config.auth.adminUsername],
  )
  await platform.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES
       ('s_admin', $1, 'w_admin', '管理员会话'),
       ('s_member', 'member', 'w_member', '成员会话')`,
    [platform.config.auth.adminUsername],
  )
  await platform.db.query(
    `INSERT INTO dsh_session_events (session_id, seq, event) VALUES
       ('s_admin', 1, $1),
       ('s_admin', 2, $2),
       ('s_member', 1, $3)`,
    [
      event(1, '管理员的反馈', 'other', 1_794_900_000_000),
      JSON.stringify({ type: 'user/message', seq: 2, time: 1, data: { text: '不是反馈' } }),
      event(1, '成员的反馈', 'product-interaction', 1_794_900_000_100),
    ],
  )
})

afterAll(async () => {
  await platform.close()
})

async function list(token: string, query = ''): Promise<FeedbackEntry[]> {
  const response = await api<FeedbackEntry[]>(platform.baseUrl, `/feedback${query}`, { token })
  expect(response.status).toBe(200)
  return response.body.data
}

describe('反馈出口', () => {
  it('成员只读到自己会话的反馈，并带会话标题与成员信息', async () => {
    const entries = await list(memberToken)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: 's_member',
      seq: 1,
      text: '成员的反馈',
      category: 'product-interaction',
      sessionTitle: '成员会话',
      userId: 'member',
      workspaceId: 'w_member',
    })
    expect(entries[0]?.displayName).toBe('member')
    expect(entries[0]?.at).toBe(new Date(1_794_900_000_100).toISOString())
  })

  it('管理员汇总全部成员，按时间从新到旧', async () => {
    const entries = await list(adminToken)
    expect(entries.map((entry) => entry.text)).toEqual(['成员的反馈', '管理员的反馈'])
  })

  it('按会话过滤；成员过滤别人的会话读不到', async () => {
    expect(await list(adminToken, '?sessionId=s_admin')).toHaveLength(1)
    expect(await list(memberToken, '?sessionId=s_admin')).toEqual([])
  })

  it('limit 非法或越界时回到默认值，不报错', async () => {
    const response = await api<FeedbackEntry[]>(platform.baseUrl, '/feedback?limit=-3', { token: adminToken })
    expect(response.status).toBe(200)
    expect(response.body.data).toHaveLength(2)
  })

  it('未登录 401', async () => {
    const response = await api(platform.baseUrl, '/feedback')
    expect(response.status).toBe(401)
  })
})
