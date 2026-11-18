import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readUploadBody } from '../../src/modules/workspaces/upload.js'

/**
 * 上传请求体的读取规则：超限立刻停；连接中途断开或字节数和
 * Content-Length 对不上时按中断处理，绝不能把半截文件写进工作区。
 */

function request(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers }) as unknown as IncomingMessage
}

function brokenRequest(headers: Record<string, string> = {}): IncomingMessage {
  const stream = new Readable({ read() {} })
  stream.push(Buffer.from('abcd'))
  process.nextTick(() => stream.destroy(new Error('aborted')))
  return Object.assign(stream, { headers }) as unknown as IncomingMessage
}

describe('readUploadBody', () => {
  it('读完整请求体', async () => {
    const read = await readUploadBody(request([Buffer.from('hello'), Buffer.from(' world')], { 'content-length': '11' }), 64)
    expect(read).toEqual({ ok: true, body: Buffer.from('hello world') })
  })

  it('Content-Length 超限时不读请求体', async () => {
    expect(await readUploadBody(request([Buffer.from('x')], { 'content-length': '65' }), 64)).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('没有 Content-Length 时按实际字节数拦截', async () => {
    expect(await readUploadBody(request([Buffer.from('a'.repeat(40)), Buffer.from('b'.repeat(40))]), 64)).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('没有 Content-Length 的分块请求照常接受', async () => {
    expect(await readUploadBody(request([Buffer.from('chunk')]), 64)).toEqual({
      ok: true,
      body: Buffer.from('chunk'),
    })
  })

  it('连接中途断开按中断处理', async () => {
    expect(await readUploadBody(brokenRequest({ 'content-length': '10' }), 64)).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })

  it('字节数和 Content-Length 不符按中断处理', async () => {
    expect(await readUploadBody(request([Buffer.from('abcd')], { 'content-length': '10' }), 64)).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })
})
