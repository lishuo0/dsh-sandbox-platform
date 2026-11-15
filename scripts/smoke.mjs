import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const config = readFileSync(resolve(root, 'config.yaml'), 'utf8')
const username = scalar(config, 'adminUsername') || 'admin'
const password = scalar(config, 'adminPassword')
const base = 'http://127.0.0.1:3000/dsh-api/platform/v1'

const health = await request('/health')
assert(health.status === 200 && health.json?.ok === true, '健康检查失败', health)

const login = await request('/auth/login', {
  method: 'POST',
  body: { username, password },
})
const token = login.json?.data?.accessToken
assert(login.status === 200 && token, '登录失败', login)

const workspace = await request('/workspaces', {
  method: 'POST',
  token,
  body: { name: '本地验证' },
})
const id = workspace.json?.data?.id
const guest = workspace.json?.data?.guestRoot
assert(workspace.status === 201 && id && guest, '创建工作区失败', workspace)

const path = `${guest}/hello.txt`
const write = await request(`/workspaces/${id}/files`, {
  method: 'PUT',
  token,
  body: { path, content: 'local-ok' },
})
assert(write.status === 201, '写入文件失败', write)

const read = await request(`/workspaces/${id}/files/content?path=${encodeURIComponent(path)}`, { token })
assert(read.status === 200 && read.json?.data?.content === 'local-ok', '读回文件失败', read)

const onDisk = readFileSync(resolve(root, 'var/objects/desks', id, 'hello.txt'), 'utf8')
assert(onDisk === 'local-ok', `磁盘上的文件不是 local-ok：${onDisk}`)

const model = await request('/settings/model', {
  method: 'PUT',
  token,
  body: {
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-local-smoke',
    modelIds: ['local-smoke'],
    defaultModel: 'local-smoke',
  },
})
assert(model.status === 200, '保存模型失败', model)

const session = await request('/sessions', {
  method: 'POST',
  token,
  body: { workspaceId: id, title: '本地验证' },
})
assert(session.status === 201 && session.json?.data?.createState === 'ready', '脑没有接上会话', session)

console.log(`smoke-ok workspace=${id} session=${session.json.data.id}`)

function scalar(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'))
  if (!match) return ''
  let value = match[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value
}

async function request(path, options = {}) {
  const headers = {}
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.body) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

function assert(ok, message, detail) {
  if (ok) return
  console.error(message)
  if (detail) console.error(JSON.stringify({ status: detail.status, body: detail.json ?? detail.text }, null, 2))
  process.exit(1)
}
