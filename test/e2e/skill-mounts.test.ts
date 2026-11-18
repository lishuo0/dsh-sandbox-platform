import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import SandboxRegistry, { MemoryBindingStore } from '../../../dsh-sandbox-brain/packages/dsh-e2b/src/registry.ts'
import SessionDirectoryService from '../../../dsh-sandbox-brain/packages/dsh-session-directory/src/index.ts'
import { createSkillProvider, dbOf, type SkillProviderView } from '../../../dsh-sandbox-brain/test/helpers/skills.ts'
import { testContext } from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { api, login } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 公开 + 私有技能同时存在时的沙箱挂载。
 *
 * 这里不走测试自己的假挂载列表，而是像真脑一样装配 SandboxRegistry：
 * 平台对象前缀 `members/{userId}/skills` 挂到 `/skillbox/own`，
 * `common/skills` 挂到 `/skillbox/common`，两者都在沙箱里读得到。
 */

const PRIVATE_MD = '# 私有周报\n\n只有自己能看见。\n'
const PUBLIC_MD = '# 团队周报\n\n全员都能用。\n'
const SHADOW_PRIVATE_MD = '# 同名技能（私有）\n'
const SHADOW_PUBLIC_MD = '# 同名技能（公开）\n'

let stack: JointStack
let sandboxRoot: string
let registry: SandboxRegistry
let memberToken = ''
let sessionId = ''
let client: Awaited<ReturnType<SandboxRegistry['client']>>
let provider: SkillProviderView

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token, { modelIds: ['deepseek-chat'] })
  // 同名「公开 + 私有」只能属于两个不同成员：同一个人 (user_id, name) 是唯一键。
  await api(stack.baseUrl, '/admin/users', {
    method: 'POST',
    token: stack.token,
    body: { username: 'grace', password: 'grace-password-1234' },
  })
  memberToken = await login(stack.baseUrl, 'grace', 'grace-password-1234')
  await configureModel(stack.baseUrl, memberToken, { modelIds: ['deepseek-chat'] })
  sandboxRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-mounts-'))

  const ctx = testContext({ db: stack.brainDb, agents: { get: () => undefined } })
  new SessionDirectoryService(ctx, { cacheTtlMs: 0 })
  registry = new SandboxRegistry(ctx, {
    adapter: 'mock',
    scope: 'workspace',
    store: new MemoryBindingStore(),
    // 平台写对象用的目录就是沙箱看到的“共享盘”。
    mock: { objectDir: stack.platform.storageDir, rootDir: sandboxRoot },
    directory: ctx.get('sessionDirectory') as { owner: SessionDirectoryService['owner'] },
    // 真实部署的挂载表：工作卷 + 两个只读技能前缀（技能前缀由 registry 自动追加）。
    ossMounts: [
      { bucketName: 'local', endpoint: 'local', bucketPath: 'desks/{workspaceId}', mountDir: '/desk' },
    ],
    privateSkillDir: '/skillbox/own',
    publicSkillDir: '/skillbox/common',
  })
})

afterAll(async () => {
  if (sessionId !== '') await registry.destroy(sessionId).catch(() => undefined)
  await rm(sandboxRoot, { recursive: true, force: true })
  await stack.close()
})

describe('公开 + 私有技能的沙箱挂载', () => {
  it('1. 管理员建公开技能，成员建私有技能，含一个跨成员同名', async () => {
    const created = [
      await api(stack.baseUrl, '/skills', {
        method: 'POST',
        token: memberToken,
        body: { name: 'private-report', description: '私有周报', skillMd: PRIVATE_MD },
      }),
      await api(stack.baseUrl, '/skills', {
        method: 'POST',
        token: stack.token,
        body: { name: 'public-notes', description: '团队周报', skillMd: PUBLIC_MD, scope: 'public' },
      }),
      await api(stack.baseUrl, '/skills', {
        method: 'POST',
        token: memberToken,
        body: { name: 'shadowed', description: '成员私有同名', skillMd: SHADOW_PRIVATE_MD },
      }),
      await api(stack.baseUrl, '/skills', {
        method: 'POST',
        token: stack.token,
        body: { name: 'shadowed', description: '管理员公开同名', skillMd: SHADOW_PUBLIC_MD, scope: 'public' },
      }),
    ]
    expect(created.map((response) => response.status)).toEqual([201, 201, 201, 201])

    // 附加文件也要跟着挂载，不只是 SKILL.md。
    const privateFile = await api(stack.baseUrl, `/skills/private-report/files?path=${encodeURIComponent('scripts/run.js')}`, {
      method: 'POST',
      token: memberToken,
      raw: Buffer.from('console.log("private")\n'),
      headers: { 'content-type': 'text/javascript' },
    })
    const publicFile = await api(
      stack.baseUrl,
      `/skills/public-notes/files?path=${encodeURIComponent('scripts/run.js')}&scope=public`,
      {
        method: 'POST',
        token: stack.token,
        raw: Buffer.from('console.log("public")\n'),
        headers: { 'content-type': 'text/javascript' },
      },
    )
    expect(privateFile.status).toBe(201)
    expect(publicFile.status).toBe(201)
  })

  it('2. 成员建工作区和会话', async () => {
    const workspace = await api<{ id: string }>(stack.baseUrl, '/workspaces', {
      method: 'POST',
      token: memberToken,
      body: { name: '技能挂载工作区' },
    })
    expect(workspace.status).toBe(201)
    const session = await api<{ id: string }>(stack.baseUrl, '/sessions', {
      method: 'POST',
      token: memberToken,
      body: { workspaceId: workspace.body.data.id, title: '挂载检查' },
    })
    expect(session.status).toBe(201)
    sessionId = session.body.data.id
  })

  it('3. 脑侧 SandboxRegistry 把两个技能前缀都挂进沙箱', async () => {
    const binding = await registry.ensure(sessionId)
    client = await registry.client(binding)

    const read = async (path: string): Promise<string> =>
      Buffer.from(await client.files.read(path)).toString('utf8')

    await expect(read('/skillbox/own/private-report/SKILL.md')).resolves.toBe(PRIVATE_MD)
    await expect(read('/skillbox/common/public-notes/SKILL.md')).resolves.toBe(PUBLIC_MD)
    await expect(read('/skillbox/own/private-report/scripts/run.js')).resolves.toBe('console.log("private")\n')
    await expect(read('/skillbox/common/public-notes/scripts/run.js')).resolves.toBe('console.log("public")\n')

    // 同名技能落在两个不同的挂载点上，互不覆盖。
    await expect(read('/skillbox/own/shadowed/SKILL.md')).resolves.toBe(SHADOW_PRIVATE_MD)
    await expect(read('/skillbox/common/shadowed/SKILL.md')).resolves.toBe(SHADOW_PUBLIC_MD)
  })

  it('4. 两个技能目录都是只读的', async () => {
    await expect(client.files.write('/skillbox/own/private-report/SKILL.md', Buffer.from('x'))).rejects.toThrow()
    await expect(client.files.write('/skillbox/common/public-notes/SKILL.md', Buffer.from('x'))).rejects.toThrow()
  })

  it('5. 脑的技能 Provider 同时看到公开和私有，同名时私有覆盖公开', async () => {
    provider = await createSkillProvider({ db: dbOf(stack.brainDb), sessionId, files: client.files })
    const candidates = await provider.list({})
    expect(candidates.map((item) => item.name)).toEqual(['private-report', 'public-notes', 'shadowed'])

    const shadowed = candidates.find((item) => item.name === 'shadowed')
    expect(shadowed?.locator).toEqual({ name: 'shadowed', scope: 'private' })
    await expect(provider.get(shadowed!, {})).resolves.toMatchObject({
      path: '/skillbox/own/shadowed/SKILL.md',
      content: SHADOW_PRIVATE_MD,
    })

    const shared = candidates.find((item) => item.name === 'public-notes')
    await expect(provider.get(shared!, {})).resolves.toMatchObject({
      path: '/skillbox/common/public-notes/SKILL.md',
      content: PUBLIC_MD,
    })
  })

  it('6. 平台后加的文件不用重挂载就能读到', async () => {
    const added = await api(stack.baseUrl, `/skills/public-notes/files?path=${encodeURIComponent('notes/later.txt')}&scope=public`, {
      method: 'POST',
      token: stack.token,
      raw: Buffer.from('later\n'),
      headers: { 'content-type': 'text/plain' },
    })
    expect(added.status).toBe(201)
    const content = await client.files.read('/skillbox/common/public-notes/notes/later.txt')
    expect(Buffer.from(content).toString('utf8')).toBe('later\n')
  })
})
