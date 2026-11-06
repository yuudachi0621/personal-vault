/**
 * 部署配置
 *
 * 两种模式：
 * 1. 一体部署（默认）—— 前端静态文件与 API 由同一进程、同一端口提供，无需任何环境变量。
 * 2. 分离部署 —— 设置 ALLOWED_ORIGINS 为前端所在的源（逗号分隔），
 *    后端开始返回 CORS 响应头，并把会话 Cookie 切到 SameSite=None; Secure。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT } from './paths.js'
import { readIntegerEnv } from './env.js'

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/**
 * 允许跨域访问本 API 的前端源列表（逗号分隔，保存规范化后的完整 Origin）。
 * 为空表示不启用 CORS 白名单，只接受同源请求。
 */
export const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS)

/** 是否处于分离部署模式。 */
export const CROSS_ORIGIN = ALLOWED_ORIGINS.length > 0

/** 关闭静态资源托管，让本进程只提供 API（前端交给别的服务器 / CDN）。 */
export const SERVE_STATIC = process.env.SERVE_STATIC !== '0'

/** 只有明确设为 1 时才信任反向代理写入的转发头。 */
export const TRUST_PROXY = process.env.TRUST_PROXY === '1'

/** 规范化 PUBLIC_ORIGIN；只接受无路径、无查询、无片段的 HTTP(S) Origin。 */
export function normalizePublicOrigin(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

const configuredPublicOrigin = process.env.PUBLIC_ORIGIN
if (String(configuredPublicOrigin || '').trim() && !normalizePublicOrigin(configuredPublicOrigin)) {
  throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTP(S) Origin，不能包含路径、查询参数或片段')
}
export const PUBLIC_ORIGIN = normalizePublicOrigin(configuredPublicOrigin)

/* ── 数值配置 ────────────────────────────────────────────────────────────
 *
 * 这些值直接参与配额、上传上限、磁盘保护和连接超时判断。
 * 非法值必须在启动阶段失败，不能变成 NaN 后让安全判断静默失效。
 */

/** HTTP 监听端口；0 表示由 Node 选择可用端口。 */
export const PORT = readIntegerEnv(process.env, 'PORT', 8787, { min: 0, max: 65535 })

/** 单用户可用容量上限，默认 10GiB；0 表示不限制。 */
export const MAX_USER_BYTES = readIntegerEnv(process.env, 'MAX_USER_BYTES', 10 * 1024 ** 3)

/** 磁盘保留余量，默认 1GiB；0 表示不保留额外余量。 */
export const MIN_FREE_BYTES = readIntegerEnv(process.env, 'MIN_FREE_BYTES', 1024 ** 3)

/** 单文件上传上限，默认 2GiB；必须大于 0。 */
export const MAX_UPLOAD_BYTES = readIntegerEnv(process.env, 'MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024, { min: 1 })

/** 上传连续无数据多久后断开，默认 60 秒；必须大于 0。 */
export const UPLOAD_IDLE_TIMEOUT_MS = readIntegerEnv(process.env, 'UPLOAD_IDLE_TIMEOUT_MS', 60_000, { min: 1 })

/** 单次视频 Range 响应最大字节数，默认 32MiB，允许 1–64MiB。 */
export const MEDIA_RANGE_CHUNK_BYTES = Math.min(
  64 * 1024 * 1024,
  Math.max(1, readIntegerEnv(process.env, 'MEDIA_RANGE_CHUNK_BYTES', 32 * 1024 * 1024)),
)

/* ══════════════════════════════════════════════════════════════════════════
   配置文件 config.json
   ══════════════════════════════════════════════════════════════════════════

   【为什么用文件而不是环境变量】
     注册码属于「这个站点自己的设置」，不是启动参数。
     放在文件里可以直接用编辑器改，看得见、改完重启就生效，
     也不用记着一长串环境变量该怎么拼。

   【为什么配置文件不进 Git】
     config.json 含注册码，属于部署机密，已加入 .gitignore。
     仓库里放的是 config.example.json 模板，只描述字段不含真实值。

   【首次启动自动生成注册码】
     文件不存在时，自动生成一个随机注册码写进去，并在启动日志里打印出来。
     这样不用预置任何硬编码的默认值（"123456" 这种默认值等于没有防护），
     管理员第一次启动就能从控制台看到该发什么给朋友。
*/

const CONFIG_FILE = path.join(ROOT, 'config.json')
const CONFIG_EXAMPLE = path.join(ROOT, 'config.example.json')

/** 生成一个好念好抄的随机注册码，形如 VAULT-7K3M-QP9X-2RTV。 */
function generateRegistrationCode() {
  // 去掉了容易看错的 I / O / 0 / 1
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(12)
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length])
  return `VAULT-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`
}

function writeConfigFile(registrationCode, configFile, exampleFile) {
  const body = JSON.stringify({ registrationCode }, null, 2) + '\n'
  fs.writeFileSync(configFile, body, { mode: 0o600 })
  // 模板只包含占位符，绝不把部署注册码写入可能被提交的示例文件。
  if (!fs.existsSync(exampleFile)) {
    const example = JSON.stringify({ registrationCode: 'VAULT-XXXX-XXXX-XXXX' }, null, 2) + '\n'
    fs.writeFileSync(exampleFile, example, 'utf8')
  }
}

/**
 * 读取配置。文件不存在就创建一个带随机注册码的。
 *
 * 解析失败时直接抛错而不是「当作没配置」——
 * 后者会静默变成开放注册，等于把一个配错格式的文件变成安全漏洞。
 * 宁可启动失败，让人看到明确的错误。
 */
export function loadConfigFile({ configFile = CONFIG_FILE, exampleFile = CONFIG_EXAMPLE } = {}) {
  if (!fs.existsSync(configFile)) {
    const registrationCode = generateRegistrationCode()
    writeConfigFile(registrationCode, configFile, exampleFile)
    return { registrationCode, justCreated: true }
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    throw new Error('config.json 格式不正确，无法解析')
  }

  // 安全审计注记：现有文件不会在启动时自动收紧权限；复制来的 config.json
  // 可能仍是 0644，生产环境应额外检查文件所有者与权限。
  return {
    registrationCode: String((raw && raw.registrationCode) || '').trim(),
    justCreated: false,
  }
}

let cachedFileConfig = null

/** 显式初始化配置文件；应用启动和注册相关逻辑共用同一份缓存。 */
export function initializeConfig() {
  if (!cachedFileConfig) cachedFileConfig = loadConfigFile()
  return cachedFileConfig
}

/** 是否要求注册码。由注册码是否为空自动决定。 */
export function isRegistrationCodeRequired() {
  return initializeConfig().registrationCode.length > 0
}

/**
 * 校验注册码。
 *
 * 比较时忽略首尾空格和大小写 —— 注册码是要口头或聊天发给别人的，
 * 因为大小写打错而被拒很影响体验。
 * 未配置注册码时永远返回 true（开放注册）。
 */
export function isRegistrationCodeValid(input) {
  const { registrationCode } = initializeConfig()
  if (!registrationCode) return true
  const normalized = String(input || '').trim().toLowerCase()
  const expected = registrationCode.toLowerCase()
  // 比较摘要而不是原文，避免字符串比较的时序差异泄露注册码前缀
  const a = crypto.createHash('sha256').update(normalized).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

/** 启动日志用。 */
export function describeRegistration() {
  return isRegistrationCodeRequired()
    ? '需要注册码才能注册'
    : '开放注册（config.json 里的 registrationCode 为空）'
}

/** 读取 data/ 所在分区的剩余可用字节数；读不到时返回 null（视为不限制）。 */
export function freeDiskBytes(directory) {
  try {
    // statfsSync 是 Node 内置的文件系统统计接口；本项目要求 Node 22.5+。
    const stats = fs.statfsSync(directory)
    return stats.bsize * stats.bavail
  } catch {
    return null
  }
}

/** 推断请求实际使用的协议；只有 TRUST_PROXY 开启时才读取 X-Forwarded-Proto。 */
export function requestProtocol(req, { trustProxy = TRUST_PROXY } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    if (forwarded === 'http' || forwarded === 'https') return forwarded
  }
  return req.socket && req.socket.encrypted ? 'https' : 'http'
}

/** 本服务自身的源，用于判断「同源请求」。 */
export function selfOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN
  const host = req.headers.host
  if (!host) return null
  return `${requestProtocol(req)}://${host}`
}

/**
 * 判断请求来源是否被允许。
 * - Origin 缺失：非浏览器发起（curl、服务端调用），放行。
 * - Origin 与本服务同源：放行。
 * - Origin 在 ALLOWED_ORIGINS 中：放行（分离部署）。
 * - 其余：拒绝。
 */
export function isOriginAllowed(req, origin) {
  if (!origin) return true
  const self = selfOrigin(req)
  if (self && origin === self) return true
  return ALLOWED_ORIGINS.includes(origin)
}

/** 该来源是否需要返回 CORS 响应头（仅分离部署下配置过的源）。 */
export function needsCorsHeaders(req, origin) {
  if (!origin) return false
  const self = selfOrigin(req)
  if (self && origin === self) return false
  return ALLOWED_ORIGINS.includes(origin)
}

/**
 * 会话 Cookie 的属性。
 * 分离部署固定使用 SameSite=None + Secure，因此前后端都必须通过 HTTPS 访问。
 * 同源部署使用 SameSite=Lax；Secure 是否启用依据可信代理提供的协议或直接 TLS 连接。
 */
export function cookieOptions(req) {
  if (CROSS_ORIGIN) {
    return { sameSite: 'None', secure: true }
  }
  return {
    sameSite: 'Lax',
    secure: requestProtocol(req) === 'https',
  }
}

/** 启动时打印一次当前模式，便于排查。 */
export function describeMode() {
  if (!SERVE_STATIC && !CROSS_ORIGIN) {
    return 'API-only 模式（未托管前端，且未配置跨域来源）'
  }
  if (CROSS_ORIGIN) {
    return `分离部署模式（允许来源：${ALLOWED_ORIGINS.join(', ')}${SERVE_STATIC ? '；仍托管 public/' : '；不托管前端'}）`
  }
  return '一体部署模式（同源，无 CORS）'
}
