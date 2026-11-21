import { decodeKey, type AppConfig } from '../config.js'
import { BrainClient } from '../brain/client.js'
import type { Db } from '../kernel/db.js'
import { createObjectStore, type ObjectStore } from '../kernel/objects.js'
import type { FeishuChat } from '../modules/superagent/feishu.js'

/** 进程启动时组装一次。模块只依赖这袋能力，不自己读配置文件。 */
export interface Deps {
  config: AppConfig
  db: Db
  objects: ObjectStore
  brain: BrainClient
  credentialsKey: Buffer
  /** 拉飞书群列表；测试换成假实现，不真的连飞书。 */
  feishuChats?: (credential: { appId: string; appSecret: string }) => Promise<FeishuChat[]>
}

export function createDeps(config: AppConfig, db: Db): Deps {
  return {
    config,
    db,
    objects: createObjectStore(config),
    brain: new BrainClient(config),
    credentialsKey: decodeKey(config.credentialsKey),
  }
}
