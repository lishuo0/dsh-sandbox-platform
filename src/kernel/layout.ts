/** 沙箱路径和对象前缀只在这里定义。新增存储时加一条，不要在各模块里再写死。 */

export function workspaceGuest(id: string): string {
  return `/desk/${id}`
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

export function privateSkillKey(userId: string, name: string): string {
  return `members/${userId}/skills/${name}/SKILL.md`
}

export function publicSkillKey(name: string): string {
  return `common/skills/${name}/SKILL.md`
}

/** 与脑的附件存储同一条前缀，换副本后仍能按摘要读到。 */
export function fileObjectKey(digest: string): string {
  return `attachments/v1/file-objects/${digest}`
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

/** 把沙箱里的工作区路径收成对象键。越出这块工作区就拒绝。 */
export function workspaceObjectKey(workspaceId: string, guestRoot: string, requested: string): string {
  const root = guestRoot.replace(/\/+$/, '')
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
