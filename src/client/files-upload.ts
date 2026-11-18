/**
 * 工作区文件树的上传入口。
 *
 * 官方文件页的页头只有刷新 / 搜索，没有上传；平台在 `[data-files-page]` 的
 * 页头插一个同款工具按钮，选中的文件按当前会话和当前目录 POST 到
 * `P/workspaceFiles/upload`。平台把字节写进工作区的对象前缀，沙箱的
 * `/desk` 挂载点立刻就能看到，上传完自动点一次官方刷新。
 */

import { readFileSync } from 'node:fs'

const RUNTIME = readFileSync(new URL('./files-upload-client.js', import.meta.url), 'utf8')

export function filesUpload(): string {
  return `<script>\n${RUNTIME}\n</script>`
}
