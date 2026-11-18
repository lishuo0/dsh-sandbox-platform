import { describe, expect, it } from 'vitest'
import { imageSize } from '../../src/client/upload.js'

/**
 * `P/upload` 回给客户端的图片尺寸：只读头部，不解析整图。
 * 四种可粘贴类型都要能读出宽高；扩展名和 Content-Type 都不采信。
 */

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10)
  bytes.write('GIF89a', 0, 'latin1')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function jpeg(width: number, height: number): Buffer {
  // FFD8 + SOF0 段：标记、长度、精度、高、宽再补齐到可以扫描的 12 字节。
  const bytes = Buffer.alloc(16)
  bytes.writeUInt16BE(0xffd8, 0)
  bytes.writeUInt16BE(0xffc0, 2)
  bytes.writeUInt16BE(17, 4)
  bytes[6] = 8
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

function webpVp8(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'latin1')
  bytes.write('WEBP', 8, 'latin1')
  bytes.write('VP8 ', 12, 'latin1')
  Buffer.from([0x9d, 0x01, 0x2a]).copy(bytes, 23)
  bytes.writeUInt16LE(width, 26)
  bytes.writeUInt16LE(height, 28)
  return bytes
}

function webpVp8l(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'latin1')
  bytes.write('WEBP', 8, 'latin1')
  bytes.write('VP8L', 12, 'latin1')
  bytes[20] = 0x2f
  const bits = ((height - 1) << 14) | (width - 1)
  bytes.writeUInt32LE(bits >>> 0, 21)
  return bytes
}

function webpVp8x(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'latin1')
  bytes.write('WEBP', 8, 'latin1')
  bytes.write('VP8X', 12, 'latin1')
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

describe('上传图片尺寸探测', () => {
  it('PNG 读 IHDR 的宽高', () => {
    expect(imageSize(png(3, 2))).toEqual({ mediaType: 'image/png', width: 3, height: 2 })
  })

  it('GIF 读逻辑屏幕的宽高（小端）', () => {
    expect(imageSize(gif(7, 5))).toEqual({ mediaType: 'image/gif', width: 7, height: 5 })
  })

  it('JPEG 跳到 SOF0 再读宽高', () => {
    expect(imageSize(jpeg(640, 480))).toEqual({ mediaType: 'image/jpeg', width: 640, height: 480 })
  })

  it('WebP 三种子格式都能读', () => {
    expect(imageSize(webpVp8(320, 200))).toEqual({ mediaType: 'image/webp', width: 320, height: 200 })
    expect(imageSize(webpVp8l(5, 6))).toEqual({ mediaType: 'image/webp', width: 5, height: 6 })
    expect(imageSize(webpVp8x(1280, 720))).toEqual({ mediaType: 'image/webp', width: 1280, height: 720 })
  })

  it('非图片或残缺头部返回 undefined', () => {
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined()
    expect(imageSize(Buffer.alloc(0))).toBeUndefined()
    expect(imageSize(png(1, 1).subarray(0, 12))).toBeUndefined()
  })
})
