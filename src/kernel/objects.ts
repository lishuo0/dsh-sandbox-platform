import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { AppConfig } from '../config.js'

export interface StoredObject {
  key: string
  size: number
}

export interface ObjectPage {
  files: StoredObject[]
  directories: string[]
  truncated: boolean
}

export interface ObjectStore {
  enabled(): boolean
  put(key: string, body: Buffer, contentType?: string): Promise<void>
  get(key: string): Promise<Buffer | undefined>
  list(prefix: string): Promise<ObjectPage>
}

export function createObjectStore(cfg: AppConfig): ObjectStore {
  const oss = new OssStore(cfg)
  if (oss.enabled()) return oss
  return new LocalStore(cfg.storage?.dir ?? '')
}

class OssStore implements ObjectStore {
  constructor(private readonly cfg: AppConfig) {}

  enabled(): boolean {
    const oss = this.cfg.aliyun.oss
    return Boolean(oss.endpoint && oss.bucket && oss.accessKeyId && oss.accessKeySecret)
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    this.requireReady()
    const object = cleanKey(key)
    const date = new Date().toUTCString()
    const md5 = createHash('md5').update(body).digest('base64')
    const response = await fetch(objectUrl(this.cfg, object), {
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': contentType,
        'Content-MD5': md5,
        Authorization: this.auth(`PUT\n${md5}\n${contentType}\n${date}\n/${this.cfg.aliyun.oss.bucket}/${object}`),
      },
      body: bytesOf(body),
    })
    if (!response.ok) throw new Error(`对象写入失败 ${response.status}`)
  }

  async get(key: string): Promise<Buffer | undefined> {
    this.requireReady()
    const object = cleanKey(key)
    const date = new Date().toUTCString()
    const response = await fetch(objectUrl(this.cfg, object), {
      method: 'GET',
      headers: {
        Date: date,
        Authorization: this.auth(`GET\n\n\n${date}\n/${this.cfg.aliyun.oss.bucket}/${object}`),
      },
    })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`对象读取失败 ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async list(prefix: string): Promise<ObjectPage> {
    this.requireReady()
    const object = cleanKey(prefix)
    const folder = object.endsWith('/') || object === '' ? object : `${object}/`
    const query = `delimiter=%2F&max-keys=1000&prefix=${encodeURIComponent(folder)}`
    const date = new Date().toUTCString()
    const response = await fetch(`${bucketRoot(this.cfg)}?${query}`, {
      method: 'GET',
      headers: {
        Date: date,
        Authorization: this.auth(`GET\n\n\n${date}\n/${this.cfg.aliyun.oss.bucket}/`),
      },
    })
    if (!response.ok) throw new Error(`对象列举失败 ${response.status}`)
    return parseList(await response.text(), folder)
  }

  private requireReady(): void {
    if (!this.enabled()) throw new Error('config.yaml 的 aliyun.oss 还没填完整')
  }

  private auth(canonical: string): string {
    const signature = createHmac('sha1', this.cfg.aliyun.oss.accessKeySecret).update(canonical).digest('base64')
    return `OSS ${this.cfg.aliyun.oss.accessKeyId}:${signature}`
  }
}

/** 本机目录，键和 OSS 对象键一致。没填阿里云时平台和本地沙箱共用它。 */
class LocalStore implements ObjectStore {
  constructor(private readonly root: string) {
    if (!root) throw new Error('本地对象目录还没定')
  }

  enabled(): boolean {
    return true
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.confine(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.confine(key))
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  async list(prefix: string): Promise<ObjectPage> {
    const folder = cleanKey(prefix).replace(/\/$/, '')
    const dir = this.confine(folder)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return { files: [], directories: [], truncated: false }
      throw error
    }
    const files: StoredObject[] = []
    const directories: string[] = []
    for (const entry of entries) {
      const key = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.isDirectory()) directories.push(`${key}/`)
      else if (entry.isFile()) files.push({ key, size: (await stat(resolve(dir, entry.name))).size })
    }
    return { files, directories, truncated: false }
  }

  private confine(key: string): string {
    const file = resolve(this.root, cleanKey(key))
    const rel = relative(resolve(this.root), file)
    if (rel.startsWith('..')) throw new Error('对象键越出本地目录')
    return file
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function bytesOf(body: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}

function cleanKey(key: string): string {
  return key.replace(/^\/+/, '')
}

function bucketRoot(cfg: AppConfig): string {
  const endpoint = cfg.aliyun.oss.endpoint.replace(/\/+$/, '')
  const host = endpoint.replace(/^https?:\/\//, '')
  if (host.startsWith(`${cfg.aliyun.oss.bucket}.`)) return endpoint
  const scheme = endpoint.startsWith('http://') ? 'http' : 'https'
  return `${scheme}://${cfg.aliyun.oss.bucket}.${host}`
}

function objectUrl(cfg: AppConfig, key: string): string {
  return `${bucketRoot(cfg)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

function parseList(xml: string, prefix: string): ObjectPage {
  const files: StoredObject[] = []
  const directories: string[] = []
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
    const key = textOf(block, 'Key')
    if (!key || key === prefix) continue
    files.push({ key, size: Number(textOf(block, 'Size') ?? '0') })
  }
  for (const block of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) ?? []) {
    const value = textOf(block, 'Prefix')
    if (value) directories.push(value)
  }
  return { files, directories, truncated: xml.includes('<IsTruncated>true</IsTruncated>') }
}

function textOf(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)
  return match?.[1]
}
