/**
 * 浏览器流里的一条会话事件。
 *
 * `surfaceOp`/`sourceEventSeqs` 是持久日志的表面元数据：上游 session store
 * 要求 surface 事件（system/user/assistant/tool）必须带 `surfaceOp`，否则整段
 * 历史会被拒绝（`requires a surfaceOp marker`）。快照、增量与分页必须用同一个
 * 构造函数，否则重连后先看历史、再收增量时两套形状对不上。
 */
export interface WireEventSource {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: unknown
  readonly ignorable?: unknown
  readonly sourceEventSeqs?: unknown
  readonly surfaceOp?: unknown
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function wireEventOf(event: WireEventSource): Record<string, unknown> {
  const type = typeof event.type === 'string' && event.type !== '' ? event.type : 'unknown'
  return {
    type,
    seq: finite(event.seq) ?? 0,
    time: finite(event.time) ?? Date.now(),
    data: event.data ?? null,
    ...(event.ignorable === true ? { ignorable: true } : {}),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  }
}

/**
 * 一页事件的尾游标：页内最大 seq，空页返回 -1（与上游 `emptyCursor` 一致）。
 *
 * follow 快照的 `cursor` 必须等于这个值，否则浏览器 journal 校验
 * `page did not end at its requested cursor` 会拒绝整段历史。
 */
export function tailSeqOf(events: readonly WireEventSource[]): number {
  let tail = -1
  for (const event of events) {
    const seq = finite(event.seq)
    if (seq !== undefined && seq > tail) tail = seq
  }
  return tail
}

/** 会话事件流里的一帧：`{type:'event', event}`。 */
export function eventRecordOf(event: WireEventSource): Record<string, unknown> {
  return { type: 'event', event: wireEventOf(event) }
}

/**
 * 把脑回放的事件接在页尾。
 *
 * 只接受从 `tail + 1` 开始连续的一段：宁可不补，也不能把带空洞的日志交给
 * 浏览器——journal 的 `follows` 校验要求相邻 seq，空洞会再次触发修复页。
 */
export function appendContiguous<T extends { readonly seq: number }>(
  base: readonly T[],
  extra: readonly T[],
  tail: number,
): T[] {
  const ordered = extra
    .filter(event => event.seq > tail)
    .sort((left, right) => left.seq - right.seq)
  const merged = [...base]
  let next = tail + 1
  for (const event of ordered) {
    if (event.seq < next) continue
    if (event.seq !== next) break
    merged.push(event)
    next += 1
  }
  return merged
}
