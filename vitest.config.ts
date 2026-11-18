import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * 源码使用 NodeNext 风格（`./config.js` 实际是 config.ts）。
 * Vite 默认不会做这个映射，这里补一个预解析插件。
 */
const resolveTsFromJs = {
  name: 'resolve-ts-from-js',
  enforce: 'pre' as const,
  async resolveId(source: string, importer: string | undefined) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'))
    return existsSync(candidate) ? candidate : null
  },
}

export default defineConfig({
  plugins: [resolveTsFromJs],
  server: {
    fs: {
      // 联合 e2e 会直接 import 兄弟目录 dsh-sandbox-brain 的源码。
      allow: [resolve(root, '..')],
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: { reporter: ['text', 'html'] },
  },
})
