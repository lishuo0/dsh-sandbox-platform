/** 拆 WebSocket 帧，好按会话归属丢掉不该看见的文本消息。 */

export interface RawFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  raw: Buffer
}

export function decodeFrames(buffer: Buffer): { frames: RawFrame[]; rest: Buffer } {
  const frames: RawFrame[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] ?? 0
    const second = buffer[offset + 1] ?? 0
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let header = 2
    if (length === 126) {
      if (offset + 4 > buffer.length) break
      length = buffer.readUInt16BE(offset + 2)
      header = 4
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break
      const wide = buffer.readBigUInt64BE(offset + 2)
      if (wide > BigInt(8 * 1024 * 1024)) throw new Error('websocket frame is too large')
      length = Number(wide)
      header = 10
    }
    const maskLen = masked ? 4 : 0
    const total = header + maskLen + length
    if (offset + total > buffer.length) break
    const payload = Buffer.from(buffer.subarray(offset + header + maskLen, offset + total))
    if (masked) {
      const mask = buffer.subarray(offset + header, offset + header + 4)
      for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
    }
    frames.push({
      fin,
      opcode,
      payload,
      raw: Buffer.from(buffer.subarray(offset, offset + total)),
    })
    offset += total
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) }
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const head = 0x80 | opcode
  if (payload.length < 126) return Buffer.concat([Buffer.from([head, payload.length]), payload])
  if (payload.length < 65536) {
    const prefix = Buffer.alloc(4)
    prefix[0] = head
    prefix[1] = 126
    prefix.writeUInt16BE(payload.length, 2)
    return Buffer.concat([prefix, payload])
  }
  const prefix = Buffer.alloc(10)
  prefix[0] = head
  prefix[1] = 127
  prefix.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([prefix, payload])
}

export type Assembled =
  | { kind: 'raw'; frames: RawFrame[] }
  | { kind: 'text'; text: string; raw: Buffer }

/** 把分片收成一条消息。控制帧原样穿过去。 */
export class MessagePump {
  private parts: RawFrame[] = []

  push(frame: RawFrame): Assembled[] {
    if (frame.opcode >= 8) return [{ kind: 'raw', frames: [frame] }]
    const ready: Assembled[] = []
    if (frame.opcode !== 0 && this.parts.length > 0) ready.push(this.flush())
    if (frame.opcode === 0 && this.parts.length === 0) return [{ kind: 'raw', frames: [frame] }]
    this.parts.push(frame)
    if (frame.fin) ready.push(this.flush())
    return ready
  }

  private flush(): Assembled {
    const parts = this.parts
    this.parts = []
    const opcode = parts[0]?.opcode ?? 0
    if (opcode !== 1) return { kind: 'raw', frames: parts }
    return {
      kind: 'text',
      text: Buffer.concat(parts.map((part) => part.payload)).toString('utf8'),
      raw: Buffer.concat(parts.map((part) => part.raw)),
    }
  }
}
