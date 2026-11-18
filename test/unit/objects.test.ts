import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createObjectStore, ObjectExistsError } from '../../src/kernel/objects.js'
import type { AppConfig } from '../../src/config.js'

const dirs: string[] = []

function localConfig(dir: string): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir },
  } as unknown as AppConfig
}

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-objects-unit-'))
  dirs.push(dir)
  return { dir, objects: createObjectStore(localConfig(dir)) }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('LocalStore', () => {
  it('没配 OSS 时启用本地目录', async () => {
    const { objects } = await store()
    expect(objects.enabled()).toBe(true)
  })

  it('写入后能读回', async () => {
    const { objects } = await store()
    await objects.put('desks/w1/README.md', Buffer.from('# hello'))
    expect((await objects.get('desks/w1/README.md'))?.toString()).toBe('# hello')
  })

  it('键前面的斜杠被忽略', async () => {
    const { dir, objects } = await store()
    await objects.put('/common/skills/a/SKILL.md', Buffer.from('x'))
    expect(await readdir(join(dir, 'common', 'skills', 'a'))).toEqual(['SKILL.md'])
    expect((await objects.get('common/skills/a/SKILL.md'))?.toString()).toBe('x')
  })

  it('原子新增不覆盖已有对象', async () => {
    const { objects } = await store()
    await objects.put('desks/w1/a.txt', Buffer.from('one'))
    await expect(
      objects.put('desks/w1/a.txt', Buffer.from('two'), undefined, { ifAbsent: true }),
    ).rejects.toBeInstanceOf(ObjectExistsError)
    expect((await objects.get('desks/w1/a.txt'))?.toString()).toBe('one')
    await objects.put('desks/w1/b.txt', Buffer.from('two'), undefined, { ifAbsent: true })
    expect((await objects.get('desks/w1/b.txt'))?.toString()).toBe('two')
  })

  it('读取不存在的键返回 undefined', async () => {
    const { objects } = await store()
    expect(await objects.get('no/such/key')).toBeUndefined()
  })

  it('列举一级文件和目录', async () => {
    const { objects } = await store()
    await objects.put('desks/w1/a.txt', Buffer.from('12345'))
    await objects.put('desks/w1/sub/b.txt', Buffer.from('b'))
    const page = await objects.list('desks/w1')
    expect(page.directories).toContain('desks/w1/sub/')
    expect(page.files).toContainEqual({ key: 'desks/w1/a.txt', size: 5 })
    expect(page.truncated).toBe(false)
  })

  it('列举不存在的目录返回空页', async () => {
    const { objects } = await store()
    expect(await objects.list('nothing/here')).toEqual({ files: [], directories: [], truncated: false })
  })

  it('键越出本地目录时拒绝', async () => {
    const { objects } = await store()
    await expect(objects.put('../../escape.txt', Buffer.from('x'))).rejects.toThrow('对象键越出本地目录')
    await expect(objects.get('../../escape.txt')).rejects.toThrow('对象键越出本地目录')
    await expect(objects.list('..')).rejects.toThrow('对象键越出本地目录')
  })

  it('没有对象目录时构造失败', () => {
    expect(() => createObjectStore(localConfig(''))).toThrow('本地对象目录还没定')
  })
})
