import { defineConfig } from 'vitest/config'
import base from './vitest.config'
import E2EProgressReporter from './test/helpers/e2e-progress-reporter'

const baseConfig = base as { test?: Record<string, unknown>; [key: string]: unknown }

/**
 * `npm run test:e2e` 用这个配置：在基础配置上加逐条进度播报，
 * 并给全链路用例留足超时（建工作区、起沙箱、等模型回复）。
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 文件串行：全链路用例本身重，并行时进度穿插反而看不清；串行后
    // 播报按文件顺序推进，失败也更容易定位。
    fileParallelism: false,
    reporters: [new E2EProgressReporter()],
  },
})
