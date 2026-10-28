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

function writeConfigFile(registrationCode) {
  const body = JSON.stringify({ registrationCode }, null, 2) + '\n'
  fs.writeFileSync(CONFIG_FILE, body, { mode: 0o600 })
  // 顺手放一份模板，方便用户知道还有哪些字段可以改
  if (!fs.existsSync(CONFIG_EXAMPLE)) {
    fs.writeFileSync(CONFIG_EXAMPLE, body, 'utf8')
  }
}

/**
 * 读取配置。文件不存在就创建一个带随机注册码的。
 *
 * 解析失败时直接抛错而不是「当作没配置」——
 * 后者会静默变成开放注册，等于把一个配错格式的文件变成安全漏洞。
 * 宁可启动失败，让人看到明确的错误。
 */
function loadConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const registrationCode = generateRegistrationCode()
    writeConfigFile(registrationCode)
    return { registrationCode, justCreated: true }
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (error) {
    throw new Error(`config.json 格式不正确，无法解析：${error.message}`)
  }

  return {
    registrationCode: String((raw && raw.registrationCode) || '').trim(),
    justCreated: false,
  }
}

const fileConfig = loadConfigFile()

/** 本次启动是否刚刚生成了配置文件（用于启动日志提示）。 */
export const CONFIG_JUST_CREATED = fileConfig.justCreated

/**
 * 注册码。留空表示开放注册（不校验）。
 * 想关掉注册校验，把 config.json 里的值改成空字符串即可。
 */
export const REGISTRATION_CODE = fileConfig.registrationCode

/** 是否要求注册码。由注册码是否为空自动决定。 */
export const REQUIRE_REGISTRATION_CODE = REGISTRATION_CODE.length > 0

/**
 * 校验注册码。
 *
 * 比较时忽略首尾空格和大小写 —— 注册码是要口头或聊天发给别人的，
 * 因为大小写打错而被拒很影响体验。
 * 未配置注册码时永远返回 true（开放注册）。
 */
export function isRegistrationCodeValid(input) {
  if (!REQUIRE_REGISTRATION_CODE) return true
  const normalized = String(input || '').trim().toLowerCase()
  const expected = REGISTRATION_CODE.toLowerCase()
  // 比较摘要而不是原文，避免字符串比较的时序差异泄露注册码前缀
  const a = crypto.createHash('sha256').update(normalized).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

/** 启动日志用。 */
export function describeRegistration() {
  return REQUIRE_REGISTRATION_CODE
    ? '需要注册码才能注册'
    : '开放注册（config.json 里的 registrationCode 为空）'
}

/* ── 容量防护 ────────────────────────────────────────────────────────────
 *
 * 【为什么要设限额】
 *   原来没有任何限制。40G 磁盘存 20 个 4K 视频就满了，而磁盘写满会导致
 *   数据库写入失败、上传全部报错，看起来就像「服务器崩了」。
 *   与其等它写满，不如提前明确拒绝，并给出看得懂的原因。
 */

/**
 * 单用户可用容量上限，默认 10GiB。设为 0 表示不限制。
 * 环境变量必须提供有效数字；当前实现不会对 NaN 再做回退或报错。
 */
export const MAX_USER_BYTES = Number(process.env.MAX_USER_BYTES || 10 * 1024 ** 3)

/**
 * 磁盘保留余量，默认 1GiB。剩余空间低于此值时拒绝新上传。
 * 与 MAX_USER_BYTES 一样，生产环境应确保传入有效数字。
 */
export const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES || 1024 ** 3)

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

/**
 * 推断请求实际使用的协议。
 * 当前实现会无条件优先信任 X-Forwarded-Proto；直接暴露服务时该头可被伪造，
 * 因此生产部署必须由反向代理覆盖并清洗此头。
 */
export function requestProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  if (forwarded) return forwarded
  return req.socket && req.socket.encrypted ? 'https' : 'http'
}

/** 本服务自身的源，用于判断「同源请求」。 */
export function selfOrigin(req) {
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
 * 同源部署使用 SameSite=Lax；Secure 是否启用取决于 X-Forwarded-Proto 是否包含 https。
 */
export function cookieOptions(req) {
  if (CROSS_ORIGIN) {
    return { sameSite: 'None', secure: true }
  }
  return {
    sameSite: 'Lax',
    secure: String(req.headers['x-forwarded-proto'] || '').includes('https'),
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
