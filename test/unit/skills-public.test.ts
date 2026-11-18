import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { migrate } from '../../src/kernel/db.js'
import { skillObjectKey } from '../../src/kernel/layout.js'
import { createObjectStore, type ObjectStore } from '../../src/kernel/objects.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import { listSkills, saveSkill } from '../../src/modules/skills/service.js'

/**
 * 公开技能是全局命名空间里的一份内容：两个管理员先后保存同名公开技能时，
 * 必须沿用第一次落库的 owner 前缀。否则后写的人会把对象搬到自己的前缀下，
 * 之前的读路径全部 404，也等于把内容记到了别人名下。
 */

let dir: string
let db: SqliteDb
let objects: ObjectStore

const ADMIN_ONE = { id: 'a1', role: 'admin' }
const ADMIN_TWO = { id: 'a2', role: 'admin' }
const MEMBER = { id: 'm1', role: 'member' }

function localConfig(storageDir: string): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir: storageDir },
  } as unknown as AppConfig
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-skills-public-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  objects = createObjectStore(localConfig(join(dir, 'objects')))
  await db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash, role) VALUES
       ('a1', '管理员一', 'x', 'admin'), ('a2', '管理员二', 'x', 'admin'), ('m1', '成员', 'x', 'member')`,
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function save(actor: { id: string; role: string }, description: string, skillMd: string): Promise<void> {
  await saveSkill(db, objects, actor, { name: 'shared', description, skillMd, scope: 'public' })
}

describe('公开技能的归属', () => {
  it('第二个管理员保存同名公开技能时沿用第一个 owner 的对象前缀', async () => {
    await save(ADMIN_ONE, '第一版', '# 第一版')
    await save(ADMIN_TWO, '第二版', '# 第二版')

    const rows = await db.query<{ user_id: string; revision: number }>(
      `SELECT user_id, revision FROM dsh_skills WHERE scope = 'public' AND name = 'shared'`,
    )
    expect(rows.rows).toEqual([{ user_id: 'a1', revision: 2 }])

    // 公开技能只有一份内容（common/），owner 决定谁能删改；内容被第二个管理员覆盖。
    expect(await objects.get(skillObjectKey('public', 'a1', 'shared', 'SKILL.md'))).toEqual(Buffer.from('# 第二版'))
    expect(skillObjectKey('public', 'a1', 'shared', 'SKILL.md')).toBe('common/skills/shared/SKILL.md')
  })

  it('普通成员不能创建或覆盖公开技能', async () => {
    await expect(save(MEMBER, '想公开', '# x')).rejects.toMatchObject({ status: 403, code: 'admin-only' })
  })

  it('私有技能按成员各自落在自己的前缀里', async () => {
    for (const actor of [ADMIN_ONE, ADMIN_TWO]) {
      await saveSkill(db, objects, actor, {
        name: 'shared',
        description: `${actor.id} 的私有`,
        skillMd: `# ${actor.id}`,
        scope: 'private',
      })
    }
    expect(await objects.get(skillObjectKey('private', 'a1', 'shared', 'SKILL.md'))).toEqual(Buffer.from('# a1'))
    expect(await objects.get(skillObjectKey('private', 'a2', 'shared', 'SKILL.md'))).toEqual(Buffer.from('# a2'))
    expect((await listSkills(db, 'a1')).map((skill) => skill.description)).toEqual(['a1 的私有'])
  })
})
