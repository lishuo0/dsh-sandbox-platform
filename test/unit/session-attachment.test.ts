import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { migrate } from '../../src/kernel/db.js'
import { fileObjectKey } from '../../src/kernel/layout.js'
import { createObjectStore, type ObjectStore } from '../../src/kernel/objects.js'
import { SqliteDb } from '../../src/kernel/sqlite.js'
import {
  readSignedUpload,
  sessionImageAttachment,
  sniffImageType,
  uploadSessionFile,
} from '../../src/modules/sessions/attachment.js'

/**
 * 会话附件：上传落进工作卷前缀，读取按 `ws:` / `sha256:` 两种 id 还原字节。
 * 本地目录冒充对象存储，不碰宿主机的工作区目录。
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const TEXT = Buffer.from('不是图片')
const KEY = randomBytes(32)

let dir: string
let db: SqliteDb
let objects: ObjectStore

function localConfig(storageDir: string): AppConfig {
  return {
    aliyun: { oss: { region: '', endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '' } },
    storage: { dir: storageDir },
  } as unknown as AppConfig
}

function upload(name: string, bytes = PNG, type = 'image/png') {
  return uploadSessionFile(db, objects, KEY, 'u1', 's1', name, type, bytes)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-session-attachment-'))
  db = await SqliteDb.open(join(dir, 'test.sqlite'))
  await migrate(db)
  objects = createObjectStore(localConfig(join(dir, 'objects')))
  await db.query(
    `INSERT INTO dsh_users (id, display_name, password_hash) VALUES ('u1', 'u1', 'x'), ('u2', 'u2', 'x')`,
  )
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root) VALUES
       ('w1', 'u1', '一的工作区', '/tmp/w1', '/desk'),
       ('w2', 'u2', '二的工作区', '/tmp/w2', '/desk')`,
  )
  await db.query(
    `INSERT INTO dsh_sessions (id, user_id, workspace_id, title) VALUES
       ('s1', 'u1', 'w1', '会话一'), ('s2', 'u2', 'w2', '会话二')`,
  )
})

afterEach(async () => {
  await db.end()
  await rm(dir, { recursive: true, force: true })
})

describe('会话文件上传', () => {
  it('写进 uploads/<sessionId>/ 并给出签名地址', async () => {
    const saved = await upload('图 1.png')
    expect(saved.path).toBe('uploads/s1/图 1.png')
    expect(saved.sandboxPath).toBe('/desk/uploads/s1/图 1.png')
    expect(saved.bytes).toBe(PNG.byteLength)
    expect(saved.url).toMatch(/^\/dsh-api\/platform\/v1\/files\?w=w1&k=desks%2Fw1%2Fuploads%2Fs1%2F/)

    expect(await objects.get('desks/w1/uploads/s1/图 1.png')).toEqual(PNG)
  })

  it('图片类型按字节判定，不看扩展名', async () => {
    const saved = await upload('photo.txt', PNG, 'text/plain')
    const read = await readSignedUpload(objects, KEY, 'u1', toInput(queryOf(saved.url)))
    expect(read.mediaType).toBe('image/png')
  })

  it('拒绝带路径的文件名、空文件和别人的会话', async () => {
    await expect(upload('../evil.png')).rejects.toMatchObject({ status: 422, code: 'invalid-name' })
    await expect(upload('empty.png', Buffer.alloc(0))).rejects.toMatchObject({ status: 422, code: 'empty-file' })
    await expect(
      uploadSessionFile(db, objects, KEY, 'u1', 's2', 'a.png', 'image/png', PNG),
    ).rejects.toMatchObject({ status: 404, code: 'not-found' })
  })

  it('归档会话不再接受上传', async () => {
    await db.query(`UPDATE dsh_sessions SET status = 'archived' WHERE id = 's1'`)
    await expect(upload('a.png')).rejects.toMatchObject({ status: 409, code: 'session-inactive' })
  })
})

describe('签名下载地址', () => {
  it('签名有效时原样返回字节', async () => {
    const saved = await upload('a.png')
    const read = await readSignedUpload(objects, KEY, 'u1', toInput(queryOf(saved.url)))
    expect(read.data).toEqual(PNG)
    expect(read.mediaType).toBe('image/png')
  })

  it('签名被改、过期或键越界都按未找到处理', async () => {
    const saved = await upload('a.png')
    const query = queryOf(saved.url)

    const tampered = new URLSearchParams(query)
    tampered.set('sig', 'f'.repeat(64))
    await expect(readSignedUpload(objects, KEY, 'u1', toInput(tampered))).rejects.toMatchObject({ status: 404 })

    const expired = new URLSearchParams(query)
    expired.set('e', '1')
    await expect(readSignedUpload(objects, KEY, 'u1', toInput(expired))).rejects.toMatchObject({ status: 404 })

    // 换成别的工作区的键，签名对不上；再补一个合法签名，前缀校验仍然拦住。
    const foreignKey = 'desks/w2/uploads/s1/a.png'
    const foreign = new URLSearchParams(query)
    foreign.set('k', foreignKey)
    await expect(readSignedUpload(objects, KEY, 'u1', toInput(foreign))).rejects.toMatchObject({ status: 404 })
    const expires = Number(query.get('e'))
    await expect(
      readSignedUpload(objects, KEY, 'u1', {
        ...toInput(foreign),
        signature: createHmac('sha256', KEY).update(`u1\nw1\n${foreignKey}\n${expires}`).digest('hex'),
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('别人的签名地址不能用', async () => {
    const saved = await upload('a.png')
    await expect(readSignedUpload(objects, KEY, 'u2', toInput(queryOf(saved.url)))).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('会话图片附件', () => {
  it('sha256: 附件按摘要还原并校验内容', async () => {
    const body = Buffer.concat([PNG, Buffer.from('extra')])
    const digest = createHash('sha256').update(body).digest('hex')
    await objects.put(fileObjectKey(digest), body)
    await ownAttachment('u1', digest, body)

    const payload = await sessionImageAttachment(db, objects, 'u1', 's1', `sha256:${digest}`)
    expect(payload.attachment).toEqual({
      attachmentId: `sha256:${digest}`,
      mediaType: 'image/png',
      bytes: body.byteLength,
    })
    expect(Buffer.from(payload.data, 'base64')).toEqual(body)
  })

  it('摘要和内容对不上时拒绝，不当成图片给出去', async () => {
    const claimed = 'b'.repeat(64)
    await objects.put(fileObjectKey(claimed), PNG)
    await ownAttachment('u1', claimed, PNG)
    await expect(sessionImageAttachment(db, objects, 'u1', 's1', `sha256:${claimed}`)).rejects.toMatchObject({
      status: 422,
      code: 'attachment-corrupt',
    })
  })

  it('ws: 附件读工作卷内的文件并带上文件名', async () => {
    await upload('图.png')
    const id = workspaceId('/desk/uploads/s1/图.png')
    const payload = await sessionImageAttachment(db, objects, 'u1', 's1', id)
    expect(payload.attachment).toMatchObject({ attachmentId: id, mediaType: 'image/png', name: '图.png' })
    expect(Buffer.from(payload.data, 'base64')).toEqual(PNG)
  })

  it('ws: 路径越界、非图片、缺失和非法 id 分别报错', async () => {
    await expect(sessionImageAttachment(db, objects, 'u1', 's1', workspaceId('/etc/passwd'))).rejects.toMatchObject({
      status: 422,
      code: 'invalid-attachment-id',
    })

    await upload('note.txt', TEXT, 'text/plain')
    await expect(
      sessionImageAttachment(db, objects, 'u1', 's1', workspaceId('/desk/uploads/s1/note.txt')),
    ).rejects.toMatchObject({ status: 422, code: 'not-an-image' })

    await expect(
      sessionImageAttachment(db, objects, 'u1', 's1', workspaceId('/desk/uploads/s1/missing.png')),
    ).rejects.toMatchObject({ status: 404, code: 'not-found' })

    await expect(sessionImageAttachment(db, objects, 'u1', 's1', 'nonsense')).rejects.toMatchObject({
      status: 422,
      code: 'invalid-attachment-id',
    })
  })

  it('别人的会话读不到附件', async () => {
    await expect(
      sessionImageAttachment(db, objects, 'u2', 's1', `sha256:${'a'.repeat(64)}`),
    ).rejects.toMatchObject({ status: 404, code: 'not-found' })
  })

  it('别人的附件摘要读不到：对象是全局内容寻址的，归属在附件行上', async () => {
    const digest = createHash('sha256').update(PNG).digest('hex')
    await objects.put(fileObjectKey(digest), PNG)
    await ownAttachment('u1', digest, PNG)
    // u2 有自己的会话，但这条附件记在 u1 名下。
    await expect(
      sessionImageAttachment(db, objects, 'u2', 's2', `sha256:${digest}`),
    ).rejects.toMatchObject({ status: 404, code: 'not-found' })
    // u1 自己仍然读得到。
    const own = await sessionImageAttachment(db, objects, 'u1', 's1', `sha256:${digest}`)
    expect(Buffer.from(own.data, 'base64')).toEqual(PNG)
  })
})

describe('图片类型嗅探', () => {
  it('认识 JPEG/PNG/GIF/WebP，其余返回空串', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(TEXT)).toBe('')
  })
})

/** 附件行是 `sha256:` 读取的归属依据；对象本身只按摘要存。 */
async function ownAttachment(userId: string, digest: string, body: Buffer): Promise<void> {
  await db.query(
    `INSERT INTO dsh_attachments (id, user_id, name, media_type, bytes, object_key)
     VALUES ($1, $2, 'a.png', 'image/png', $3, $4)`,
    [`sha256:${digest}`, userId, body.byteLength, fileObjectKey(digest)],
  )
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams
}

function toInput(query: URLSearchParams) {
  return {
    workspaceId: query.get('w') ?? '',
    key: query.get('k') ?? '',
    expires: query.get('e') ?? '',
    signature: query.get('sig') ?? '',
  }
}

function workspaceId(absolutePath: string): string {
  return `ws:${Buffer.from(absolutePath).toString('base64url')}`
}
