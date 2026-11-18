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

const objectDir = process.env.DSH_OBJECT_DIR ? resolve(process.env.DSH_OBJECT_DIR) : resolve(root, 'var/objects')
const onDisk = readFileSync(resolve(objectDir, 'desks', id, 'hello.txt'), 'utf8')
assert(onDisk === 'local-ok', `磁盘上的文件不是 local-ok：${onDisk}`)

await configureModel()

const session = await request('/sessions', {
  method: 'POST',
  token,
  body: { workspaceId: id, title: '本地验证' },
})
assert(session.status === 201 && session.json?.data?.createState === 'ready', '脑没有接上会话', session)

console.log(`smoke-ok workspace=${id} session=${session.json.data.id}`)

/**
 * 配置模型时不影响用户已有的真实配置：显式环境变量优先，否则沿用已配置的
 * 模型，只有完全没有配置时才写入占位值并告警。
 */
async function configureModel() {
  const baseUrl = process.env.DSH_MODEL_BASE_URL?.trim()
  const modelIds = (process.env.DSH_MODEL_IDS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const apiKey = process.env.DSH_MODEL_KEY?.trim()
  // 多提供商页面：已有提供商就更新第一项，没有就新建。
  const current = await request('/settings/model', { token })
  assert(current.status === 200, '读取模型配置失败', current)
  const first = current.json?.data?.providers?.[0]
  const save = (body) => first
    ? request(`/settings/model/${encodeURIComponent(first.id)}`, { method: 'PUT', token, body })
    : request('/settings/model', { method: 'POST', token, body })

  if (baseUrl || modelIds.length > 0 || apiKey) {
    assert(baseUrl, '设置了模型环境变量但缺少 DSH_MODEL_BASE_URL')
    assert(modelIds.length > 0, '设置了模型环境变量但缺少 DSH_MODEL_IDS（逗号分隔）')
    const defaultModel = process.env.DSH_MODEL_DEFAULT?.trim() || modelIds[0]
    assert(modelIds.includes(defaultModel), `DSH_MODEL_DEFAULT 必须是 DSH_MODEL_IDS 之一：${defaultModel}`)
    const body = { baseUrl, modelIds, defaultModel }
    if (apiKey) body.apiKey = apiKey
    const saved = await save(body)
    assert(saved.status === 200, '按环境变量保存模型失败（已有 key 时可省略 DSH_MODEL_KEY）', saved)
    console.log(`model-configured-by-env default=${defaultModel}`)
    return
  }
  if (current.json?.data?.configured === true) {
    console.log(`model-reused default=${first?.defaultModel ?? ''}`)
    return
  }
  console.warn('警告：该用户尚未配置模型，写入占位配置。真实对话不可用；请通过 /settings/model 或 DSH_MODEL_* 环境变量配置。')
  const placeholder = await save({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-local-smoke',
    modelIds: ['local-smoke'],
    defaultModel: 'local-smoke',
  })
  assert(placeholder.status === 200, '保存占位模型失败', placeholder)
}

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
