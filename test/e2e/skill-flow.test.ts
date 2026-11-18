import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockPlatform } from '../../../dsh-sandbox-brain/packages/dsh-e2b/src/mock-adapter.ts'
import { readSse } from '../../../dsh-sandbox-brain/test/helpers/brain.ts'
import { createSkillProvider, dbOf, mountSkillSandbox } from '../../../dsh-sandbox-brain/test/helpers/skills.ts'
import { WORKSPACE_GUEST_ROOT } from '../../src/kernel/layout.js'
import { API, api } from '../helpers/app.js'
import { configureModel, startJointStack, type JointStack } from '../helpers/stack.js'

/**
 * 完整业务流：
 *
 *   创建技能 → 创建工作区 → 发起会话（平台→脑真实 HTTP）
 *   → 确认脑接住会话且技能 Provider 能看到它 → 发消息确认脑收到
 *   → 在沙箱里按 SKILL.md 执行命令 → 产物回到平台文件 API
 */

const SKILL_MD = [
  '# 周报助手',
  '',
  '当用户要周报时：',
  '',
  '1. 收集本周改动',
  '2. 汇总成 Markdown',
  '3. 写到 report.md',
  '',
].join('\n')

let stack: JointStack
let objectsRoot: string
let sandboxRoot: string
let sandbox: MockPlatform
let sandboxId: string

beforeAll(async () => {
  stack = await startJointStack()
  await configureModel(stack.baseUrl, stack.token, { modelIds: ['deepseek-chat'] })
  sandboxRoot = await mkdtemp(join(tmpdir(), 'dsh-joint-sandboxes-'))
  // 平台的对象目录就是沙箱看到的“共享盘”。
  objectsRoot = stack.platform.storageDir
  sandbox = new MockPlatform({ objectDir: objectsRoot, rootDir: sandboxRoot })
})

afterAll(async () => {
  if (sandboxId !== undefined) await sandbox.destroy(sandboxId)
  await rm(sandboxRoot, { recursive: true, force: true })
  await stack.close()
})

describe('技能全流程', () => {
  let workspaceId: string
  let sessionId: string

  it('1. 创建技能', async () => {
    const created = await api(stack.baseUrl, '/skills', {
      method: 'POST',
      token: stack.token,
      body: { name: 'weekly-report', description: '生成周报', skillMd: SKILL_MD },
    })
    expect(created.status).toBe(201)

    const list = await api<Array<{ name: string; description: string; enabled: boolean }>>(stack.baseUrl, '/skills', {
      token: stack.token,
    })
    expect(list.body.data).toEqual([
      expect.objectContaining({ name: 'weekly-report', description: '生成周报', enabled: true }),
    ])
  })

  it('2. 创建工作区', async () => {
    const created = await api<{ id: string; guestRoot?: string }>(stack.baseUrl, '/workspaces', {
      method: 'POST',
      token: stack.token,
      body: { name: '周报工作区' },
    })
    expect(created.status).toBe(201)
    workspaceId = created.body.data.id
    // 挂载点对所有工作区都一样，所以不再作为工作区的属性下发。
    expect(created.body.data.guestRoot).toBeUndefined()
  })

  it('3. 发起会话：平台经真实 HTTP 让脑接住它', async () => {
    const created = await api<{ id: string; createState: string }>(stack.baseUrl, '/sessions', {
      method: 'POST',
      token: stack.token,
      body: { workspaceId, title: '本周周报' },
    })
    expect(created.status).toBe(201)
    expect(created.body.data.createState).toBe('ready')
    sessionId = created.body.data.id

    // 脑的内存网关收到了会话，cwd 就是工作区在沙箱里的路径。
    expect(stack.gateway.sessions.get(sessionId)).toMatchObject({ cwd: WORKSPACE_GUEST_ROOT })
    // 平台随建会话下发了模型选择。
    expect(stack.gateway.modelSelections).toContainEqual({
      sessionId,
      provider: 'user',
      model: 'deepseek-chat',
      reasoningEffort: undefined,
    })
  })

  it('4. 技能对脑的技能 Provider 可见，并能读出 SKILL.md', async () => {
    // 技能可以带脚本等附加文件；平台写对象，沙箱按目录挂载后应该直接看到。
    const uploaded = await api(stack.baseUrl, `/skills/weekly-report/files?path=${encodeURIComponent('scripts/report.js')}`, {
      method: 'POST',
      token: stack.token,
      raw: Buffer.from('console.log("report")\n'),
      headers: { 'content-type': 'text/javascript' },
    })
    expect(uploaded.status).toBe(201)

    const handle = await mountSkillSandbox(sandbox, { workspaceId, userId: 'admin' })
    sandboxId = handle.externalId
    const client = await sandbox.client(handle.externalId)

    const attached = await client.files.read('/skillbox/own/weekly-report/scripts/report.js')
    expect(Buffer.from(attached).toString('utf8')).toBe('console.log("report")\n')

    const provider = await createSkillProvider({ db: dbOf(stack.brainDb), sessionId, files: client.files })
    const candidates = await provider.list({})
    expect(candidates).toEqual([
      expect.objectContaining({
        name: 'weekly-report',
        description: '生成周报',
        rank: 300,
        locator: { name: 'weekly-report', scope: 'private' },
      }),
    ])
    await expect(provider.get(candidates[0], {})).resolves.toMatchObject({
      name: 'weekly-report',
      provider: 'user-skills',
      path: '/skillbox/own/weekly-report/SKILL.md',
      content: SKILL_MD,
    })
  })

  it('5. 发消息：平台投递到脑并记录下来', async () => {
    const sent = await api(stack.baseUrl, `/sessions/${sessionId}/messages`, {
      method: 'POST',
      token: stack.token,
      body: { text: '帮我生成这周周报', requestId: 'req-weekly-1' },
    })
    expect(sent.status).toBe(202)
    expect(sent.body.data).toMatchObject({ requestId: 'req-weekly-1', state: 'accepted' })
    expect(stack.gateway.prompts).toEqual([
      { sessionId, text: '帮我生成这周周报', requestId: 'req-weekly-1' },
    ])
  })

  it('6. 平台事件流把脑的实时帧转发给浏览器', async () => {
    const stream = await readSse(stack.baseUrl, `${API}/sessions/${sessionId}/events?after=-1`, {
      headers: { authorization: `Bearer ${stack.token}` },
      until: (events) => events.some((event) => event.event === 'ready'),
    })
    try {
      const committed = stream.events.filter((event) => event.event === 'event').map((event) => event.data as { type: string })
      expect(committed.map((event) => event.type)).toEqual(['user', 'assistant'])
      expect(stream.events.map((event) => event.event)).toContain('snapshot')
    } finally {
      stream.close()
    }
  })

  it('7. 在沙箱里执行技能，产物写回工作区', async () => {
    const client = await sandbox.client(sandboxId)
    // Mock 适配器不虚拟化绝对路径：先把平台写入的技能文件放进 cwd，再按它执行。
    const skill = Buffer.from(await client.files.read('/skillbox/own/weekly-report/SKILL.md'))
    await client.files.write(`${WORKSPACE_GUEST_ROOT}/SKILL.md`, skill)
    const { pid } = await client.process.start({
      argv: ['sh', '-c', 'cat SKILL.md > report.md && printf "\\n--executed--\\n" >> report.md'],
      cwd: WORKSPACE_GUEST_ROOT,
    })
    expect(await client.process.wait(pid)).toMatchObject({ state: 'exited', exitCode: 0 })
  })

  it('8. 平台文件 API 能看到技能产物', async () => {
    const path = `${WORKSPACE_GUEST_ROOT}/report.md`
    const content = await api<{ content: string; bytes: number }>(
      stack.baseUrl,
      `/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
      { token: stack.token },
    )
    expect(content.status).toBe(200)
    expect(content.body.data.content).toContain('# 周报助手')
    expect(content.body.data.content.trimEnd()).toContain('--executed--')

    const listing = await api<{ entries: Array<{ name: string; type: string }> }>(
      stack.baseUrl,
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(WORKSPACE_GUEST_ROOT)}`,
      { token: stack.token },
    )
    expect(listing.body.data.entries).toEqual(expect.arrayContaining([{ name: 'report.md', type: 'file', size: expect.any(Number) }]))
  })
})
