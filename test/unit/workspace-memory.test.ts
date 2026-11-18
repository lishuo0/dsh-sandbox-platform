import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { personalMemoryPrefix, workspaceMemoryPrefix } from '../../src/kernel/layout.js'
import { createObjectStore, type ObjectStore } from '../../src/kernel/objects.js'
import { personalMemory, workspaceMemory, workspaceMemoryDocument } from '../../src/modules/workspaces/memory.js'
import type { Workspace } from '../../src/modules/workspaces/service.js'

/**
 * 记忆是脑写在工作卷里的 Markdown，平台只按对象前缀读，不碰宿主机目录。
 */

let dir: string
let objects: ObjectStore

const WORKSPACE: Workspace = { id: 'w1', name: '工作区', volumeName: null, state: 'active', isDefault: false }

function localConfig(storageDir: string): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir: storageDir },
  } as unknown as AppConfig
}

function put(key: string, body: string): Promise<void> {
  return objects.put(key, Buffer.from(body), 'text/markdown')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  objects = createObjectStore(localConfig(join(dir, 'objects')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('工作区记忆', () => {
  it('读 MEMORY.md 和文档索引', async () => {
    const prefix = `${workspaceMemoryPrefix('w1')}/`
    await put(`${prefix}MEMORY.md`, '# 工作区记忆\n')
    await put(
      `${prefix}documents/index.json`,
      JSON.stringify({
        documents: [
          { id: 'd1', title: '部署', description: '怎么部署', status: 'active', filename: 'deploy.md', sizeBytes: 12, updatedAt: '2026-01-01T00:00:00Z' },
          { id: 'd2', title: '旧计划', status: 'archived', filename: 'old.md' },
        ],
      }),
    )

    const view = await workspaceMemory(objects, WORKSPACE)
    expect(view.available).toBe(true)
    expect(view.memory).toMatchObject({ name: 'MEMORY.md', content: '# 工作区记忆\n' })
    expect(view.memory?.path).toBe('.dsh/memory/MEMORY.md')
    expect(view.documents).toEqual([
      expect.objectContaining({ id: 'd1', title: '部署', status: 'active', size_bytes: 12 }),
      expect.objectContaining({ id: 'd2', status: 'archived', size_bytes: 0 }),
    ])
    expect(view.documents[1]?.path).toBe('.dsh/memory/documents/archived/old.md')
  })

  it('什么都没有时标记不可用', async () => {
    const view = await workspaceMemory(objects, WORKSPACE)
    expect(view).toEqual({ workspace_id: 'w1', available: false, documents: [] })
  })

  it('索引坏了不影响 MEMORY.md', async () => {
    const prefix = `${workspaceMemoryPrefix('w1')}/`
    await put(`${prefix}MEMORY.md`, '# 还在\n')
    await put(`${prefix}documents/index.json`, '{坏掉的 json')
    const view = await workspaceMemory(objects, WORKSPACE)
    expect(view.available).toBe(true)
    expect(view.documents).toEqual([])
    expect(view.memory?.content).toBe('# 还在\n')
  })

  it('按 id 读文档内容', async () => {
    const prefix = `${workspaceMemoryPrefix('w1')}/`
    await put(
      `${prefix}documents/index.json`,
      JSON.stringify({ documents: [{ id: 'd1', title: '部署', filename: 'deploy.md' }] }),
    )
    await put(`${prefix}documents/active/deploy.md`, '# 部署步骤\n')

    const document = await workspaceMemoryDocument(objects, WORKSPACE, 'd1')
    expect(document).toMatchObject({ id: 'd1', title: '部署', content: '# 部署步骤\n' })
  })

  it('未知 id、越界文件名、缺失索引都当不存在', async () => {
    const prefix = `${workspaceMemoryPrefix('w1')}/`
    await expect(workspaceMemoryDocument(objects, WORKSPACE, 'nope')).rejects.toMatchObject({ status: 404 })

    await put(
      `${prefix}documents/index.json`,
      JSON.stringify({
        documents: [
          { id: 'escape', title: '越界', filename: '../../secret.md' },
          { id: 'slash', title: '带斜杠', filename: 'a/b.md' },
          { id: 'missing', title: '缺文件', filename: 'missing.md' },
        ],
      }),
    )
    await expect(workspaceMemoryDocument(objects, WORKSPACE, 'escape')).rejects.toMatchObject({ status: 404 })
    await expect(workspaceMemoryDocument(objects, WORKSPACE, 'slash')).rejects.toMatchObject({ status: 404 })
    await expect(workspaceMemoryDocument(objects, WORKSPACE, 'missing')).rejects.toMatchObject({ status: 404 })
  })

  it('对象存储没配置时返回 503', async () => {
    const disabled = { enabled: () => false } as unknown as ObjectStore
    await expect(workspaceMemory(disabled, WORKSPACE)).rejects.toMatchObject({ code: 'object-store-unconfigured' })
    await expect(personalMemory(disabled, 'u1')).rejects.toMatchObject({ code: 'object-store-unconfigured' })
  })
})

describe('个人记忆', () => {
  it('只读顶层 Markdown，按名字排序', async () => {
    const prefix = `${personalMemoryPrefix('u1')}/`
    await put(`${prefix}b.md`, 'b')
    await put(`${prefix}a.md`, 'a')
    await put(`${prefix}notes.txt`, '忽略')
    await put(`${prefix}sub/c.md`, '子目录不读')

    const view = await personalMemory(objects, 'u1')
    expect(view.files).toEqual([
      { name: 'a.md', content: 'a', size: 1 },
      { name: 'b.md', content: 'b', size: 1 },
    ])
  })

  it('最多返回 20 个，且别人的记忆读不到', async () => {
    const prefix = `${personalMemoryPrefix('u1')}/`
    for (let index = 0; index < 25; index += 1) {
      await put(`${prefix}${String(index).padStart(2, '0')}.md`, String(index))
    }
    await put(`${personalMemoryPrefix('u2')}/secret.md`, '别人的')

    const view = await personalMemory(objects, 'u1')
    expect(view.files).toHaveLength(20)
    expect(view.files.map((file) => file.name)).not.toContain('secret.md')
    expect(view.files[0]?.name).toBe('00.md')
  })
})
