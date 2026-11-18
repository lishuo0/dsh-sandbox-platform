/** 沙箱路径和对象前缀只在这里定义。新增存储时加一条，不要在各模块里再写死。 */

/**
 * 每台沙箱里工作卷的固定挂载点，也是所有会话的 cwd。
 *
 * 一个工作区独占一台沙箱，沙箱里只有这块工作卷，所以路径不需要再按工作区区分；
 * 脑侧沙箱注册表把同一个值挂给每条会话。
 */
export const WORKSPACE_GUEST_ROOT = '/desk'

export function workspaceGuest(): string {
  return WORKSPACE_GUEST_ROOT
}

export function workspaceVolume(id: string): string {
  return `desk-${id}`
}

export function workspaceHost(userId: string, id: string): string {
  return `/var/agent-desk/${userId}/${id}`
}

export function workspacePrefix(id: string): string {
  return `desks/${id}`
}

/** 沙箱里的记忆目录，跟着工作卷走：`/desk/.dsh/memory`。 */
export const WORKSPACE_MEMORY_DIR = '.dsh/memory'

/** 工作区记忆的对象前缀，和沙箱里的 `/desk/.dsh/memory` 是同一块存储面。 */
export function workspaceMemoryPrefix(id: string): string {
  return `${workspacePrefix(id)}/${WORKSPACE_MEMORY_DIR}`
}

/** 个人记忆跨所有工作区，落在成员自己的空间里，不进任何沙箱工作卷。 */
export function personalMemoryPrefix(userId: string): string {
  return `members/${userId}/personal`
}

export function privateSkillDir(userId: string, name: string): string {
  return `members/${userId}/skills/${name}`
}

export function publicSkillDir(name: string): string {
  return `common/skills/${name}`
}

export function skillDir(scope: 'private' | 'public', userId: string, name: string): string {
  return scope === 'public' ? publicSkillDir(name) : privateSkillDir(userId, name)
}

export function privateSkillKey(userId: string, name: string): string {
  return `${privateSkillDir(userId, name)}/SKILL.md`
}

export function publicSkillKey(name: string): string {
  return `${publicSkillDir(name)}/SKILL.md`
}

/** 技能目录里的相对文件路径；拒绝绝对路径、反斜杠和 `..`。 */
export function isSkillFilePath(value: string): boolean {
  if (!value || value.length > 512 || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || value.endsWith('/')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function skillObjectKey(
  scope: 'private' | 'public',
  userId: string,
  name: string,
  path: string,
): string {
  return `${skillDir(scope, userId, name)}/${path}`
}

/** 与脑的附件存储同一条前缀，换副本后仍能按摘要读到。 */
export function fileObjectKey(digest: string): string {
  return `attachments/v1/file-objects/${digest}`
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

/** 把沙箱里的工作区路径收成对象键。每条工作区都挂在 WORKSPACE_GUEST_ROOT 下。 */
export function workspaceObjectKey(workspaceId: string, requested: string): string {
  const root = WORKSPACE_GUEST_ROOT
  const raw = (requested.trim() || root).replace(/\/+$/, '')
  if (raw !== root && !raw.startsWith(`${root}/`)) {
    throw new Error('path-outside-workspace')
  }
  const rest = raw === root ? '' : raw.slice(root.length + 1)
  const parts = rest === '' ? [] : rest.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('path-outside-workspace')
  }
  return [workspacePrefix(workspaceId), ...parts].join('/')
}
