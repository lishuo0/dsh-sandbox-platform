/**
 * E2E 进度播报 reporter。
 *
 * Vitest 默认只在文件跑完后打一行，跑真链路时中间长时间没有输出。这个
 * reporter 在 `test:e2e` 里替换默认 reporter，逐条播报：
 *
 * - 开始：几个文件
 * - 每个文件收集到多少用例（当前累计）
 * - 每条用例开始、通过 / 失败 / 跳过、耗时
 * - 每个文件结束：通过 / 失败 / 跳过、文件耗时
 * - 全部结束：总用例数、通过 / 失败 / 跳过、总耗时、失败清单
 *
 * 只依赖 vitest 的 Reporter 接口，平台和脑两个仓库各放一份（两边没有共享包）。
 */
import { relative } from 'node:path'
import type { Reporter, SerializedError, TestCase, TestModule, TestRunEndReason } from 'vitest/node'

const color = process.stdout.isTTY
const paint = (code: string, text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
const dim = (text: string): string => paint('2', text)
const green = (text: string): string => paint('32', text)
const red = (text: string): string => paint('31', text)
const yellow = (text: string): string => paint('33', text)
const cyan = (text: string): string => paint('36', text)

function time(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function shortFile(path: string): string {
  const relativePath = relative(process.cwd(), path)
  return relativePath.startsWith('..') ? path : relativePath
}

function firstLine(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message.split('\n')[0] ?? message
  }
  return String(error).split('\n')[0] ?? String(error)
}

interface Failure {
  name: string
  message: string
}

export default class E2EProgressReporter implements Reporter {
  private collected = 0
  private ready = 0
  private passed = 0
  private failed = 0
  private skipped = 0
  private startedAt = 0
  private readonly failures: Failure[] = []
  private readonly fileStart = new Map<string, number>()
  private readonly fileCount = new Map<string, { passed: number; failed: number; skipped: number }>()
  private readonly sequence = new Map<string, number>()

  onTestRunStart(specifications: ReadonlyArray<{ filepath: string }>): void {
    this.startedAt = Date.now()
    this.collected = this.ready = this.passed = this.failed = this.skipped = 0
    this.failures.length = 0
    this.fileStart.clear()
    this.fileCount.clear()
    console.log('')
    console.log(cyan('━━ E2E 开始 ━━'), `${specifications.length} 个测试文件，${dim('逐条播报中…')}`)
  }

  onTestModuleCollected(testModule: TestModule): void {
    const count = [...testModule.children.allTests()].length
    this.collected += count
    const name = shortFile(testModule.moduleId)
    this.fileStart.set(name, Date.now())
    this.fileCount.set(name, { passed: 0, failed: 0, skipped: 0 })
    console.log(`${cyan('📄')} ${name}：收集到 ${count} 个用例 ${dim(`（当前累计 ${this.collected}）`)}`)
  }

  onTestCaseReady(testCase: TestCase): void {
    this.ready += 1
    this.sequence.set(testCase.id, this.ready)
    const file = shortFile(testCase.module.moduleId)
    console.log(`${yellow('▶')} ${dim(`[${this.ready}/${this.collected}]`)} ${file} › ${testCase.fullName}`)
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    const file = shortFile(testCase.module.moduleId)
    const counts = this.fileCount.get(file) ?? { passed: 0, failed: 0, skipped: 0 }
    const elapsed = testCase.diagnostic()?.duration
    const duration = elapsed === undefined ? '' : time(elapsed)
    const index = this.sequence.get(testCase.id) ?? this.ready
    const label = `${dim(`[${index}/${this.collected}]`)} ${file} › ${testCase.fullName}`
    if (result.state === 'passed') {
      this.passed += 1
      counts.passed += 1
      console.log(`  ${green('✅ 通过')} ${label} ${dim(duration)}`)
    } else if (result.state === 'failed') {
      this.failed += 1
      counts.failed += 1
      const message = result.errors[0] === undefined ? '' : firstLine(result.errors[0])
      this.failures.push({ name: `${file} › ${testCase.fullName}`, message })
      console.log(`  ${red('❌ 失败')} ${label} ${dim(duration)}`)
      if (message) console.log(`     ${red(message)}`)
    } else if (result.state === 'skipped') {
      this.skipped += 1
      counts.skipped += 1
      console.log(`  ${dim(`⏭  跳过 ${label}`)}`)
    }
    this.fileCount.set(file, counts)
  }

  onTestModuleEnd(testModule: TestModule): void {
    const file = shortFile(testModule.moduleId)
    const counts = this.fileCount.get(file) ?? { passed: 0, failed: 0, skipped: 0 }
    const elapsed = Date.now() - (this.fileStart.get(file) ?? Date.now())
    const head = testModule.ok() ? green('✔ 文件完成') : red('✘ 文件有失败')
    console.log(`${head} ${file}：${green(`${counts.passed} 通过`)} / ${counts.failed ? red(`${counts.failed} 失败`) : '0 失败'} / ${counts.skipped} 跳过 ${dim(`（${time(elapsed)}）`)}`)
  }

  onTestRunEnd(
    _modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const elapsed = time(Date.now() - this.startedAt)
    const ok = this.failed === 0 && unhandledErrors.length === 0
    const head = ok ? green('━━ E2E 全部通过 ━━') : red('━━ E2E 有失败 ━━')
    console.log('')
    console.log(
      `${head} 共 ${this.collected} 个用例：${green(`${this.passed} 通过`)} / ` +
      `${this.failed ? red(`${this.failed} 失败`) : '0 失败'} / ${this.skipped} 跳过，用时 ${elapsed}` +
      `${this.ready < this.collected ? dim(`（未执行 ${this.collected - this.ready}）`) : ''}` +
      `${reason === 'failed' || reason === 'interrupted' ? red(`（${reason}）`) : ''}`,
    )
    if (unhandledErrors.length > 0) {
      console.log(red(`未处理错误 ${unhandledErrors.length} 个：`))
      for (const error of unhandledErrors) console.log(`  ${red(firstLine(error))}`)
    }
    if (this.failures.length > 0) {
      console.log(red('失败清单：'))
      for (const failure of this.failures) {
        console.log(`  ${red('•')} ${failure.name}`)
        if (failure.message) console.log(`    ${dim(failure.message)}`)
      }
    }
    console.log('')
  }

  onUserConsoleLog(log: { content: string }): void {
    process.stdout.write(log.content.endsWith('\n') ? log.content : `${log.content}\n`)
  }
}
