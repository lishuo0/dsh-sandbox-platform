import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const platformRoot = resolve(import.meta.dirname, '..')
const platformFile = resolve(platformRoot, 'config.yaml')
const brainFile = resolve(platformRoot, '../dsh-sandbox-brain/config.yaml')

const platform = readFileSync(platformFile, 'utf8')
let brain = ''
try {
  brain = readFileSync(brainFile, 'utf8')
} catch {
  brain = ''
}

const tokenSecret = present(platform, 'tokenSecret') || randomBytes(24).toString('hex')
const adminPassword = present(platform, 'adminPassword') || randomBytes(9).toString('hex')
const credentialsKey = present(platform, 'credentialsKey') || present(brain, 'credentialsKey') || randomBytes(32).toString('base64')
const appKey = present(platform, 'appKey') || present(brain, 'appKey') || randomBytes(18).toString('hex')

if (present(platform, 'appKey') && present(brain, 'appKey') && present(platform, 'appKey') !== present(brain, 'appKey')) {
  console.error('两边 config.yaml 的 appKey 不一致，先改成同一把再启动。')
  process.exit(1)
}
if (present(platform, 'credentialsKey') && present(brain, 'credentialsKey') && present(platform, 'credentialsKey') !== present(brain, 'credentialsKey')) {
  console.error('两边 config.yaml 的 credentialsKey 不一致，先改成同一把再启动。')
  process.exit(1)
}

writeFileSync(
  platformFile,
  fill(fill(fill(fill(platform, 'tokenSecret', tokenSecret), 'adminPassword', adminPassword), 'credentialsKey', credentialsKey), 'appKey', appKey),
)
if (brain) {
  writeFileSync(brainFile, fill(fill(brain, 'credentialsKey', credentialsKey), 'appKey', appKey))
}

const written = readFileSync(platformFile, 'utf8')
console.log(`admin=${scalar(written, 'adminUsername') || 'admin'}`)
console.log(`password=${scalar(written, 'adminPassword')}`)

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
