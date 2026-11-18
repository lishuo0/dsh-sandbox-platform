import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 配置里没写数据库时用的本地 SQLite 文件，和 `src/config.ts` 保持一致。 */
const DEFAULT_DATABASE_FILE = 'var/dsh.sqlite'

const platformFile = resolve(import.meta.dirname, '..', 'config.yaml')

if (process.argv.includes('--db')) {
  console.log(describeDatabase(readFileSync(platformFile, 'utf8')))
  process.exit(0)
}

const platform = readFileSync(platformFile, 'utf8')

const tokenSecret = present(platform, 'tokenSecret') || randomBytes(24).toString('hex')
const adminPassword = present(platform, 'adminPassword') || randomBytes(9).toString('hex')
const credentialsKey = present(platform, 'credentialsKey') || randomBytes(32).toString('base64')
const appKey = present(platform, 'appKey') || randomBytes(18).toString('hex')

const generatedKeys = !present(platform, 'credentialsKey') || !present(platform, 'appKey')
writeFileSync(
  platformFile,
  fill(fill(fill(fill(platform, 'tokenSecret', tokenSecret), 'adminPassword', adminPassword), 'credentialsKey', credentialsKey), 'appKey', appKey),
)

const written = readFileSync(platformFile, 'utf8')
console.log(`admin=${scalar(written, 'adminUsername') || 'admin'}`)
console.log(`password=${scalar(written, 'adminPassword')}`)
console.log(`db=${describeDatabase(written)}`)
if (generatedKeys) {
  console.log('已生成 credentialsKey / brain.appKey。脑的 config.yaml 里 credentialsKey 和 platform.appKey 必须填同一组值。')
}

/** 有 file 用该 SQLite；有 url 用 PostgreSQL；都没写则用本地默认 SQLite。 */
function describeDatabase(text) {
  const db = databaseMode(text)
  if (db.file) return `sqlite ${db.file}`
  if (db.url) return 'postgres'
  return `sqlite ${DEFAULT_DATABASE_FILE}`
}

/** 读 database 块里的 file / url。注释行忽略。 */
function databaseMode(text) {
  let inDatabase = false
  let file = ''
  let url = ''
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (/^\S/.test(raw)) {
      inDatabase = /^database:\s*$/.test(raw)
      continue
    }
    if (!inDatabase) continue
    const match = raw.match(/^\s+(file|url):\s*(.*)$/)
    if (!match) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (match[1] === 'file') file = value
    else url = value
  }
  return { file, url }
}

function present(text, key) {
  return text ? scalar(text, key) : ''
}

function scalar(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'))
  if (!match) return ''
  let value = match[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value
}

function fill(text, key, value) {
  if (scalar(text, key)) return text
  const pattern = new RegExp(`^(\\s*${key}:\\s*).*$`, 'm')
  if (!pattern.test(text)) throw new Error(`config.yaml 缺少 ${key}`)
  return text.replace(pattern, `$1"${value}"`)
}
