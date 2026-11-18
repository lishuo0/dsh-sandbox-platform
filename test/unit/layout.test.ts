import { describe, expect, it } from 'vitest'
import {
  fileObjectKey,
  isSlug,
  privateSkillKey,
  publicSkillKey,
  WORKSPACE_GUEST_ROOT,
  workspaceGuest,
  workspaceHost,
  workspaceObjectKey,
  workspacePrefix,
  workspaceVolume,
} from '../../src/kernel/layout.js'

describe('layout', () => {
  it('每个沙箱都用同一个工作卷挂载点', () => {
    expect(WORKSPACE_GUEST_ROOT).toBe('/desk')
    expect(workspaceGuest()).toBe('/desk')
    expect(workspaceVolume('w1')).toBe('desk-w1')
    expect(workspaceHost('u1', 'w1')).toBe('/var/agent-desk/u1/w1')
    expect(workspacePrefix('w1')).toBe('desks/w1')
  })

  it('技能与附件对象键', () => {
    expect(privateSkillKey('u1', 'report')).toBe('members/u1/skills/report/SKILL.md')
    expect(publicSkillKey('report')).toBe('common/skills/report/SKILL.md')
    expect(fileObjectKey('abc123')).toBe('attachments/v1/file-objects/abc123')
  })

  it('slug 规则', () => {
    expect(isSlug('my-skill')).toBe(true)
    expect(isSlug('skill1')).toBe(true)
    expect(isSlug('a')).toBe(true)
    expect(isSlug('My-Skill')).toBe(false)
    expect(isSlug('-skill')).toBe(false)
    expect(isSlug('skill-')).toBe(false)
    expect(isSlug('skill--name')).toBe(false)
    expect(isSlug('skill name')).toBe(false)
    expect(isSlug('')).toBe(false)
  })

  it('workspaceObjectKey 把同一个 /desk 路径收进各自工作区的对象前缀', () => {
    expect(workspaceObjectKey('w1', '/desk')).toBe('desks/w1')
    expect(workspaceObjectKey('w1', '/desk/')).toBe('desks/w1')
    expect(workspaceObjectKey('w1', '/desk/src/main.ts')).toBe('desks/w1/src/main.ts')
    expect(workspaceObjectKey('w1', '')).toBe('desks/w1')
    expect(workspaceObjectKey('w2', '/desk/src/main.ts')).toBe('desks/w2/src/main.ts')
  })

  it('workspaceObjectKey 拒绝越界路径', () => {
    expect(() => workspaceObjectKey('w1', '/desk/../w2')).toThrow('path-outside-workspace')
    expect(() => workspaceObjectKey('w1', '/desk/./x')).toThrow('path-outside-workspace')
    expect(() => workspaceObjectKey('w1', '/desk//x')).toThrow('path-outside-workspace')
    expect(() => workspaceObjectKey('w1', '/etc/passwd')).toThrow('path-outside-workspace')
  })
})
