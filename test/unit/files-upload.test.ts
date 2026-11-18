import { describe, expect, it } from 'vitest'
import { filesUpload } from '../../src/client/files-upload.js'

/**
 * 文件树上传入口的注入脚本。
 *
 * 会话 id 挂在 `data-sidebar-right-session` 上；closest 用 CSS 选择器，
 * getAttribute 必须用属性名。混用会读不到会话，上传直接失败。
 */
describe('工作区文件上传入口', () => {
  const html = filesUpload()

  it('挂在文件页页头，点刷新前插入上传按钮', () => {
    expect(html).toContain('data-files-page')
    expect(html).toContain('data-files-reload')
    expect(html).toContain('data-files-upload')
    expect(html).toContain('/dsh-api/platform/v1/workspaceFiles/upload')
    expect(html).toContain('上传文件')
  })

  it('读会话 id 用属性名，不用带方括号的选择器', () => {
    expect(html).toContain("const SESSION_ATTR = 'data-sidebar-right-session'")
    expect(html).toContain('getAttribute(SESSION_ATTR)')
    expect(html).not.toMatch(/getAttribute\(SESSION\)/)
  })

  it('大文件用 XHR 上报进度，能显示百分比并取消', () => {
    expect(html).toContain('new XMLHttpRequest()')
    expect(html).toContain("xhr.upload.addEventListener('progress'")
    expect(html).toContain('data-files-upload-bar')
    expect(html).toContain('data-files-upload-cancel')
    expect(html).toContain('data-files-upload-meta')
    expect(html).toContain('正在上传')
    expect(html).toContain('aria-valuenow')
    expect(html).toContain('activeXhr.abort()')
  })

  it('文件名只走 textContent，不拼进 innerHTML', () => {
    expect(html).toContain('view.name.textContent = file.name')
    expect(html).not.toMatch(/innerHTML\s*=\s*[^;]*file\.name/)
  })
})
