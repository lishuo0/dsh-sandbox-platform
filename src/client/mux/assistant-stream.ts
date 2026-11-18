/**
 * 浏览器面的助手流 revision。
 *
 * 客户端把 `assistant-stream` 的 `revision` 当成**整条会话流**的连续性标记：
 * 开篇快照给出基线 R，之后每一帧必须恰好 R+1、R+2……否则判定丢帧并断开整条
 * 会话流（`session assistant stream skipped revision N`）。
 *
 * 脑的 `revision` 是 Agent 实例级计数，跨回合不重置，而且平台是在会话中途
 * 接入上游的：既拿不到历史计数值，也不负责保证它连续。平台是浏览器这条逻辑
 * 流的唯一生产者，所以这里按「每条 `session/follow` 通道」维护自己的序号：
 * 快照固定从 0 开始，之后按到达顺序 1、2、3……重新编号。断线重连会开新通道、
 * 从 0 重新开始，与新的快照一一对应。
 *
 * 其余字段（attemptId/turn/step/index/startedAfterSeq/outcome）原样透传，
 * 客户端靠它们拼接尝试与结算。
 */

/** 快照里的助手流基线；通道本地编号从这里开始。 */
export const EMPTY_ASSISTANT_STREAM: { readonly revision: number } = { revision: 0 }

/** 一条 `session/follow` 通道的助手流编号器。 */
export interface AssistantStreamRevisions {
  /**
   * 把一帧脑侧助手流换成浏览器 wire 形态。
   * @param frame - 脑侧 `stream` 帧的 `frame` 字段。
   * @returns 同一帧，`revision` 换成通道本地序号。
   */
  next(frame: Readonly<Record<string, unknown>>): Record<string, unknown>
}

/**
 * 创建一条通道的编号器。
 * @returns 从 0 开始、每次 `next` 自增 1 的编号器。
 */
export function createAssistantStreamRevisions(): AssistantStreamRevisions {
  let revision = 0
  return {
    next(frame) {
      revision += 1
      return { ...frame, revision }
    },
  }
}
