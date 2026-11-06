import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './paths.js'

let cachedVersion = null

/** 读取 package.json 中的唯一版本号。 */
export function getAppVersion() {
  if (cachedVersion) return cachedVersion
  const packageFile = path.join(ROOT, 'package.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  } catch {
    throw new Error('无法读取 package.json 版本号')
  }
  if (!parsed || typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('package.json 缺少有效 version')
  }
  cachedVersion = parsed.version.trim()
  return cachedVersion
}