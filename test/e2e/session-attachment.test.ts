import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signToken } from '../../src/kernel/tokens.js'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 会话文件上传 + 图片附件：字节落在工作区的工作卷前缀里，
 * 预览地址是平台签发给上传者本人的只读链接（签名带成员 id），
 * 附件读取仍要校验会话归属。
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let stack: JointStack
let sessionId: string
let otherToken: string
let otherSessionId: string

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token)
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '附件工作区' },
  })
  const session = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId: workspace.body.data.id, title: '附件会话' },
  })
  sessionId = session.body.data.id

  await stack.db.query(`INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('other', 'other', 'x')`)
  await stack.db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES ('w_other', 'other', '别人的工作区', '/tmp/w_other', '/desk')`,
  )
  await stack.db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES ('s_other', 'other', 'w_other', '别人的会话')`,
  )
  otherSessionId = 's_other'
  otherToken = signToken(stack.platform.config.auth.tokenSecret, 'other', 24)
})

afterAll(async () => {
  await stack.close()
})

async function upload(name: string, bytes: Buffer, type = 'image/png') {
  return api<{ path: string; sandboxPath: string; url: string; bytes: number }>(
    stack.baseUrl,
    `/sessions/${sessionId}/files?name=${encodeURIComponent(name)}`,
    { method: 'POST', token: stack.token, raw: bytes, headers: { 'content-type': type } },
  )
}

describe('会话文件上传与图片预览', () => {
  it('上传后可以用返回的签名地址原样读回', async () => {
    const saved = await upload('图 1.png', PNG)
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({
      path: `uploads/${sessionId}/图 1.png`,
      sandboxPath: `/desk/uploads/${sessionId}/图 1.png`,
      bytes: PNG.byteLength,
    })

    const response = await fetch(`${stack.baseUrl}${saved.body.data.url}`, {
      headers: { authorization: `Bearer ${stack.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('签名被改过就取不到字节', async () => {
    const saved = await upload('tamper.png', PNG)
    const url = new URL(saved.body.data.url, stack.baseUrl)
    url.searchParams.set('sig', '0'.repeat(64))
    const response = await fetch(url, { headers: { authorization: `Bearer ${stack.token}` } })
    expect(response.status).toBe(404)
  })

  it('签名地址绑定上传者本人，别人拿着也读不到，未登录也读不到', async () => {
    const saved = await upload('只有我能看.png', PNG)
    const foreign = await fetch(`${stack.baseUrl}${saved.body.data.url}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(foreign.status).toBe(404)
    const anonymous = await fetch(`${stack.baseUrl}${saved.body.data.url}`)
    expect(anonymous.status).toBe(401)
  })

  it('ws: 附件按工作卷路径返回 base64 和文件信息', async () => {
    await upload('预览.png', PNG)
    const attachmentId = `ws:${Buffer.from(`/desk/uploads/${sessionId}/预览.png`).toString('base64url')}`
    const response = await api<{ attachment: Record<string, unknown>; data: string }>(
      stack.baseUrl,
      `/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}`,
      { token: stack.token },
    )
    expect(response.status).toBe(200)
    expect(response.body.data.attachment).toEqual({
      attachmentId,
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      name: '预览.png',
    })
    expect(Buffer.from(response.body.data.data, 'base64')).toEqual(PNG)
  })

  it('非图片附件不能当预览给出去', async () => {
    await upload('说明.txt', Buffer.from('纯文本'), 'text/plain')
    const attachmentId = `ws:${Buffer.from(`/desk/uploads/${sessionId}/说明.txt`).toString('base64url')}`
    const response = await api(stack.baseUrl, `/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}`, {
      token: stack.token,
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('not-an-image')
  })

  it('别的成员既传不了也读不了', async () => {
    const saved = await upload('别人的.png', PNG)
    const foreignUpload = await api(stack.baseUrl, `/sessions/${sessionId}/files?name=x.png`, {
      method: 'POST',
      token: otherToken,
      raw: PNG,
      headers: { 'content-type': 'image/png' },
    })
    expect(foreignUpload.status).toBe(404)

    const attachmentId = `ws:${Buffer.from(`/desk/uploads/${sessionId}/别人的.png`).toString('base64url')}`
    const foreignRead = await api(
      stack.baseUrl,
      `/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}`,
      { token: otherToken },
    )
    expect(foreignRead.status).toBe(404)
    expect(saved.status).toBe(200)
  })

  it('自己的会话才是上传目标', async () => {
    const wrongSession = await api(stack.baseUrl, `/sessions/${otherSessionId}/files?name=x.png`, {
      method: 'POST',
      token: stack.token,
      raw: PNG,
      headers: { 'content-type': 'image/png' },
    })
    expect(wrongSession.status).toBe(404)
  })
})
