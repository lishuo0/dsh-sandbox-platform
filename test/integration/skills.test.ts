import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, login, startTestPlatform, type TestPlatform } from '../helpers/app.js'

let platform: TestPlatform
let token: string

beforeAll(async () => {
  platform = await startTestPlatform()
  token = await login(platform.baseUrl, platform.config.auth.adminUsername, platform.config.auth.adminPassword)
})

afterAll(async () => {
  await platform.close()
})

const SKILL_MD = '# 周报助手\n\n当用户要周报时，执行 `node scripts/report.js` 并把输出贴回。\n'

describe('技能', () => {
  it('保存私有技能：写 SKILL.md 对象并建行', async () => {
    const response = await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'weekly-report', description: '生成周报', skillMd: SKILL_MD },
    })
    expect(response.status).toBe(201)
    expect(response.body.data).toEqual({ name: 'weekly-report', scope: 'private' })

    const file = await readFile(join(platform.storageDir, 'members', 'admin', 'skills', 'weekly-report', 'SKILL.md'), 'utf8')
    expect(file).toBe(SKILL_MD)

    const rows = await platform.db.query(
      `SELECT user_id, name, description, scope, enabled, revision, bytes, file_count FROM dsh_skills WHERE name = 'weekly-report'`,
    )
    const saved = rows.rows[0] as { enabled: unknown; revision: unknown; bytes: unknown; file_count: unknown }
    expect(rows.rows[0]).toMatchObject({
      user_id: 'admin',
      description: '生成周报',
      scope: 'private',
    })
    // PostgreSQL 的 boolean/bigint 与 SQLite 的 integer 形状不同，按语义比较。
    expect(Boolean(saved.enabled)).toBe(true)
    expect(Number(saved.revision)).toBe(1)
    expect(Number(saved.bytes)).toBe(Buffer.byteLength(SKILL_MD))
    expect(Number(saved.file_count)).toBe(1)
  })

  it('列表包含刚保存的技能', async () => {
    const response = await api<Array<{ name: string; scope: string }>>(platform.baseUrl, '/skills', { token })
    expect(response.body.data).toEqual([expect.objectContaining({ name: 'weekly-report', scope: 'private' })])
  })

  it('再次保存同一私有技能递增 revision', async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'weekly-report', description: '生成周报（改）', skillMd: SKILL_MD + '\n补充一行' },
    })
    const rows = await platform.db.query(`SELECT description, revision, bytes FROM dsh_skills WHERE name = 'weekly-report'`)
    expect(Number(rows.rows[0].revision)).toBe(2)
    expect(rows.rows[0].description).toBe('生成周报（改）')
  })

  it('缺字段 422，非法名字 422', async () => {
    const missing = await api(platform.baseUrl, '/skills', { method: 'POST', token, body: { name: '', description: '', skillMd: '' } })
    expect(missing.status).toBe(422)
    expect(missing.body.msg).toBe('skill-required')

    const badName = await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'Bad Name', description: 'd', skillMd: '# x' },
    })
    expect(badName.status).toBe(422)
    expect(badName.body.msg).toBe('invalid-skill-name')
  })

  it('停用后列表里 enabled=false；重新启用', async () => {
    await api(platform.baseUrl, '/skills/weekly-report/disable', { method: 'POST', token })
    let list = await api<Array<{ enabled: boolean }>>(platform.baseUrl, '/skills', { token })
    expect(list.body.data[0]!.enabled).toBe(false)

    await api(platform.baseUrl, '/skills/weekly-report/enable', { method: 'POST', token })
    list = await api<Array<{ enabled: boolean }>>(platform.baseUrl, '/skills', { token })
    expect(list.body.data[0]!.enabled).toBe(true)
  })

  it('操作不存在的技能 404', async () => {
    const response = await api(platform.baseUrl, '/skills/ghost/disable', { method: 'POST', token })
    expect(response.status).toBe(404)
  })

  it('公共技能：管理员可写，成员被拒，且所有人可见', async () => {
    const shared = await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'shared-lint', description: '公共检查', skillMd: '# 公共', scope: 'public' },
    })
    expect(shared.status).toBe(201)
    const publicFile = await readFile(join(platform.storageDir, 'common', 'skills', 'shared-lint', 'SKILL.md'), 'utf8')
    expect(publicFile).toBe('# 公共')

    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'erin', password: 'erin-password-1234' },
    })
    const erin = await login(platform.baseUrl, 'erin', 'erin-password-1234')
    const denied = await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token: erin,
      body: { name: 'erin-public', description: 'x', skillMd: '# x', scope: 'public' },
    })
    expect(denied.status).toBe(403)
    expect(denied.body.msg).toBe('admin-only')

    const visible = await api<Array<{ name: string; scope: string }>>(platform.baseUrl, '/skills', { token: erin })
    expect(visible.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shared-lint', scope: 'public' })]),
    )
  })

  it('同一名字不能既是公共又是私有', async () => {
    const response = await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'shared-lint', description: 'x', skillMd: '# x' },
    })
    expect(response.status).toBe(409)
    expect(response.body.msg).toBe('name-taken')
  })
})

describe('技能详情与文件', () => {
  let memberToken: string

  beforeAll(async () => {
    await api(platform.baseUrl, '/admin/users', {
      method: 'POST',
      token,
      body: { username: 'frank', password: 'frank-password-1234' },
    })
    memberToken = await login(platform.baseUrl, 'frank', 'frank-password-1234')
  })

  it('详情返回元数据和文件清单，文件内容可直接下载', async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'detail-demo', description: '详情示例', skillMd: '# 详情\n' },
    })
    const detail = await api<{
      name: string
      description: string
      scope: string
      owner_id: string
      owner_display_name: string
      mine: boolean
      file_count: number
      files: Array<{ path: string; bytes: number }>
    }>(platform.baseUrl, '/skills/detail-demo', { token })
    expect(detail.status).toBe(200)
    expect(detail.body.data).toMatchObject({
      name: 'detail-demo',
      description: '详情示例',
      scope: 'private',
      owner_id: 'admin',
      mine: true,
      file_count: 1,
    })
    expect(detail.body.data.owner_display_name).toBeTruthy()
    expect(detail.body.data.files).toEqual([{ path: 'SKILL.md', bytes: Buffer.byteLength('# 详情\n') }])

    const file = await fetch(`${platform.baseUrl}/dsh-api/platform/v1/skills/detail-demo/file`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('text/markdown')
    expect(file.headers.get('cache-control')).toBe('no-store')
    expect(await file.text()).toBe('# 详情\n')
  })

  it('上传附加文件：递归列目录、更新统计、可下载可删除', async () => {
    const script = Buffer.from('console.log("report")\n')
    const upload = await api<{ bytes: number; file_count: number }>(
      platform.baseUrl,
      `/skills/detail-demo/files?path=${encodeURIComponent('scripts/report.js')}`,
      { method: 'POST', token, raw: script, headers: { 'content-type': 'text/javascript' } },
    )
    expect(upload.status).toBe(201)
    expect(upload.body.data).toEqual({ bytes: Buffer.byteLength('# 详情\n') + script.length, file_count: 2 })

    const listed = await api<{ files: Array<{ path: string; bytes: number }>; revision: number }>(
      platform.baseUrl,
      '/skills/detail-demo',
      { token },
    )
    expect(listed.body.data.files).toEqual([
      { path: 'scripts/report.js', bytes: script.length },
      { path: 'SKILL.md', bytes: Buffer.byteLength('# 详情\n') },
    ])
    // 加文件会推进 revision，让脑知道要重新挂。
    expect(listed.body.data.revision).toBe(2)

    const download = await fetch(
      `${platform.baseUrl}/dsh-api/platform/v1/skills/detail-demo/file?path=${encodeURIComponent('scripts/report.js')}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('text/javascript')
    expect(await download.text()).toBe(script.toString('utf8'))

    const removed = await api<{ bytes: number; file_count: number }>(
      platform.baseUrl,
      `/skills/detail-demo/files?path=${encodeURIComponent('scripts/report.js')}`,
      { method: 'DELETE', token },
    )
    expect(removed.status).toBe(200)
    expect(removed.body.data).toEqual({ bytes: Buffer.byteLength('# 详情\n'), file_count: 1 })
  })

  it('SKILL.md 只能通过主表单保存，附件接口拒绝', async () => {
    const response = await api(platform.baseUrl, `/skills/detail-demo/files?path=SKILL.md`, {
      method: 'POST',
      token,
      raw: Buffer.from('# 覆盖'),
    })
    expect(response.status).toBe(422)
    expect(response.body.msg).toBe('invalid-path')
  })

  it('路径穿越和绝对路径都被拒绝', async () => {
    for (const bad of ['../escape.txt', '/etc/passwd', 'a/../../b.txt', 'a//b.txt', 'a\\b.txt']) {
      const response = await api(platform.baseUrl, `/skills/detail-demo/files?path=${encodeURIComponent(bad)}`, {
        method: 'POST',
        token,
        raw: Buffer.from('x'),
      })
      expect(response.status, bad).toBe(422)
      expect(response.body.msg).toBe('invalid-path')
    }
  })

  it('单文件超过 32 MiB 返回 413', async () => {
    const tooBig = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61)
    const response = await api(platform.baseUrl, `/skills/detail-demo/files?path=big.bin`, {
      method: 'POST',
      token,
      raw: tooBig,
    })
    expect(response.status).toBe(413)
    expect(response.body.msg).toBe('file-too-large')
  })

  it('PUT 更新描述和 SKILL.md，revision 递增', async () => {
    const before = await api<{ revision: number }>(platform.baseUrl, '/skills/detail-demo', { token })
    const updated = await api(platform.baseUrl, '/skills/detail-demo', {
      method: 'PUT',
      token,
      body: { description: '详情示例（改）', skillMd: '# 详情 v2\n' },
    })
    expect(updated.status).toBe(200)

    const after = await api<{ description: string; revision: number; file_count: number }>(
      platform.baseUrl,
      '/skills/detail-demo',
      { token },
    )
    expect(after.body.data.description).toBe('详情示例（改）')
    expect(after.body.data.revision).toBe(before.body.data.revision + 1)
    expect(after.body.data.file_count).toBe(1)

    const file = await readFile(join(platform.storageDir, 'members', 'admin', 'skills', 'detail-demo', 'SKILL.md'), 'utf8')
    expect(file).toBe('# 详情 v2\n')
  })

  it('别人的私有技能不可见（详情和文件都 404）', async () => {
    const detail = await api(platform.baseUrl, '/skills/detail-demo', { token: memberToken })
    expect(detail.status).toBe(404)
    const file = await fetch(`${platform.baseUrl}/dsh-api/platform/v1/skills/detail-demo/file`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect(file.status).toBe(404)
  })

  it('成员可读公共技能，但不能改、不能停用、不能删', async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'public-guide', description: '公共指南', skillMd: '# 指南', scope: 'public' },
    })
    const read = await api<{ scope: string; mine: boolean }>(platform.baseUrl, '/skills/public-guide?scope=public', {
      token: memberToken,
    })
    expect(read.status).toBe(200)
    expect(read.body.data).toMatchObject({ scope: 'public', mine: false })
    const file = await fetch(`${platform.baseUrl}/dsh-api/platform/v1/skills/public-guide/file?scope=public`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect(await file.text()).toBe('# 指南')

    const put = await api(platform.baseUrl, '/skills/public-guide?scope=public', {
      method: 'PUT',
      token: memberToken,
      body: { description: 'x', skillMd: '# x' },
    })
    expect(put.status).toBe(403)
    expect(put.body.msg).toBe('admin-only')

    const disable = await api(platform.baseUrl, '/skills/public-guide/disable?scope=public', {
      method: 'POST',
      token: memberToken,
    })
    expect(disable.status).toBe(403)

    const remove = await api(platform.baseUrl, '/skills/public-guide?scope=public', {
      method: 'DELETE',
      token: memberToken,
    })
    expect(remove.status).toBe(403)
  })

  it('公共技能修改者成为 owner，旧 owner 不再标 mine', async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'public-owner', description: 'd', skillMd: '# d', scope: 'public' },
    })
    const updated = await api(platform.baseUrl, '/skills/public-owner?scope=public', {
      method: 'PUT',
      token,
      body: { description: 'd2', skillMd: '# d2' },
    })
    expect(updated.status).toBe(200)
    const detail = await api<{ owner_id: string; mine: boolean; description: string }>(
      platform.baseUrl,
      '/skills/public-owner?scope=public',
      { token },
    )
    expect(detail.body.data).toMatchObject({ owner_id: 'admin', mine: true, description: 'd2' })
  })

  it('删除技能会清掉行和所有对象', async () => {
    await api(platform.baseUrl, '/skills', {
      method: 'POST',
      token,
      body: { name: 'to-delete', description: '删我', skillMd: '# 删我' },
    })
    await api(platform.baseUrl, `/skills/to-delete/files?path=${encodeURIComponent('assets/data.txt')}`, {
      method: 'POST',
      token,
      raw: Buffer.from('payload'),
    })
    const removed = await api(platform.baseUrl, '/skills/to-delete', { method: 'DELETE', token })
    expect(removed.status).toBe(200)

    const rows = await platform.db.query(`SELECT 1 FROM dsh_skills WHERE name = 'to-delete'`)
    expect(rows.rows).toHaveLength(0)
    await expect(
      readFile(join(platform.storageDir, 'members', 'admin', 'skills', 'to-delete', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(platform.storageDir, 'members', 'admin', 'skills', 'to-delete', 'assets', 'data.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    const again = await api(platform.baseUrl, '/skills/to-delete', { method: 'DELETE', token })
    expect(again.status).toBe(404)
  })
})
