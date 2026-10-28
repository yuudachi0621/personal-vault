/**
 * ============================================================================
 *  lib/auth.js —— 密码与会话（怎么证明「你是你」）
 * ============================================================================
 *
 * 【核心问题】
 *   HTTP 是「无记忆」的：每个请求都是独立的，服务器天生不知道
 *   这次请求和上一次是不是同一个人。
 *   所以登录之后要给浏览器发一张「凭证」，之后每次请求都带着它。
 *
 * 【本项目的做法】
 *   1. 用户注册时，密码不存明文，存「加盐哈希」
 *   2. 登录成功 → 服务器签一张令牌（token），塞进 Cookie 发给浏览器
 *   3. 浏览器之后每次请求自动带上这个 Cookie
 *   4. 服务器验证令牌上的签名，确认没被伪造过
 *
 * 【为什么叫「无状态」】
 *   服务器不保存「谁在线」的名单。所有信息都写在令牌里，
 *   靠签名保证真实性。好处是重启服务不影响已登录用户。
 */

import crypto from 'node:crypto'   // Node 自带加密模块
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

/**
 * scrypt 的异步版本。
 *
 * 为什么不能用 scryptSync？
 *   它会把主线程占满约 45ms（实测），期间整个网站无法响应任何请求。
 *   单人使用感觉不出来，但几个人同时登录就会明显卡顿。
 *   异步版本把计算放到线程池里跑，主线程继续处理别的请求。
 */
const scryptAsync = promisify(crypto.scrypt)

export const SESSION_COOKIE = 'pv_session'                      // Cookie 的名字
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000          // 有效期 30 天（毫秒）

const SECRET_FILE = path.join(DATA_DIR, 'secret.key')
let cachedSecret = null

/**
 * 取签名密钥。
 * 首次启动时随机生成一串存到文件里，之后一直复用。
 * 正因为存了盘，重启服务不会让所有人掉线。
 * 如果这个文件丢了，所有已登录用户都会被迫重新登录。
 */
function getSecret() {
  if (cachedSecret) return cachedSecret
  if (fs.existsSync(SECRET_FILE)) {
    cachedSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/i.test(cachedSecret)) {
      throw new Error('data/secret.key 内容无效，应为 64 位十六进制字符串；请恢复备份或删除后重新登录所有账号')
    }
  } else {
    // randomBytes(32) 生成 32 字节密码学随机数，转成十六进制字符串保存
    cachedSecret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(SECRET_FILE, cachedSecret, { mode: 0o600 })  // 0600 = 只有文件主可读写
  }
  try { fs.chmodSync(SECRET_FILE, 0o600) } catch { /* Windows / 特殊文件系统忽略 */ }
  return cachedSecret
}

/**
 * ---------------------------------------------------------------------------
 *  密码哈希
 * ---------------------------------------------------------------------------
 *
 * 【为什么不能明文存密码】
 *   一旦数据文件泄露或被管理员看到，所有用户的密码就暴露了。
 *
 * 【什么是「加盐」】
 *   同样的密码，直接哈希会得到同样的结果 —— 攻击者可以拿一张
 *   「常见密码 → 哈希值」的表来反查。所以给每个用户随机生成一段
 *   额外的字符串（盐 salt），拼在密码后面一起哈希。
 *   这样即使两个人密码相同，存下来的哈希也完全不同。
 *
 * 【为什么用 scrypt 而不是 md5/sha256】
 *   md5/sha1 算得太快，攻击者一秒能试几十亿次。
 *   scrypt 是专门为「存密码」设计的：故意算得慢，让暴力破解变得不划算。
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  // scrypt(密码, 盐, 输出长度) —— 第三个参数 64 表示产出 64 字节
  const derived = await scryptAsync(password, salt, 64)
  return { salt, hash: derived.toString('hex') }
}

/**
 * 校验密码。
 * 做法是：拿用户输入的密码 + 存着的盐，重新算一遍哈希，看结果是否等于存的值。
 * 因为盐是随机的，我们无法「反解」出原密码，只能这样比对。
 */
export async function verifyPassword(password, salt, hash) {
  let candidate
  try {
    const derived = await scryptAsync(password, salt, 64)
    candidate = derived.toString('hex')
  } catch {
    return false   // 参数异常（比如盐被改坏了），直接判定失败
  }

  const a = Buffer.from(candidate, 'hex')
  const b = Buffer.from(String(hash), 'hex')

  // 长度不同必然不等。timingSafeEqual 要求两者长度一致，所以要先判断。
  if (a.length !== b.length || b.length === 0) return false

  /**
   * 为什么用 timingSafeEqual 而不是 a === b？
   * 普通比较是「一个字符一个字符比，发现不同就立刻返回」，
   * 于是「前 3 位对」比「前 1 位对」慢一点点。
   * 攻击者能通过测量耗时，逐位猜出正确值（时序攻击）。
   * timingSafeEqual 无论内容如何，耗时都一样，堵住这个漏洞。
   */
  return crypto.timingSafeEqual(a, b)
}

/**
 * ---------------------------------------------------------------------------
 *  会话令牌：签名（颁发）与验证
 * ---------------------------------------------------------------------------
 *
 *  令牌长这样：   eyJ1aWQiOiJ1XzEyMyIsImV4cCI6MTc5...  .  k8sJ2nQ...
 *                  └──────── 数据部分（base64url）──────┘    └─ 签名 ─┘
 *
 *  数据部分是「明文」的（只是编码过，谁都能解开看），里面有 uid 和过期时间。
 *  关键在于后半段的签名：它是用服务器私有的密钥对前半段算出来的。
 *  别人能看到内容，但没有密钥就伪造不出合法签名 —— 改一个字符都会验不过。
 *
 *  ⚠️ 所以令牌里千万别放密码之类的秘密，它不是加密，只是防篡改。
 */

/**
 * 签发令牌。
 * @param {object} payload 要装进令牌的数据，例如 { uid: 'u_xxx' }
 * @param {number} ttlMs   有效期（毫秒）
 */
export function signToken(payload, ttlMs = SESSION_TTL_MS) {
  // Date.now() 返回当前时间戳（毫秒）。exp = 过期时刻。
  const body = { ...payload, exp: Date.now() + ttlMs }

  // 对象 → JSON 字符串 → Buffer → base64url 编码（URL 里安全的 base64）
  const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')

  // createHmac 用密钥 + 数据算出一个摘要，这个就是签名
  const sig = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url')

  return `${data}.${sig}`
}

/**
 * 验证令牌。合法返回里面的数据，否则返回 null。
 * 注意它「不查数据库」—— 只要签名对、没过期，就认。
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null

  const dot = token.lastIndexOf('.')
  if (dot < 1) return null
  const data = token.slice(0, dot)   // 前半段：数据
  const sig = token.slice(dot + 1)   // 后半段：签名

  // 用同样的密钥重算一遍签名
  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url')

  // 比较签名 —— 不一样说明被改过或伪造的，拒掉
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    if (!body || typeof body.uid !== 'string') return null
    if (!Number.isFinite(body.exp) || body.exp < Date.now()) return null   // 过期了
    return body
  } catch {
    return null
  }
}

/**
 * ---------------------------------------------------------------------------
 *  Cookie 解析与构造
 * ---------------------------------------------------------------------------
 *  浏览器发来的 Cookie 是一整条字符串，形如：
 *      pv_session=abc.def; 别的名字=别的值
 *  需要自己拆成 { pv_session: 'abc.def', ... } 这种对象来用。
 */
export function parseCookies(header = '') {
  const out = {}
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      out[key] = part.slice(index + 1).trim()   // 解码失败就用原值，别让程序崩
    }
  }
  return out
}

/**
 * 拼出一条 Set-Cookie 响应头的值。各个属性的含义：
 *
 *   Path=/        整个站点都带上这个 Cookie
 *   HttpOnly      禁止 JavaScript 读取（防止 XSS 攻击偷走令牌）
 *   SameSite=Lax  同站请求才自动携带，挡住大部分跨站伪造请求
 *   SameSite=None 允许跨站携带 —— 分离部署时必需，但浏览器强制要求同时有 Secure
 *   Secure        只在 HTTPS 下发送
 *   Max-Age=0     立即失效（用来删除 Cookie）
 */
function buildCookie(value, { sameSite = 'Lax', secure = false, maxAgeSec = 0 } = {}) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`]
  if (secure) parts.push('Secure')
  parts.push(`Max-Age=${maxAgeSec}`)
  return parts.join('; ')
}

/** 生成「登录成功」的 Cookie（有效期 30 天）。 */
export function sessionCookie(token, options = {}) {
  return buildCookie(token, {
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),   // Max-Age 的单位是秒，所以要除以 1000
    ...options,                                      // 允许调用方覆盖 sameSite / secure
  })
}

/** 生成「清除会话」的 Cookie（Max-Age=0 即立刻删除）。 */
export function clearCookie(options = {}) {
  return buildCookie('', { maxAgeSec: 0, ...options })
}
