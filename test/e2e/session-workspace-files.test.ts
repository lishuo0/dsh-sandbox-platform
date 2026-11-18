import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 会话级文件接口：平台只判定归属，读写由脑经沙箱接缝执行。
 * 这里用一个临时目录冒充沙箱，验证平台的转发、参数白名单和错误透传。
 */

let stack: JointStack
let workspaceId: string
let sessionId: string
let sandboxRoot: string

function sandboxFiles(root: string) {
  return {
    read: (path: string) => readFile(path),
    write: async (path: string, data: Uint8Array) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    },
    list: async (path: string) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    stat: async (path: string) => {
      try {
        const info = await stat(path)
        return {
          path,
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
      } catch {
        return undefined
      }
    },
  }
}

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), 'dsh-session-files-'))
  await mkdir(join(sandboxRoot, 'desk'), { recursive: true })
  const files = sandboxFiles(sandboxRoot)
  stack = await startJointStack({
    brainServices: {
      sandboxes: {
        ensure: async () => ({ workspaceRoot: sandboxRoot }),
        client: async () => ({ files }),
      },
    },
  })
  await configureModel(stack.baseUrl, stack.token)
  const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
    method: 'POST',
    token: stack.token,
    body: { name: '文件工作区' },
  })
  workspaceId = workspace.body.data.id
  const created = await api<{ id: string }>(stack.baseUrl, '/sessions', {
    method: 'POST',
    token: stack.token,
    body: { workspaceId, title: '文件会话' },
  })
  sessionId = created.body.data.id
})

afterAll(async () => {
  await stack.close()
  await rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('会话工作区文件', () => {
  it('上传后能在列表、内容和 stat 里看到', async () => {
    const uploaded = await api<{ name: string; path: string; bytes: number }>(
      stack.baseUrl,
      `/sessions/${sessionId}/workspace-files?path=desk&name=hello.md`,
      { method: 'POST', token: stack.token, raw: Buffer.from('# 你好\n', 'utf8') },
    )
    expect(uploaded.status).toBe(200)
    expect(uploaded.body.data).toMatchObject({ name: 'hello.md', bytes: Buffer.byteLength('# 你好\n') })
    expect(uploaded.body.data.path).toContain('hello.md')
    expect(await readFile(join(sandboxRoot, 'desk', 'hello.md'), 'utf8')).toBe('# 你好\n')

    const list = await api<{ entries: Array<{ name: string; type: string }> }>(
      stack.baseUrl,
      `/sessions/${sessionId}/workspace-files?path=desk`,
      { token: stack.token },
    )
    expect(list.body.data.entries).toEqual([expect.objectContaining({ name: 'hello.md', type: 'file' })])

    const content = await api<{ text: string; bytes: number }>(
      stack.baseUrl,
      `/sessions/${sessionId}/workspace-files/content?path=desk/hello.md`,
      { token: stack.token },
    )
    expect(content.body.data.bytes).toBeGreaterThan(0)
    expect(content.body.data.text).toContain('你好')

    const info = await api<{ absolutePath: string; bytes: number }>(
      stack.baseUrl,
      `/sessions/${sessionId}/workspace-files/stat?path=desk/hello.md`,
      { token: stack.token },
    )
    expect(info.body.data.bytes).toBeGreaterThan(0)
  })

  it('脑侧的 workspace-file 错误原样透传', async () => {
    const missing = await api(stack.baseUrl, `/sessions/${sessionId}/workspace-files/content?path=desk/missing.md`, {
      token: stack.token,
    })
    expect(missing.status).toBe(404)
    expect(missing.body.msg).toBe('workspace-file/not-found')
  })

  it('别人的会话 404，不会读到别人的工作区', async () => {
    const missing = await api(stack.baseUrl, '/sessions/s_missing/workspace-files', { token: stack.token })
    expect(missing.status).toBe(404)
    expect(missing.body.msg).toBe('not-found')
  })
})
