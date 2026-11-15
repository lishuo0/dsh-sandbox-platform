import type { IncomingMessage } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AppConfig } from '../config.js'

export interface BrainCall {
  userId: string
  workspaceId: string
  sessionId: string
  modelKey?: string
  modelBaseUrl?: string
  modelId?: string
}

/** 平台访问脑的唯一出口。各能力不自己拼地址和请求头。 */
export class BrainClient {
  constructor(private readonly cfg: AppConfig) {}

  openSession(input: BrainCall & { cwd: string }) {
    return this.json('/brain/v1/sessions', {
      ...input,
      method: 'POST',
      body: { cwd: input.cwd, sessionId: input.sessionId },
    })
  }

  sendMessage(input: BrainCall & { text: string; requestId: string }) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/messages`, {
      ...input,
      method: 'POST',
      body: { text: input.text, requestId: input.requestId },
    })
  }

  selectModel(input: BrainCall) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/model`, {
      ...input,
      method: 'POST',
      body: { modelId: input.modelId },
    })
  }

  cancel(input: BrainCall & { requestId: string }) {
    return this.json(`/brain/v1/sessions/${input.sessionId}/cancel`, {
      ...input,
      method: 'POST',
      body: { requestId: input.requestId },
    })
  }

  /**
   * 把脑上的实时事件原样转给浏览器。
   * 脑没接上时返回 false，调用方改从数据库补已经落库的历史。
   */
  async pipeEvents(input: BrainCall & { after: number }, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const deadline = Date.now() + 35_000
    let response: Response | undefined
    for (;;) {
      response = await this.fetch(`/brain/v1/sessions/${input.sessionId}/events?after=${input.after}`, input, 'GET')
      if (response.status !== 409 || Date.now() >= deadline) break
      await delay(2000)
    }
    if (!response || !response.ok || !response.body) return false
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const reader = response.body.getReader()
    const abort = () => void reader.cancel()
    req.on('close', abort)
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        res.write(chunk.value)
      }
    } finally {
      req.off('close', abort)
      res.end()
    }
    return true
  }

  private async json(
    path: string,
    init: BrainCall & { method: string; body?: unknown },
  ): Promise<{ ok: true } | { ok: false; status: number; code: string }> {
    const response = await this.fetch(path, init, init.method, init.body)
    if (response.ok) return { ok: true }
    const code = await response.text()
    return { ok: false, status: response.status, code: code.slice(0, 200) || 'brain-error' }
  }

  private async fetch(path: string, call: BrainCall, method: string, body?: unknown): Promise<Response> {
    const deadline = Date.now() + 35_000
    let response: Response | undefined
    for (;;) {
      try {
        response = await fetch(`${this.cfg.brain.baseUrl}${path}`, {
          method,
          headers: this.headers(call, body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch {
        return new Response('brain-unreachable', { status: 502 })
      }
      if (response.status !== 409 || Date.now() >= deadline || method === 'GET') return response
      await delay(2000)
    }
  }

  private headers(call: BrainCall, json: boolean): Record<string, string> {
    const oss = this.cfg.aliyun.oss
    const headers: Record<string, string> = {
      'x-app-id': this.cfg.brain.appId,
      'x-app-key': this.cfg.brain.appKey,
      'x-dsh-user-id': call.userId,
      'x-dsh-workspace-id': call.workspaceId,
      sessionid: call.sessionId,
    }
    if (json) headers['content-type'] = 'application/json'
    if (call.modelKey) headers['x-dsh-model-key'] = call.modelKey
    if (call.modelBaseUrl) headers['x-dsh-model-base-url'] = call.modelBaseUrl
    if (call.modelId) headers['x-dsh-model-id'] = call.modelId
    if (oss.bucket && oss.endpoint && oss.accessKeyId && oss.accessKeySecret) {
      headers['x-dsh-oss-bucket'] = oss.bucket
      headers['x-dsh-oss-endpoint'] = oss.endpoint
      headers['x-dsh-oss-region'] = oss.region
      headers['x-dsh-oss-access-key-id'] = oss.accessKeyId
      headers['x-dsh-oss-access-key-secret'] = oss.accessKeySecret
    }
    return headers
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
