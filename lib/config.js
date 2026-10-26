/**
 * 部署配置
 *
 * 两种模式：
 * 1. 一体部署（默认）—— 前端静态文件与 API 由同一进程、同一端口提供，无需任何环境变量。
 * 2. 分离部署 —— 设置 ALLOWED_ORIGINS 为前端所在的源（逗号分隔），
 *    后端开始返回 CORS 响应头，并把会话 Cookie 切到 SameSite=None; Secure。
 */

import fs from 'node:fs'

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** 允许跨域访问本 API 的前端源列表。为空表示只接受同源请求。 */
export const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS)

/** 是否处于分离部署模式。 */
export const CROSS_ORIGIN = ALLOWED_ORIGINS.length > 0

/** 关闭静态资源托管，让本进程只提供 API（前端交给别的服务器 / CDN）。 */
export const SERVE_STATIC = process.env.SERVE_STATIC !== '0'

/* ── 注册邀请码 ──────────────────────────────────────────────────────────
 *
 * 【为什么放在环境变量而不是数据库】
 *   邀请码是「部署时才决定」的运维开关，不是业务数据。
 *   放环境变量意味着：改它只要重启服务，不需要写后台管理界面，
 *   也不会因为数据库泄漏就连带泄露。
 *
 * 【空值 = 开放注册】
 *   不配置 INVITE_CODE 时行为和以前完全一样，
 *   这样从旧版本升级上来不会突然把注册关掉。
 */
export const INVITE_CODE = String(process.env.INVITE_CODE || '').trim()

/** 是否要求邀请码。由 INVITE_CODE 是否为空自动决定。 */
export const REQUIRE_INVITE_CODE = INVITE_CODE.length > 0

/**
 * 校验邀请码。
 *
 * 比较时忽略首尾空格和大小写 —— 邀请码是要口头或聊天发给别人的，
 * 因为大小写打错而被拒很影响体验。
 * 注意：不配置邀请码时永远返回 true（开放注册）。
 *
 * ⚠️ 安全提示：邀请码强度取决于长度。别用 `123456` 这种，
 *    建议 12 位以上随机字符串，否则可能被暴力枚举。
 */
export function isInviteCodeValid(input) {
  if (!REQUIRE_INVITE_CODE) return true
  const normalized = String(input || '').trim().toLowerCase()
  return normalized === INVITE_CODE.toLowerCase()
}

/** 启动日志用。 */
export function describeRegistration() {
  return REQUIRE_INVITE_CODE ? '需要邀请码才能注册' : '开放注册（未设置邀请码）'
}

/* ── 容量防护 ────────────────────────────────────────────────────────────
 *
 * 【为什么要设限额】
 *   原来没有任何限制。40G 磁盘存 20 个 4K 视频就满了，而磁盘写满会导致
 *   数据库写入失败、上传全部报错，看起来就像「服务器崩了」。
 *   与其等它写满，不如提前明确拒绝，并给出看得懂的原因。
 */

/** 单用户可用容量上限，默认 10GB。设为 0 表示不限制。 */
export const MAX_USER_BYTES = Number(process.env.MAX_USER_BYTES || 10 * 1024 ** 3)

/** 磁盘保留余量，默认 1GB。剩余空间低于这个值就拒绝新上传，给系统留出喘息空间。 */
export const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES || 1024 ** 3)

/** 读取 data/ 所在分区的剩余可用字节数；读不到时返回 null（视为不限制）。 */
export function freeDiskBytes(directory) {
  try {
    // statfs 是查询文件系统统计信息的系统调用，Node 18.15+ 内置支持
    const stats = fs.statfsSync(directory)
    return stats.bsize * stats.bavail
  } catch {
    return null
  }
}

/** 请求真实使用的协议，兼容反向代理。 */
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
 * 跨站场景下浏览器要求 SameSite=None 与 Secure 同时成立，因此分离部署必须走 HTTPS。
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
