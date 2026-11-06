/**
 * API 共享上下文与会话工具。
 *
 * 注意：getSessionUser() 仍兼容旧版无 sid 令牌；收紧前必须评估现有登录用户迁移。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UPLOAD_DIR } from '../paths.js'
import { UPLOAD_IDLE_TIMEOUT_MS } from '../config.js'
import { removeFileIfExists } from '../fs-utils.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { consumeRateLimit } from '../rate-limit.js'
import { removeVideoPreview } from '../video-preview.js'
import { removeMediaThumbnail } from '../media-thumbnail.js'
import {
  createSession,
  findSessionById,
  deleteExpiredSessions,
  findUserById,
  findFileByContentHash,
  listFilesByOwnerAndSize,
  setFileContentHash,
} from '../store.js'
import {
  signToken,
  verifyToken,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  PRIVACY_COOKIE,
} from '../auth.js'
/** 列表默认每页条数 / 单页上限。分页后内存占用不再随文件总数增长。 */
export const PAGE_SIZE = 60
export const MAX_PAGE_SIZE = 200

/**
 * 回收站保留时长：24 小时。
 * 删除只是打时间戳，超过这个时长才真正把记录和磁盘文件清掉。
 */
export const TRASH_TTL_MS = 24 * 60 * 60 * 1000

/** 定时清理的扫描间隔。10 分钟扫一次，对性能毫无影响。 */
export const TRASH_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export const CATEGORIES = ['image', 'video', 'music', 'file']
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 账号不存在时也跑一次 scrypt，避免通过响应耗时判断邮箱是否注册
export const DUMMY_SALT = '0'.repeat(32)
export const DUMMY_HASH = '0'.repeat(128)

/* ══════════════════════════════════════════════════════════════════════════
   一、工具函数（下面各接口都会用到的小工具）
   ══════════════════════════════════════════════════════════════════════════ */

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
export const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000

export function enforceRateLimit(res, key, limit, windowMs, message = '操作过于频繁，请稍后再试') {
  const result = consumeRateLimit(key, limit, windowMs)
  if (result.allowed) return true
  fail(res, 429, message, 'RATE_LIMITED', { 'Retry-After': result.retryAfterSec })
  return false
}

const activeUploadsByUser = new Map()
let activeUploadsTotal = 0

export function acquireUploadSlot(userId) {
  const current = activeUploadsByUser.get(userId) || 0
  if (activeUploadsTotal >= 32 || current >= 4) return false
  activeUploadsByUser.set(userId, current + 1)
  activeUploadsTotal += 1
  return true
}

export function releaseUploadSlot(userId) {
  const current = activeUploadsByUser.get(userId) || 0
  if (current <= 1) activeUploadsByUser.delete(userId)
  else activeUploadsByUser.set(userId, current - 1)
  activeUploadsTotal = Math.max(0, activeUploadsTotal - 1)
}

/**
 * 读取请求体里的 JSON（比如登录时提交的邮箱密码）。
 *
 * 为什么这么麻烦？因为在 Node 里，请求体是「流」——数据是一块一块到达的，
 * 不像浏览器的 fetch 那样直接给你一个现成对象。
 * 所以要监听 data 事件把每块收集起来，等 end 事件到了再拼起来解析。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit 最大字节数
 * @returns {Promise<object>} 解析后的 JSON；空请求体返回 {}
 * @throws {Error & {status: number}} 超限(status=413)或 JSON 非法(status=400)
 */
export function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      // 防止有人发超大请求体把内存撑爆。超了就立刻断开连接并报错。
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (!chunks.length) return resolve({})   // 没有内容，当作空对象
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求格式不正确'), { status: 400 }))
      }
    })

    req.on('error', reject)
  })
}

/**
 * 把上传的内容一边接收一边写入磁盘，绝不整个塞进内存。
 *
 * pipeline 把三个东西串成一条流水线：
 *   req（浏览器上传的数据） → counter（数数用的） → 文件（写进磁盘）
 * 数据从左边流进右边，全程只是一小块一小块地过，内存占用恒定。
 * 这就是为什么本程序能接收 2GB 的文件，内存却没什么变化。
 *
 * 中间那个 Transform 是「中转站」：数据经过它时顺手累加总大小，
 * 一旦超过上限就报错中断整条流水线。
 *
 * 另外挂了一个「看门狗」定时器：如果持续 UPLOAD_IDLE_TIMEOUT_MS 收不到新数据，
 * 就主动断开连接，避免半死不活的连接长期占着资源。
 *
 * 副作用：创建并写入 dest；失败时调用方负责删除半成品。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} dest 目标文件路径
 * @param {number} limit 最大允许字节数
 * @returns {Promise<{size: number, contentHash: string}>}
 * @throws {Error & {status?: number}} 超限、空闲超时或流错误
 */
export async function streamToFile(req, dest, limit) {
  let size = 0
  let lastActivity = Date.now()
  const contentHasher = crypto.createHash('sha256')

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      lastActivity = Date.now()
      size += chunk.length
      contentHasher.update(chunk)
      if (size > limit) {
        return cb(Object.assign(new Error('超出可用容量'), { status: 413 }))
      }
      cb(null, chunk)   // 第一个参数传错误（null 表示没问题），第二个是继续往下的数据
    },
  })

  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > UPLOAD_IDLE_TIMEOUT_MS) {
      req.destroy(Object.assign(new Error('上传超时'), { status: 408 }))
    }
  }, 5000)
  // unref 表示这个定时器不阻止进程退出
  if (typeof watchdog.unref === 'function') watchdog.unref()

  try {
    await pipeline(req, counter, fs.createWriteStream(dest))
    return { size, contentHash: contentHasher.digest('hex') }
  } finally {
    // 无论成功失败都要清掉定时器，否则它会在后台一直跑
    clearInterval(watchdog)
  }
}

/**
 * 从本次请求里认出「当前登录的是谁」。未登录返回 null。
 *
 * 流程：取 Cookie → 取出令牌 → 验签 → 用 uid 去数据库查用户。
 * 注意第 4 步：如果用户被删了，即使令牌合法也返回 null。
 *
 * 这里每次请求都按主键查询用户，以便同时校验 session_version；
 * 代价是一次索引查询，换来的是删除用户或改密后旧令牌能立即失效。
 */
export function issueSessionToken(user) {
  const now = Date.now()
  const sessionId = crypto.randomUUID()
  deleteExpiredSessions(new Date(now).toISOString())
  createSession({
    id: sessionId,
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  })
  return signToken({ uid: user.id, ver: user.sessionVersion, sid: sessionId })
}

export function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '')
  let token = cookies[SESSION_COOKIE]
  const authHeader = req.headers.authorization || ''
  if (!token && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim()
  const payload = verifyToken(token)
  if (!payload) return null
  const user = findUserById(payload.uid)
  if (!user) return null
  if (!Number.isInteger(payload.ver) || payload.ver !== user.sessionVersion) return null
  // 安全风险：旧版无 sid 令牌暂时兼容；该分支削弱了退出登录的立即撤销语义，
  // 且隐私令牌与模块内版本号相同时存在类型混淆边界。不得无限期延续此兼容。
  if (payload.sid !== undefined) {
    if (typeof payload.sid !== 'string') return null
    const session = findSessionById(payload.sid)
    if (!session || session.userId !== user.id) return null
    if (Date.parse(session.expiresAt) <= Date.now()) return null
    return { ...user, sessionId: payload.sid }
  }
  return { ...user, sessionId: null }
}

/**
 * 把用户数据「脱敏」后再发给前端。
 * 记录里存着 salt 和 passwordHash，绝对不能原样返回 ——
 * 即使前端不显示，打开开发者工具也能看到。
 */
/** 验证短时隐私 Cookie 是否属于当前登录用户。 */
export function getPrivacyUser(req, user) {
  if (!user || !user.privacyHash) return null
  const token = parseCookies(req.headers.cookie || '')[PRIVACY_COOKIE]
  const payload = verifyToken(token)
  if (!payload || payload.scope !== 'privacy' || payload.uid !== user.id) return null
  if (payload.ver !== user.privacyVersion || payload.sver !== user.sessionVersion) return null
  return user
}

export function privacyLocked(res) {
  return fail(res, 401, '隐私空间已锁定，请重新输入隐私密码', 'PRIVACY_LOCKED')
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    createdAt: user.createdAt,
    hasPrivacyPassword: Boolean(user.privacyHash),
  }
}

/** 同理，文件记录里的 storedName 是内部存储名，不对外暴露。 */
export function publicFile(record) {
  return {
    id: record.id,
    name: record.name,
    category: record.category,
    mime: record.mime,
    size: record.size,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // 有值说明在回收站里（前端据此显示倒计时、切换按钮）
    deletedAt: record.deletedAt || null,
    isPrivate: Boolean(record.isPrivate),
    privateAt: record.privateAt || null,
  }
}

/**
 * 决定文件存在磁盘上叫什么扩展名。
 *
 * 【为什么不直接用用户的文件名存】
 *   用户的文件名可能带特殊字符，甚至故意写成 ../../ 来搞路径穿越。
 *   所以本项目的做法是：
 *     磁盘上的真实名字 = 随机 UUID + 安全扩展名   例如 a1b2c3d4....png
 *     用户看到的原始文件名 = 存在数据库的 name 字段里
 */
export function safeExt(name, mime) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext

  const fallback = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  }
  return fallback[mime] || '.bin'
}

/**
 * 清洗文件名，只用于「显示」。
 *   把斜杠换成下划线（避免看起来像路径）
 *   删掉控制字符（不可见字符会搞坏界面）
 *   限制最长 180 字符
 */
export function sanitizeName(raw) {
  const name = String(raw || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return (name || '未命名文件').slice(0, 180)
}

/** 确保「这个用户的上传目录」存在，并返回它的路径。 */
export function ensureOwnedDir(ownerId) {
  const dir = path.join(UPLOAD_DIR, ownerId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 删掉磁盘上的文件本体（数据库记录由调用方另外删除）。 */
export function removeStoredFile(record) {
  const originalRemoved = removeFileIfExists(path.join(UPLOAD_DIR, record.ownerId, record.storedName))
  const previewRemoved = removeVideoPreview(record)
  const thumbnailRemoved = removeMediaThumbnail(record)
  return originalRemoved && previewRemoved && thumbnailRemoved
}

/** 把字节数转成看得懂的单位，用于错误提示。 */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes) || 0
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/**
 * 老记录可能还没有内容哈希。只有在上传文件大小相同时才读取旧文件计算，
 * 避免服务启动时扫描整个上传目录。
 */
export async function hashStoredFile(record) {
  const filePath = path.join(UPLOAD_DIR, record.ownerId, record.storedName)
  const hasher = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) {
    hasher.update(chunk)
  }
  return hasher.digest('hex')
}

/** 查找同一用户是否上传过相同内容；普通文件、回收站和隐私文件都参与去重。 */
export async function findDuplicateUpload(ownerId, size, contentHash) {
  const alreadyHashed = findFileByContentHash(ownerId, contentHash)
  if (alreadyHashed) return alreadyHashed

  const sameSize = listFilesByOwnerAndSize(ownerId, size)
  for (const record of sameSize) {
    let existingHash = record.contentHash
    if (!existingHash) {
      try {
        existingHash = await hashStoredFile(record)
        setFileContentHash(record.id, ownerId, existingHash)
      } catch {
        // 旧文件丢失时不阻断本次上传
        continue
      }
    }
    if (existingHash === contentHash) return record
  }
  return null
}

export function duplicateUploadResponse(res, record) {
  // 隐私文件的名称、位置和类型都不能通过“重复上传”侧信道泄露。
  if (record.isPrivate) {
    return json(res, 409, {
      error: '账号中已存在相同文件，无法重复上传',
      code: 'DUPLICATE_FILE',
    })
  }
  const location = record.deletedAt ? '回收站' : '文件列表'
  return json(res, 409, {
    error: `${location}中已存在相同文件：${record.name}`,
    code: 'DUPLICATE_FILE',
    file: publicFile(record),
  })
}

/* ══════════════════════════════════════════════════════════════════════════
   二、发送文件内容（预览与下载共用）
   ══════════════════════════════════════════════════════════════════════════ */

