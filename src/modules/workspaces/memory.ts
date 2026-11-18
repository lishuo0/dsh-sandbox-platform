import { HttpError } from '../../kernel/errors.js'
import { personalMemoryPrefix, workspaceMemoryPrefix, WORKSPACE_MEMORY_DIR } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'
import type { Workspace } from './service.js'

/**
 * 记忆是脑在沙箱工作卷里写的 Markdown：
 *
 *   工作区：`/desk/.dsh/memory/MEMORY.md` + `documents/{active,archived}/…`
 *   个人：  `members/<userId>/personal/`（跨工作区，不在任何沙箱卷里）
 *
 * 平台只读，和工作区文件接口一样按对象存储的前缀读，不碰宿主机目录。
 */

const MAX_FILE_BYTES = 1 << 20
const MAX_FILES = 20
const DOCUMENT_INDEX = 'index.json'

interface MemoryFile {
  name: string
  content: string
  size: number
  path?: string
}

interface MemoryDocumentView {
  id: string
  title: string
  description: string
  status: 'active' | 'archived'
  size_bytes: number
  updated_at: string
  path?: string
}

interface MemoryDocumentRecord {
  id?: unknown
  title?: unknown
  description?: unknown
  status?: unknown
  filename?: unknown
  sizeBytes?: unknown
  updatedAt?: unknown
}

export async function personalMemory(objects: ObjectStore, userId: string) {
  requireStore(objects)
  const prefix = `${personalMemoryPrefix(userId)}/`
  const page = await objects.list(prefix)
  const files: MemoryFile[] = []
  for (const object of page.files) {
    const name = object.key.slice(prefix.length)
    // 只读顶层的 Markdown；未来可能出现的子目录这一页不渲染。
    if (name === '' || name.includes('/') || !name.toLowerCase().endsWith('.md')) continue
    if (object.size > MAX_FILE_BYTES) continue
    const body = await objects.get(object.key)
    if (body === undefined) continue
    files.push({ name, content: body.toString('utf8'), size: object.size })
  }
  files.sort((left, right) => left.name.localeCompare(right.name))
  return { files: files.slice(0, MAX_FILES) }
}

export async function workspaceMemory(objects: ObjectStore, workspace: Workspace) {
  requireStore(objects)
  const prefix = `${workspaceMemoryPrefix(workspace.id)}/`

  const view: {
    workspace_id: string
    available: boolean
    memory?: MemoryFile
    documents: MemoryDocumentView[]
  } = { workspace_id: workspace.id, available: false, documents: [] }

  const memoryBody = await readCapped(objects, `${prefix}MEMORY.md`)
  if (memoryBody !== undefined) {
    view.memory = {
      name: 'MEMORY.md',
      content: memoryBody.toString('utf8'),
      size: memoryBody.length,
      path: `${WORKSPACE_MEMORY_DIR}/MEMORY.md`,
    }
  }

  const indexBody = await readCapped(objects, `${prefix}documents/${DOCUMENT_INDEX}`)
  if (indexBody !== undefined) view.documents = parseIndex(indexBody).map(documentView)

  view.available = view.memory !== undefined || view.documents.length > 0
  return view
}

export async function workspaceMemoryDocument(objects: ObjectStore, workspace: Workspace, documentId: string) {
  requireStore(objects)
  const prefix = `${workspaceMemoryPrefix(workspace.id)}/`
  const body = await objects.get(`${prefix}documents/${DOCUMENT_INDEX}`)
  if (body === undefined) throw new HttpError(404, 'not-found')
  const record = parseIndex(body).find((candidate) => candidate.id === documentId)
  if (record === undefined) throw new HttpError(404, 'not-found')
  const objectName = documentObjectName(record)
  if (objectName === undefined) throw new HttpError(404, 'not-found')
  const content = await objects.get(`${prefix}${objectName}`)
  if (content === undefined) throw new HttpError(404, 'not-found')
  return { ...documentView(record), content: content.toString('utf8') }
}

function parseIndex(body: Buffer): MemoryDocumentRecord[] {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { documents?: unknown }
    return Array.isArray(parsed.documents) ? (parsed.documents as MemoryDocumentRecord[]) : []
  } catch {
    // 索引坏了就当没有文档，页面仍能展示 MEMORY.md。
    return []
  }
}

/** 索引里的相对位置；文件名必须是一段，防止索引把读取带出 `documents/`。 */
function documentObjectName(record: MemoryDocumentRecord): string | undefined {
  const name = typeof record.filename === 'string' ? record.filename.trim() : ''
  if (name === '' || name === '.' || name === '..' || name.includes('..') || /[/\\]/.test(name)) {
    return undefined
  }
  return `documents/${statusOf(record)}/${name}`
}

function documentView(record: MemoryDocumentRecord): MemoryDocumentView {
  const status = statusOf(record)
  const view: MemoryDocumentView = {
    id: typeof record.id === 'string' ? record.id : '',
    title: typeof record.title === 'string' ? record.title : '',
    description: typeof record.description === 'string' ? record.description : '',
    status,
    size_bytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    updated_at: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
  const objectName = documentObjectName(record)
  if (objectName !== undefined) view.path = `${WORKSPACE_MEMORY_DIR}/${objectName}`
  return view
}

function statusOf(record: MemoryDocumentRecord): 'active' | 'archived' {
  return record.status === 'archived' ? 'archived' : 'active'
}

/** 超过上限的文件不读，避免一次把大对象全拉进内存。 */
async function readCapped(objects: ObjectStore, key: string): Promise<Buffer | undefined> {
  const body = await objects.get(key)
  return body === undefined || body.length > MAX_FILE_BYTES ? undefined : body
}

function requireStore(objects: ObjectStore): void {
  if (!objects.enabled()) throw new HttpError(503, 'object-store-unconfigured')
}
