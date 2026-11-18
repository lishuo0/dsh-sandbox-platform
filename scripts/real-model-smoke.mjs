/**
 * 真实模型端到端冒烟：登录 → 存模型配置 → 建技能 → 建工作区 → 开会话 → 发消息 → 等 assistant。
 *
 * 只在本地联调时手动运行：DSH_REAL_MODEL_SMOKE=1 node scripts/real-model-smoke.mjs
 *
 * 环境变量：
 *   DSH_REAL_MODEL_SMOKE=1     必填，否则直接退出
 *   DSH_MODEL_BASE_URL         模型接口地址（https）；与下面几项一起给时先保存为配置
 *   DSH_MODEL_IDS              模型名，逗号分隔
 *   DSH_MODEL_DEFAULT          默认模型名；省略时用 DSH_MODEL_IDS 的第一个
 *   DSH_MODEL_KEY              模型密钥；已经保存过密钥时可以省略
 *   DSH_REAL_MODEL_TIMEOUT_MS  等待 assistant 的超时（默认 120000）
 *
 * 不给 DSH_MODEL_* 时，要求该用户已经在 /settings/model 配好模型。
 * 本脚本从不读取或打印 key。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const config = readFileSync(resolve(root, 'config.yaml'), 'utf8')
const username = scalar(config, 'adminUsername') || 'admin'
const password = scalar(config, 'adminPassword')
const base = 'http://127.0.0.1:3000/dsh-api/platform/v1'
const timeoutMs = Number(process.env.DSH_REAL_MODEL_TIMEOUT_MS ?? 120_000)

if (process.env.DSH_REAL_MODEL_SMOKE !== '1') {
  console.log('跳过：设置 DSH_REAL_MODEL_SMOKE=1 后才会调用真实模型。')
  process.exit(0)
}

const health = await request('/health')
if (health.status !== 200 || health.json?.ok !== true) {
  console.log('跳过：本地栈未启动。先运行 ./scripts/dev.sh start，再重试。')
  process.exit(0)
}

const login = await request('/auth/login', { method: 'POST', body: { username, password } })
const token = login.json?.data?.accessToken
if (login.status !== 200 || !token) fail('登录失败（检查 config.yaml 的 adminUsername/adminPassword）', login)

await ensureModel()

const model = await request('/settings/model', { token })
if (model.status !== 200) fail('读取模型配置失败', model)
if (model.json?.data?.configured !== true) {
  console.log('跳过：该用户尚未配置模型。在命令里带上 DSH_MODEL_BASE_URL、DSH_MODEL_IDS、DSH_MODEL_KEY，或先 POST /settings/model。')
  process.exit(0)
}
const activeProvider = model.json.data.providers?.find((provider) => provider.configured) ?? model.json.data.providers?.[0]
console.log(`model=${activeProvider?.defaultModel ?? ''}`)

const skillName = 'smoke-answer'
const skill = await request('/skills', {
  method: 'POST',
  token,
  body: {
    name: skillName,
    description: '本地真实模型联调技能：把结果写入 smoke-answer.txt',
    skillMd: [
      `# ${skillName}`,
      '',
      '当用户要求你使用本技能时，在当前工作区用 shell 执行：',
      '',
      '```sh',
      'printf ok > smoke-answer.txt',
      '```',
      '',
      '执行后简短回复「已完成」。',
      '',
    ].join('\n'),
    scope: 'private',
  },
})
if (skill.status !== 201) fail('创建技能失败', skill)
console.log(`skill=${skillName}`)

const workspace = await request('/workspaces', {
  method: 'POST',
  token,
  body: { name: `真实模型联调 ${new Date().toISOString()}` },
})
const workspaceId = workspace.json?.data?.id
const guest = workspace.json?.data?.guestRoot
if (workspace.status !== 201 || !workspaceId || !guest) fail('创建工作区失败', workspace)
console.log(`workspace=${workspaceId}`)

const session = await request('/sessions', {
  method: 'POST',
  token,
  body: { workspaceId, title: '真实模型联调' },
})
const sessionId = session.json?.data?.id
if (session.status !== 201 || session.json?.data?.createState !== 'ready' || !sessionId) {
  fail('脑没有接上会话（检查 var/log/brain.log 与 8080 端口）', session)
}
console.log(`session=${sessionId}`)

const message = await request(`/sessions/${sessionId}/messages`, {
  method: 'POST',
  token,
  body: { text: `请立刻使用 ${skillName} 技能执行它，完成后回复。` },
})
if (message.status !== 202) fail('投递消息失败', message)

let outcome
try {
  outcome = await waitForAssistant(sessionId)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
console.log(`events=${outcome.seen.join(',')}`)
console.log(`assistant=${outcome.kind}`)

// The first assistant frame arrives before the skill's shell step runs, so give
// the turn a short window to finish before judging the workspace file.
const file = await waitForWorkspaceFile(workspaceId, guest, 20)
if (file !== undefined) {
  console.log(`workspace-file=smoke-answer.txt content=${JSON.stringify(file)}`)
} else {
  console.log('提示：工作区里没有 smoke-answer.txt（模型可能没有执行技能），不影响本次判定。')
}

console.log(`real-model-smoke-ok session=${sessionId}`)

/** 命令里带了 DSH_MODEL_* 就先保存；否则沿用用户已有的配置。 */
async function ensureModel() {
  const baseUrl = process.env.DSH_MODEL_BASE_URL?.trim()
  const modelIds = (process.env.DSH_MODEL_IDS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const apiKey = process.env.DSH_MODEL_KEY?.trim()
  if (!baseUrl && modelIds.length === 0 && apiKey === undefined) return
  if (!baseUrl) fail('设置了模型环境变量但缺少 DSH_MODEL_BASE_URL')
  if (modelIds.length === 0) fail('设置了模型环境变量但缺少 DSH_MODEL_IDS（逗号分隔）')
  const defaultModel = process.env.DSH_MODEL_DEFAULT?.trim() || modelIds[0]
  if (!modelIds.includes(defaultModel)) fail(`DSH_MODEL_DEFAULT 必须是 DSH_MODEL_IDS 之一：${defaultModel}`)
  // 多提供商页面：已有提供商就更新第一项，没有就新建。
  const current = await request('/settings/model', { token })
  if (current.status !== 200) fail('读取模型配置失败', current)
  const first = current.json?.data?.providers?.[0]
  const body = { baseUrl, modelIds, defaultModel, ...(apiKey ? { apiKey } : {}) }
  const saved = first
    ? await request(`/settings/model/${encodeURIComponent(first.id)}`, { method: 'PUT', token, body })
    : await request('/settings/model', { method: 'POST', token, body })
  if (saved.status !== 200) fail('保存模型配置失败（已有 key 时可省略 DSH_MODEL_KEY）', saved)
  console.log(`model-configured-by-env default=${defaultModel}`)
}

/** 读平台 SSE，直到看到落库的 assistant 事件或实时 assistant 分片。 */
async function waitForAssistant(sessionId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const seen = []
  try {
    const response = await fetch(`${base}/sessions/${sessionId}/events?after=-1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (response.status !== 200) fail('事件流连接失败', { status: response.status, text: await response.text() })
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = parseFrame(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        if (!frame) continue
        if (frame.event === 'event') {
          const envelope = safeJson(frame.data)
          seen.push(`event:${envelope?.type ?? 'unknown'}`)
          if (envelope?.type === 'assistant') return { kind: 'committed', seen }
        } else if (frame.event === 'assistant') {
          seen.push('assistant-chunk')
          return { kind: 'stream', seen }
        } else {
          seen.push(frame.event)
        }
      }
    }
    fail(`事件流在收到 assistant 之前结束了（已见：${seen.join(',') || '无'}）`)
  } catch (error) {
    if (controller.signal.aborted) {
      fail(`等待模型响应超时（${timeoutMs}ms）。查看 var/log/brain.log 与模型的网络连通性。`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** 轮询工作区文件，最多 `attempts` 次；返回内容或 undefined。 */
async function waitForWorkspaceFile(workspaceId, guest, attempts) {
  const path = encodeURIComponent(`${guest}/smoke-answer.txt`)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const file = await request(`/workspaces/${workspaceId}/files/content?path=${path}`, { token })
    if (file.status === 200) return file.json?.data?.content ?? ''
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return undefined
}

/** 解析一个 SSE 帧的 `event:` / `data:` 行。 */
function parseFrame(raw) {
  let event = 'message'
  let data = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return undefined
  return { event, data }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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

function fail(message, detail) {
  console.error(message)
  if (detail) console.error(JSON.stringify({ status: detail.status, body: detail.json ?? detail.text }, null, 2))
  process.exit(1)
}
