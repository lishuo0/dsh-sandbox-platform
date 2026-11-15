import { randomBytes } from 'node:crypto'
import { HttpError } from '../../kernel/errors.js'
import type { Querier } from '../../kernel/db.js'
import { workspaceGuest, workspaceHost, workspaceObjectKey, workspaceVolume } from '../../kernel/layout.js'
import type { ObjectStore } from '../../kernel/objects.js'

export interface Workspace {
  id: string
  name: string
  guestRoot: string
  volumeName: string | null
  state: string
}

export async function listWorkspaces(db: Querier, userId: string): Promise<Workspace[]> {
  const rows = await db.query(
    `SELECT id, name, guest_root, volume_name, state FROM dsh_workspaces WHERE user_id = $1 ORDER BY last_active_at DESC`,
    [userId],
  )
  return rows.rows.flatMap((row) => {
    const workspace = mapWorkspace(row)
    return workspace ? [workspace] : []
  })
}

export async function createWorkspace(db: Querier, objects: ObjectStore, userId: string, name: string): Promise<Workspace> {
  const trimmed = name.trim()
  if (!trimmed) throw new HttpError(422, 'name-required')
  const id = `ws_${randomBytes(12).toString('hex')}`
  const guestRoot = workspaceGuest(id)
  const volumeName = workspaceVolume(id)
  await db.query(
    `INSERT INTO dsh_workspaces (id, user_id, name, host_root, guest_root, volume_name) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, trimmed, workspaceHost(userId, id), guestRoot, volumeName],
  )
  if (objects.enabled()) await objects.put(`${workspaceObjectKey(id, guestRoot, guestRoot)}/.keep`, Buffer.from(''))
  return { id, name: trimmed, guestRoot, volumeName, state: 'active' }
}

export async function updateWorkspace(
  db: Querier,
  userId: string,
  id: string,
  patch: { name?: string; archived?: boolean },
): Promise<void> {
  const state = patch.archived === undefined ? null : patch.archived ? 'archived' : 'active'
  const result = await db.query(
    `UPDATE dsh_workspaces SET name = COALESCE($3, name), state = COALESCE($4, state) WHERE id = $1 AND user_id = $2`,
    [id, userId, patch.name?.trim() || null, state],
  )
  if (!result.rowCount) throw new HttpError(404, 'not-found')
}

export async function ownWorkspace(db: Querier, userId: string, id: string): Promise<Workspace> {
  const rows = await db.query(
    `SELECT id, name, guest_root, volume_name, state FROM dsh_workspaces WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  const workspace = mapWorkspace(rows.rows[0])
  if (!workspace) throw new HttpError(404, 'not-found')
  return workspace
}

export async function listFiles(objects: ObjectStore, workspace: Workspace, requested: string) {
  const prefix = confine(workspace, requested || workspace.guestRoot)
  const page = await objects.list(prefix)
  const root = `${prefix}/`
  return {
    path: requested || workspace.guestRoot,
    truncated: page.truncated,
    entries: [
      ...page.directories.map((dir) => ({ name: leaf(dir, root), type: 'directory' as const })),
      ...page.files.map((file) => ({ name: leaf(file.key, root), type: 'file' as const, size: file.size })),
    ].filter((entry) => entry.name !== ''),
  }
}

export async function readFile(objects: ObjectStore, workspace: Workspace, requested: string) {
  if (!requested.trim()) throw new HttpError(422, 'path-required')
  const key = confine(workspace, requested)
  const body = await objects.get(key)
  if (!body) throw new HttpError(404, 'not-found')
  return { path: requested, bytes: body.length, content: body.toString('utf8') }
}

export async function writeFile(objects: ObjectStore, workspace: Workspace, requested: string, body: Buffer, contentType: string) {
  if (workspace.state === 'archived') throw new HttpError(409, 'workspace-archived')
  const key = confine(workspace, requested)
  await objects.put(key, body, contentType)
  return { path: requested, bytes: body.length }
}

function confine(workspace: Workspace, requested: string): string {
  try {
    return workspaceObjectKey(workspace.id, workspace.guestRoot, requested)
  } catch {
    throw new HttpError(422, 'path-outside-workspace')
  }
}

function leaf(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length).replace(/\/$/, '') : key
}

function mapWorkspace(row: unknown): Workspace | undefined {
  if (!row || typeof row !== 'object') return undefined
  const value = row as { id: string; name: string; guest_root: string; volume_name: string | null; state: string }
  return { id: value.id, name: value.name, guestRoot: value.guest_root, volumeName: value.volume_name, state: value.state }
}
