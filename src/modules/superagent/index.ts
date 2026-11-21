/**
 * 自动化接入的进程内入口：渠道长连接 + 漏消息补偿 + 回信投递 + 工单执行。
 *
 * 和定时任务循环一样只在平台的一个副本上跑。
 *
 * @module platform/modules/superagent
 */

import type { Deps } from '../../app/deps.js'
import { startCatchupLoop } from './catchup.js'
import { replicaOwner, startChannels, syncChannels, type Channels } from './connector.js'
import { startDeliveryLoop } from './delivery.js'
import { startExecuteLoop } from './execute.js'
import { intakeDefaults } from './intake.js'

/** 每隔一段时间对齐一次渠道：成员刚加上的机器人不用等重启。 */
const RESYNC_MS = 30_000

export interface Superagent {
  channels: Channels
  stop(): void
}

export function startSuperagent(deps: Deps): Superagent {
  const owner = replicaOwner()
  const channels = startChannels(deps)
  const stopDelivery = startDeliveryLoop(deps, channels, owner)
  const stopCatchup = startCatchupLoop(
    {
      db: deps.db,
      credentialsKey: deps.credentialsKey,
      brain: deps.brain,
      superagentDefaults: intakeDefaults(deps.config?.superagent),
    },
    channels,
  )
  const stopExecute = startExecuteLoop(
    { db: deps.db, objects: deps.objects, brain: deps.brain, credentialsKey: deps.credentialsKey },
    owner,
  )
  const timer = setInterval(() => syncChannels(), RESYNC_MS)
  timer.unref()
  return {
    channels,
    stop() {
      clearInterval(timer)
      stopCatchup()
      stopDelivery()
      stopExecute()
      channels.stopAll()
    },
  }
}
