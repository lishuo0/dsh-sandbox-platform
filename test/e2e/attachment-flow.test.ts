import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 平台附件全流程：上传落到对象存储 → 发消息时把附件引用拼成 note → 交给脑。
 *
 * 附件字节走共享对象存储（测试里是本地目录），平台只保管 `dsh_attachments`
 * 这行元数据；脑不认识用户，所以「这份附件属于谁」必须在平台发消息前核对，
 * 不能把别人的附件 id 拼进 prompt。
 */

let stack: JointStack
let workspaceId = ''

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token)
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '附件工作区' },
  })
  workspaceId = workspace.body.data.id
})

afterAll(async () => {
  await stack.close()
})

async function upload(name: string, content: string, type = 'text/plain'): Promise<{
  status: number
  attachmentId: string
  bytes: number
}> {
  const response = await api<{ attachmentId: string; name: string; mediaType: string; bytes: number }>(
    stack.baseUrl,
    `/attachments?name=${encodeURIComponent(name)}`,
    { method: 'POST', token: stack.token, raw: Buffer.from(content), headers: { 'content-type': type } },
  )
  return {
    status: response.status,
    attachmentId: response.body.data?.attachmentId ?? '',
    bytes: response.body.data?.bytes ?? 0,
  }
}

async function openSession(): Promise<string> {
  const created = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId, title: '附件会话' },
  })
  expect(created.status).toBe(201)
  return created.body.data.id
}

describe('附件上传与内容寻址', () => {
  it('上传落在对象存储，元数据带摘要 id 与字节数', async () => {
    const saved = await upload('../../notes.txt', 'hello 附件')
    expect(saved.status).toBe(201)
    expect(saved.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(saved.bytes).toBe(Buffer.byteLength('hello 附件'))

    const rows = await stack.db.query<{ name: string; media_type: string; bytes: unknown }>(
      `SELECT name, media_type, bytes FROM dsh_attachments WHERE id = $1`,
      [saved.attachmentId],
    )
    // 名字只留最后一段，避免把客户端路径写进展示。
    expect(rows.rows[0]).toMatchObject({ name: 'notes.txt', media_type: 'text/plain' })
  })

  it('同一内容重复上传共享一行元数据', async () => {
    const first = await upload('same-a.txt', 'same bytes')
    const second = await upload('same-b.txt', 'same bytes')
    expect(second.attachmentId).toBe(first.attachmentId)

    const rows = await stack.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dsh_attachments WHERE id = $1 AND user_id = $2`,
      [first.attachmentId, stack.userId],
    )
    expect(Number(rows.rows[0]?.n)).toBe(1)
  })

  it('空文件与缺名字被拒', async () => {
    const empty = await upload('empty.txt', '')
    expect(empty.status).toBe(422)

    const missing = await api(stack.baseUrl, '/attachments', {
      method: 'POST',
      token: stack.token,
      raw: Buffer.from('x'),
    })
    expect(missing.status).toBe(422)
    expect(missing.body.msg).toBe('invalid-name')
  })

  it('列表按成员隔离', async () => {
    const saved = await upload('mine.txt', 'mine')
    const list = await api<Array<{ id: string }>>(stack.baseUrl, '/attachments', { token: stack.token })
    expect(list.body.data.map((item) => item.id)).toContain(saved.attachmentId)
  })
})

describe('附件随消息进入脑', () => {
  it('文本 + 附件拼成 note 后原样交给脑', async () => {
    const saved = await upload('report.md', '# 报告')
    const sessionId = await openSession()

    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { text: '看下附件', requestId: 'req-attach-1', attachmentIds: [saved.attachmentId] },
    })
    expect(sent.status).toBe(202)

    expect(stack.gateway.prompts.at(-1)).toMatchObject({
      sessionId,
      requestId: 'req-attach-1',
      text: `看下附件\n\n[attachments]\n- report.md ${saved.attachmentId}`,
    })
  })

  it('只发附件、不带文本也可投递', async () => {
    const saved = await upload('only.bin', 'bytes', 'application/octet-stream')
    const sessionId = await openSession()

    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { attachmentIds: [saved.attachmentId] },
    })
    expect(sent.status).toBe(202)
    expect(stack.gateway.prompts.at(-1)?.text).toBe(`\n\n[attachments]\n- only.bin ${saved.attachmentId}`)
  })

  it('既没文本也没附件时 422', async () => {
    const sessionId = await openSession()
    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { text: '   ' },
    })
    expect(sent.status).toBe(422)
    expect(sent.body.msg).toBe('invalid-text')
  })

  it('引用不存在的附件 404，不把请求交给脑', async () => {
    const sessionId = await openSession()
    const before = stack.gateway.prompts.length
    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { text: '带个假附件', attachmentIds: [`sha256:${'0'.repeat(64)}`] },
    })
    expect(sent.status).toBe(404)
    expect(sent.body.msg).toBe('attachment-not-found')
    expect(stack.gateway.prompts.length).toBe(before)
  })

  it('别的成员的附件 id 拼不进 prompt', async () => {
    const saved = await upload('private.txt', 'private')
    await api(stack.baseUrl, '/admin/users', {
      method: 'POST',
      token: stack.token,
      body: { username: 'gina', password: 'gina-password-1234' },
    })
    const gina = await login(stack.baseUrl, 'gina', 'gina-password-1234')

    const sessionId = await openSession()
    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: gina,
      body: { text: '偷附件', attachmentIds: [saved.attachmentId] },
    })
    expect(sent.status).toBe(404)
    expect(sent.body.msg).toBe('attachment-not-found')
  })
})
