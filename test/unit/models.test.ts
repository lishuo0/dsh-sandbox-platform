import { describe, expect, it } from 'vitest'
import {
  asProtocol,
  DEFAULT_MODEL_PROTOCOL,
  MODEL_PROTOCOLS,
  normalizeBaseUrl,
} from '../../src/modules/models/service.js'

describe('模型地址归一', () => {
  it('https 地址原样保留，去掉末尾斜杠', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('  https://api.example.com  ')).toBe('https://api.example.com')
  })

  it('本机与内网允许 http', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1')
    expect(normalizeBaseUrl('http://192.168.1.20:11434/v1')).toBe('http://192.168.1.20:11434/v1')
    expect(normalizeBaseUrl('http://172.20.0.5/v1')).toBe('http://172.20.0.5/v1')
    expect(normalizeBaseUrl('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1')
  })

  it('公网 http、非法协议、坏地址都拒绝', () => {
    expect(normalizeBaseUrl('http://api.example.com/v1')).toBeUndefined()
    expect(normalizeBaseUrl('http://172.32.0.5/v1')).toBeUndefined()
    expect(normalizeBaseUrl('ftp://api.example.com/v1')).toBeUndefined()
    expect(normalizeBaseUrl('api.example.com/v1')).toBeUndefined()
    expect(normalizeBaseUrl('')).toBeUndefined()
  })

  it('带账号密码的地址拒绝', () => {
    expect(normalizeBaseUrl('https://user:pass@api.example.com/v1')).toBeUndefined()
  })
})

describe('上游协议', () => {
  it('四种协议都认，不传就用默认的 OpenAI 兼容', () => {
    for (const protocol of MODEL_PROTOCOLS) expect(asProtocol(protocol)).toBe(protocol)
    expect(asProtocol(undefined)).toBe(DEFAULT_MODEL_PROTOCOL)
    expect(asProtocol(null)).toBe(DEFAULT_MODEL_PROTOCOL)
    expect(asProtocol('')).toBe(DEFAULT_MODEL_PROTOCOL)
  })

  it('不认识的协议 422，不能静默按 OpenAI 兼容处理', () => {
    expect(() => asProtocol('openai')).toThrowError(
      expect.objectContaining({ status: 422, code: 'model-protocol-invalid' }),
    )
  })
})
