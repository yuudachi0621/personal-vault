/**
 * ============================================================================
 *  lib/api.js —— 接口层（网站的「业务大脑」）
 * ============================================================================
 *
 *  前端所有数据操作都要经过这里。它对外提供一组「接口」（API），
 *  本质上就是「某个地址 + 某种方法」对应一段处理逻辑：
 *
 *     POST   /api/auth/register      注册
 *     POST   /api/auth/login         登录
 *     POST   /api/auth/logout        退出
 *     GET    /api/auth/me            当前登录的是谁
 *     PATCH  /api/auth/password      改密码
 *     GET    /api/files              列表（分页 + 筛选 + 搜索 + 排序）
 *     POST   /api/files/upload       上传
 *     GET    /api/files/:id/raw      取文件内容（用于页面里直接显示）
 *     GET    /api/files/:id/download 下载（浏览器弹出「另存为」）
 *     PATCH  /api/files/:id          改名 / 改分类
 *     DELETE /api/files/:id          删除
 *
 *  【HTTP 方法是什么意思】
 *     GET    读取     PATCH  局部修改
 *     POST   新建     DELETE 删除
 *   同一个地址用不同方法，含义就不同 —— 这是 REST 风格的约定。
 *
 *  【状态码（res.writeHead 的第一个参数）】
 *     200 成功    400 请求有问题    401 没登录
 *     403 没权限  404 找不到        409 冲突（比如邮箱已被注册）
 *     413 内容太大 / 超出容量       507 服务器磁盘空间不足
 *     500 服务器自己出错了
 *
 *  【数据隔离是怎么做到的（三道关卡）】← 这是本项目最关键的安全设计
 *     第 1 道：每条记录带 owner_id，标明「这条属于谁」
 *     第 2 道：所有 SQL 查询都带 owner_id 条件（lib/store.js）
 *     第 3 道：别人的记录一律当作「不存在」（返回 404），
 *              连「这个文件存在但不给你看」都不告诉对方，避免泄露信息
 *     也就是说，安全性由服务端保证，而不是靠前端「不显示按钮」。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform, pipeline as pipeStream } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { UPLOAD_DIR, DATA_DIR } from './paths.js'
import { inferMime, detectCategory, safeInlineMime } from './media.js'
import { requestIp, consumeRateLimit, resetRateLimit } from './rate-limit.js'
import {
  findUserByEmail,
  findUserById,
  createUser,
  updateUserPassword,
  createFile,
  findFileForOwner,
  findFileByContentHash,
  listFilesByOwnerAndSize,
  setFileContentHash,
  findActiveFileForOwner,
  listFiles,
  countFiles,
  usageFor,
  totalBytesFor,
  updateFile,
  softDeleteFile,
  restoreFile,
  purgeFile,
  listExpiredFiles,
  emptyTrashFor,
} from './store.js'
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookies,
  sessionCookie,
  clearCookie,
  SESSION_COOKIE,
} from './auth.js'
import {
  cookieOptions,
  isOriginAllowed,
  MAX_USER_BYTES,
  MIN_FREE_BYTES,
  freeDiskBytes,
  isRegistrationCodeValid,
  REQUIRE_REGISTRATION_CODE,
} from './config.js'

/** 上传体积上限，默认 2GB，可用环境变量覆盖。 */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024)

/**
 * 上传「空闲」超时：连续这么久没有收到新数据就判定连接已死，主动断开。
 *
 * 为什么需要它？
 *   上次把 requestTimeout 设成 0（为了允许传大文件），副作用是
 *   上传到一半断网的连接会永久挂住，socket 和文件句柄都不释放。
 *   积累到文件描述符上限后，整个服务就无法再打开任何文件了。
 *   这里改成「只要还在传就不算超时」，但真的停了就及时清理。
 */
const UPLOAD_IDLE_TIMEOUT_MS = Number(process.env.UPLOAD_IDLE_TIMEOUT_MS || 60_000)

/** 单个 206 默认返回 32MB；兼顾高延迟网络下的连续缓冲，又避免一次占用整个大文件连接。 */
const configuredRangeChunk = Number(process.env.MEDIA_RANGE_CHUNK_BYTES)
const MEDIA_RANGE_CHUNK_BYTES = Math.min(
  64 * 1024 * 1024,
  Math.max(
    1 * 1024 * 1024,
    Number.isFinite(configuredRangeChunk) && configuredRangeChunk > 0
      ? configuredRangeChunk
      : 32 * 1024 * 1024,
  ),
)

/** 列表默认每页条数 / 单页上限。分页后内存占用不再随文件总数增长。 */
const PAGE_SIZE = 60
const MAX_PAGE_SIZE = 200

/**
 * 回收站保留时长：24 小时。
 * 删除只是打时间戳，超过这个时长才真正把记录和磁盘文件清掉。
 */
const TRASH_TTL_MS = 24 * 60 * 60 * 1000

/** 定时清理的扫描间隔。10 分钟扫一次，对性能毫无影响。 */
const TRASH_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export const CATEGORIES = ['image', 'video', 'music', 'file']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 账号不存在时也跑一次 scrypt，避免通过响应耗时判断邮箱是否注册
const DUMMY_SALT = '0'.repeat(32)
const DUMMY_HASH = '0'.repeat(128)

/* ══════════════════════════════════════════════════════════════════════════
   一、工具函数（下面各接口都会用到的小工具）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 统一的「返回 JSON」出口。
 * 所有接口都从这里把数据发回给浏览器，保证响应格式一致。
 */
function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)   // 对象转成 JSON 字符串才能通过网络传输
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Content-Length 必须按「字节数」算，不能按字符数 ——
    // 一个中文字符占 3 字节，用 payload.length 会算错导致乱码。
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',   // 接口结果不许缓存，否则退出后还能看到数据
    ...extraHeaders,               // 例如 Set-Cookie
  })
  res.end(payload)
}

/** 统一的「返回错误」出口，固定长成 { error: '提示', code: '错误码' }。 */
function fail(res, status, message, code = 'ERROR', extraHeaders = {}) {
  json(res, status, { error: message, code }, extraHeaders)
}

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000

function enforceRateLimit(res, key, limit, windowMs, message = '操作过于频繁，请稍后再试') {
  const result = consumeRateLimit(key, limit, windowMs)
  if (result.allowed) return true
  fail(res, 429, message, 'RATE_LIMITED', { 'Retry-After': result.retryAfterSec })
  return false
}

function accountRateKey(email, ip) {
  const digest = crypto.createHash('sha256').update(`${ip}\0${String(email || '')}`).digest('hex').slice(0, 20)
  return `login-account:${digest}`
}

const activeUploadsByUser = new Map()
let activeUploadsTotal = 0

function acquireUploadSlot(userId) {
  const current = activeUploadsByUser.get(userId) || 0
  if (activeUploadsTotal >= 32 || current >= 4) return false
  activeUploadsByUser.set(userId, current + 1)
  activeUploadsTotal += 1
  return true
}

function releaseUploadSlot(userId) {
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
 */
function readJson(req, limit = 256 * 1024) {
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
 */
async function streamToFile(req, dest, limit) {
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
 * 这里每次请求都要查一次数据库，听起来很重，实际上主键查询是微秒级的，
 * 而且能保证「用户一被删除就立刻失去访问权」。
 */
export function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '')
  let token = cookies[SESSION_COOKIE]

  // 也支持用 Authorization 请求头传令牌，方便命令行/第三方调用
  const authHeader = req.headers.authorization || ''
  if (!token && authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim()

  const payload = verifyToken(token)   // 验签失败、过期都会返回 null
  if (!payload) return null

  const user = findUserById(payload.uid)
  if (!user) return null
  // 修改密码会递增 sessionVersion，旧设备上的令牌立即失效
  if (!Number.isInteger(payload.ver) || payload.ver !== user.sessionVersion) return null
  return user
}

/**
 * 把用户数据「脱敏」后再发给前端。
 * 记录里存着 salt 和 passwordHash，绝对不能原样返回 ——
 * 即使前端不显示，打开开发者工具也能看到。
 */
function publicUser(user) {
  return { id: user.id, email: user.email, nickname: user.nickname, createdAt: user.createdAt }
}

/** 同理，文件记录里的 storedName 是内部存储名，不对外暴露。 */
function publicFile(record) {
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
function safeExt(name, mime) {
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
function sanitizeName(raw) {
  const name = String(raw || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return (name || '未命名文件').slice(0, 180)
}

/** 确保「这个用户的上传目录」存在，并返回它的路径。 */
function ensureOwnedDir(ownerId) {
  const dir = path.join(UPLOAD_DIR, ownerId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 删掉磁盘上的文件本体（数据库记录由调用方另外删除）。 */
function removeStoredFile(record) {
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, record.ownerId, record.storedName))
  } catch {
    /* 文件已经不在了，忽略即可 */
  }
}

/** 把字节数转成看得懂的单位，用于错误提示。 */
function formatBytes(bytes) {
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
async function hashStoredFile(record) {
  const filePath = path.join(UPLOAD_DIR, record.ownerId, record.storedName)
  const hasher = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) {
    hasher.update(chunk)
  }
  return hasher.digest('hex')
}

/** 查找同一用户是否已经上传过完全相同的内容（包含回收站）。 */
async function findDuplicateUpload(ownerId, size, contentHash) {
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

function duplicateUploadResponse(res, record) {
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

/**
 * 把磁盘上的文件发给浏览器。
 *
 * @param {string} disposition 'inline' 页面内直接显示（图片/视频预览）
 *                            'attachment' 触发下载，浏览器弹「另存为」
 */
function sendStoredFile(req, res, record, disposition) {
  const filePath = path.join(UPLOAD_DIR, record.ownerId, record.storedName)

  let stat
  try {
    stat = fs.statSync(filePath)   // 拿文件大小，后面算 Content-Length 要用
  } catch {
    return fail(res, 404, '文件已丢失', 'FILE_MISSING')
  }

  /**
   * 文件名里可能有中文，放进响应头会乱码，所以用 encodeURIComponent 编码。
   * filename*=UTF-8''xxx 是专门为这种场景设计的写法。
   */
  const encodedName = encodeURIComponent(record.name)
  const inlineType = disposition === 'inline' ? safeInlineMime(record.name, record.mime) : null
  const effectiveDisposition = inlineType ? 'inline' : 'attachment'
  const etag = `"${record.contentHash || `${stat.size}-${Math.floor(stat.mtimeMs)}`}"`
  const lastModified = stat.mtime.toUTCString()

  const headers = {
    // 非安全内联类型统一按二进制附件返回，防止 HTML / SVG 等主动内容执行脚本
    'Content-Type': inlineType || 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',   // 同一用户重复拖动时可复用已下载片段
    'Accept-Ranges': 'bytes',                   // 告诉浏览器「我支持分段请求」
    'Content-Disposition': `${effectiveDisposition}; filename*=UTF-8''${encodedName}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Download-Options': 'noopen',
    // 让 Nginx 对视频 Range 响应实时透传，而不是先缓存整段再发给浏览器
    'X-Accel-Buffering': 'no',
    ETag: etag,
    'Last-Modified': lastModified,
    Vary: 'Range',
  }

  // HEAD 只返回响应头；否则下载接口会被 HEAD 请求触发完整文件读取
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    return res.end()
  }

  /**
   * ── Range 请求 ────────────────────────────────────────────────────
   *
   * 为什么视频能拖动进度条？靠的就是这个。
   * 浏览器看视频时不会傻等整个文件下完，它会说：
   *   "我只要第 1000000 到 2000000 字节" →  Range: bytes=1000000-2000000
   * 服务器只发这一段（状态码 206 而不是 200），于是能秒开、能拖。
   */
  const range = req.headers.range
  const ifRange = String(req.headers['if-range'] || '').trim()
  const rangeIsFresh = !ifRange || ifRange === etag || ifRange === lastModified
  if (range && rangeIsFresh) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    if (match) {
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])

      if (start === null && end !== null) {
        // "bytes=-500" 表示「最后 500 字节」
        start = Math.max(0, stat.size - end)
        end = stat.size - 1
      } else {
        if (start === null) start = 0
        if (end === null || end >= stat.size) end = stat.size - 1
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` })   // 416 = 范围无法满足
        return res.end()
      }

      // 浏览器经常发送 "bytes=start-"，也就是一直读到文件末尾。
      // 对 250MB 视频连续拖动几次会制造多条超长连接，因此主动切成可控大小的分段。
      const responseEnd = Math.min(end, start + MEDIA_RANGE_CHUNK_BYTES - 1)
      res.writeHead(206, {   // 206 = 部分内容
        ...headers,
        'Content-Range': `bytes ${start}-${responseEnd}/${stat.size}`,
        'Content-Length': responseEnd - start + 1,
      })
      streamOut(fs.createReadStream(filePath, {
        start,
        end: responseEnd,
        highWaterMark: 256 * 1024,
      }), res)
      return
    }
  }

  // 没有 Range（普通下载）→ 整个文件流式发出
  const noneMatch = String(req.headers['if-none-match'] || '')
    .split(',')
    .map((tag) => tag.trim())
  if (noneMatch.includes(etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
    return res.end()
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size })
  streamOut(fs.createReadStream(filePath, { highWaterMark: 256 * 1024 }), res)
}

/**
 * 把读取流接到响应上。
 *
 * 为什么用 pipeline 而不是 readStream.pipe(res)？
 *   pipe 在客户端中途断开时（比如视频看到一半关掉页面），
 *   不会销毁读取流，文件句柄会一直开着。用户频繁拖动进度条、
 *   反复关闭页面，句柄就越积越多，最后 EMFILE 导致全站打不开文件。
 *   pipeline 会在任一端出错或关闭时，把两边都清理干净。
 *
 * 回调里的错误直接忽略：客户端主动断开是正常操作，不是故障。
 */
function streamOut(readStream, res) {
  pipeStream(readStream, res, () => {
    /* 客户端中断属正常情况，无需处理 */
  })
}

/* ══════════════════════════════════════════════════════════════════════════
   三、认证相关接口
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 注册。
 * 流程：校验 → 查重 → 哈希密码 → 存用户 → 直接签发令牌（注册完即登录）
 */
async function handleRegister(req, res) {
  const body = await readJson(req)
  if (!enforceRateLimit(res, `register:${requestIp(req)}`, 10, REGISTER_RATE_WINDOW_MS, '注册请求过于频繁，请稍后再试')) return

  // 一律转小写，避免 Alice@x.com 和 alice@x.com 注册成两个账号
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  // 没填昵称就用邮箱 @ 前面那段
  const nickname = sanitizeName(body.nickname || email.split('@')[0]).slice(0, 32)

  // 先做各种检查，有问题就提前返回 —— 这叫「尽早失败」
  if (!EMAIL_RE.test(email)) return fail(res, 400, '请输入有效的邮箱地址', 'INVALID_EMAIL')
  if (password.length < 8) return fail(res, 400, '密码至少需要 8 位', 'WEAK_PASSWORD')
  if (password.length > 128) return fail(res, 400, '密码不能超过 128 位', 'PASSWORD_TOO_LONG')

  /**
   * 注册码校验。
   *
   * 放在「格式检查之后、查重之前」，顺序是有讲究的：
   *   - 放在最后 → 没有注册码的人也能通过「邮箱已注册」这个提示，
   *     批量探测出哪些邮箱在本站注册过
   *   - 放在最前 → 用户填错邮箱格式还要先过一次注册码，多一轮往返
   * 夹在中间两边都兼顾：格式错误优先反馈，探测被注册码挡住。
   */
  if (REQUIRE_REGISTRATION_CODE) {
    const registrationCode = String(body.registrationCode || '')
    if (!registrationCode.trim()) {
      return fail(res, 403, '请填写注册码', 'REGISTRATION_CODE_REQUIRED')
    }
    if (!isRegistrationCodeValid(registrationCode)) {
      return fail(res, 403, '注册码不正确', 'INVALID_REGISTRATION_CODE')
    }
  }

  if (findUserByEmail(email)) {
    return fail(res, 409, '该邮箱已注册，请直接登录', 'EMAIL_TAKEN')
  }

  const { salt, hash } = await hashPassword(password)

  const user = {
    // randomUUID 生成全球唯一的随机串，去掉横杠后取前 20 位当用户 id
    id: `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    email,
    nickname,
    salt,          // 盐
    passwordHash: hash,  // 哈希后的密码（绝不存明文）
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
  }
  createUser(user)   // 写入数据库

  const token = signToken({ uid: user.id, ver: user.sessionVersion })
  // 201 = 已创建。顺便通过 Set-Cookie 把登录凭证发给浏览器，注册完直接就是登录状态。
  json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, cookieOptions(req)) })
}

/** 登录：比对密码，成功就签发令牌。 */
async function handleLogin(req, res) {
  const body = await readJson(req)
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const ip = requestIp(req)
  const accountKey = accountRateKey(email, ip)

  if (!enforceRateLimit(res, `login-ip:${ip}`, 120, RATE_LIMIT_WINDOW_MS, '登录尝试过于频繁，请稍后再试')) return
  if (!enforceRateLimit(res, accountKey, 10, RATE_LIMIT_WINDOW_MS, '该账号登录尝试过于频繁，请稍后再试')) return

  if (password.length > 128) {
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }

  const user = findUserByEmail(email)

  /**
   * 注意：邮箱不存在和密码错误，返回的是同一句话「邮箱或密码不正确」。
   * 如果分开提示，攻击者就能靠试错问出「这个邮箱注册过没有」，
   * 从而拿到一份有效邮箱名单去撞库。这叫「不泄露账号是否存在」。
   */
  if (!user) {
    await verifyPassword(password, DUMMY_SALT, DUMMY_HASH)
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }
  if (!(await verifyPassword(password, user.salt, user.passwordHash))) {
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }

  resetRateLimit(accountKey)
  const token = signToken({ uid: user.id, ver: user.sessionVersion })
  json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, cookieOptions(req)) })
}

/** 修改密码：先验旧密码，再存新密码的哈希。 */
async function handleChangePassword(req, res, user) {
  const body = await readJson(req)
  if (!enforceRateLimit(res, `password:${user.id}`, 10, RATE_LIMIT_WINDOW_MS, '改密操作过于频繁，请稍后再试')) return
  const oldPassword = String(body.oldPassword || '')
  const newPassword = String(body.newPassword || '')

  if (!(await verifyPassword(oldPassword, user.salt, user.passwordHash))) {
    return fail(res, 400, '当前密码不正确', 'INVALID_CREDENTIALS')
  }
  if (newPassword.length < 8) return fail(res, 400, '新密码至少需要 8 位', 'WEAK_PASSWORD')
  if (newPassword.length > 128) return fail(res, 400, '新密码不能超过 128 位', 'PASSWORD_TOO_LONG')

  const { salt, hash } = await hashPassword(newPassword)
  updateUserPassword(user.id, salt, hash)   // 盐也要同步换新，并撤销其它旧会话
  const updatedUser = findUserById(user.id)
  if (!updatedUser) return fail(res, 500, '账号状态异常', 'USER_MISSING')
  const token = signToken({ uid: updatedUser.id, ver: updatedUser.sessionVersion })
  json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, cookieOptions(req)) })
}

/* ══════════════════════════════════════════════════════════════════════════
   四、文件相关接口
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 上传。
 *
 * 【为什么不走普通的表单上传】
 *   传统做法是 multipart/form-data，服务器还得解析那段复杂的格式。
 *   本项目的做法更直接：请求体就是文件的原始内容（raw body），
 *   文件名放在 URL 查询参数里，例如：
 *     POST /api/files/upload?name=照片.png
 *   分类由服务端通过 lib/media.js 自动判断，不受客户端当前浏览页面影响。
 *   这样服务端可以直接把请求体原样写入磁盘，中间不做任何解析。
 *
 * 【三层容量把关】
 *   1. 用户配额：这个人还能存多少
 *   2. 磁盘余量：整个分区还剩多少
 *   3. 流式实时计数：真正的兜底，不管前面声明什么，超了就断
 *   只有第 3 层是绝对可靠的，前两层是为了「快速拒绝」和「给出好懂的提示」。
 */
async function handleUpload(req, res, url, user) {
  const name = sanitizeName(url.searchParams.get('name'))
  const reportedMime = String(req.headers['content-type'] || 'application/octet-stream')
  const mime = inferMime(name, reportedMime)
  // 分类必须由服务端按真实类型判断，不能让“当前浏览的分类”覆盖 MP3 等媒体类型
  const category = detectCategory(mime, name)

  // ── 第 1 层：用户配额 ────────────────────────────────────────────────
  const used = totalBytesFor(user.id)
  let allowance = MAX_UPLOAD_BYTES

  if (MAX_USER_BYTES > 0) {
    const remaining = MAX_USER_BYTES - used
    if (remaining <= 0) {
      return fail(res, 413, `存储空间已满（上限 ${formatBytes(MAX_USER_BYTES)}），请先删除一些文件`, 'QUOTA_EXCEEDED')
    }
    allowance = Math.min(allowance, remaining)
  }

  // ── 第 2 层：磁盘余量 ────────────────────────────────────────────────
  const free = freeDiskBytes(DATA_DIR)
  if (free !== null && free < MIN_FREE_BYTES) {
    return fail(res, 507, '服务器磁盘空间不足，暂时无法上传，请联系管理员', 'INSUFFICIENT_STORAGE')
  }
  if (free !== null) {
    allowance = Math.min(allowance, Math.max(0, free - MIN_FREE_BYTES))
  }

  // 浏览器提前告知了大小就先粗筛一遍，省得白传一场
  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > allowance) {
    const reason = MAX_USER_BYTES > 0 && declared > MAX_USER_BYTES - used
      ? `剩余空间不足（还能存 ${formatBytes(Math.max(0, MAX_USER_BYTES - used))}）`
      : `文件超出上限（最大 ${formatBytes(allowance)}）`
    return fail(res, 413, reason, 'FILE_TOO_LARGE')
  }

  // 磁盘上的名字 = 随机 id + 安全扩展名（再次强调：不用用户给的文件名）
  const id = crypto.randomUUID()
  const storedName = `${id}${safeExt(name, mime)}`
  const dir = ensureOwnedDir(user.id)      // 每个用户一个独立文件夹
  const dest = path.join(dir, storedName)

  let size = 0
  let contentHash = ''
  try {
    // ── 第 3 层：流式实时计数，真正的兜底 ──────────────────────────────
    const uploaded = await streamToFile(req, dest, allowance)
    size = uploaded.size
    contentHash = uploaded.contentHash
  } catch (error) {
    // 中途失败（超限、超时或网络断了）→ 把写了一半的文件删掉，别留垃圾
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    if (error && error.status === 413) {
      return fail(res, 413, `超出可用容量（最多 ${formatBytes(allowance)}）`, 'FILE_TOO_LARGE')
    }
    if (error && error.status === 408) {
      return fail(res, 408, '上传中断：长时间没有收到数据', 'UPLOAD_TIMEOUT')
    }
    return fail(res, 500, '上传失败，请重试', 'UPLOAD_FAILED')
  }

  // 空文件没意义，也删掉
  if (size === 0) {
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    return fail(res, 400, '文件内容为空', 'EMPTY_FILE')
  }

  const duplicate = await findDuplicateUpload(user.id, size, contentHash)
  if (duplicate) {
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }
    return duplicateUploadResponse(res, duplicate)
  }

  const now = new Date().toISOString()
  const record = {
    id,
    ownerId: user.id,   // ★ 归属由服务端写入，前端传什么都改不了这一点
    name,               // 用户看到的原始文件名
    category,
    mime,
    contentHash,        // SHA-256：用于阻止同一用户重复上传相同内容
    size,               // 实际写入的字节数（用真实值，不信前端报的）
    storedName,         // 磁盘上的随机文件名
    createdAt: now,
    updatedAt: now,
  }

  /**
   * 写数据库失败时（比如磁盘刚好满），要把刚写好的文件删掉，
   * 否则会留下一个「数据库里没有、磁盘上占着空间」的孤儿文件。
   * 数据库写入是事务性的，要么成功要么完全没写，不会出现半条记录。
   */
  try {
    createFile(record)
  } catch (error) {
    try {
      fs.unlinkSync(dest)
    } catch {
      /* ignore */
    }

    // 并发上传同一文件时，唯一索引是最后一道防线
    const concurrentDuplicate = findFileByContentHash(user.id, contentHash)
    if (concurrentDuplicate) return duplicateUploadResponse(res, concurrentDuplicate)

    console.error('[upload] 写入数据库失败:', error && error.message)
    return fail(res, 500, '保存记录失败，请重试', 'DB_WRITE_FAILED')
  }

  json(res, 201, { file: publicFile(record) })
}

/**
 * 列表：分页 + 分类筛选 + 名称搜索 + 排序，并顺带返回用量统计。
 *
 * 【为什么要分页】
 *   之前是一次性返回全部记录。文件攒到几千个以后，
 *   一次响应要传几百 KB，前端还要一次性建出几千个 DOM 节点，
 *   浏览器先卡住，随后大量缩略图请求同时涌向服务器。
 *   分页之后，单次响应大小和渲染成本都是恒定的，
 *   不管你有 10 个文件还是 10 万个文件，打开速度都一样。
 */
function handleList(req, res, url, user) {
  const categoryParam = url.searchParams.get('category')
  const category = CATEGORIES.includes(categoryParam) ? categoryParam : null
  const query = String(url.searchParams.get('q') || '').trim()
  const sort = url.searchParams.get('sort') || 'newest'

  // 把前端传来的分页参数限制在合理范围内，防止有人传 limit=999999 拖垮服务
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
    : PAGE_SIZE
  const rawOffset = Number(url.searchParams.get('offset'))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  const filter = { ownerId: user.id, category, query }

  // 数据库只返回这一页的数据
  const rows = listFiles({ ...filter, sort, limit, offset })
  const total = countFiles(filter)

  json(res, 200, {
    files: rows.map(publicFile),
    usage: usageFor(user.id),
    page: {
      limit,
      offset,
      total,
      hasMore: offset + rows.length < total,
    },
  })
}

/** 改名或改分类。 */
async function handlePatch(req, res, id, user) {
  // ★ 只在「正常文件」里找，回收站里的不允许改名
  const existing = findActiveFileForOwner(id, user.id)
  if (!existing) return fail(res, 404, '文件不存在', 'NOT_FOUND')

  const body = await readJson(req)
  const patch = { updatedAt: new Date().toISOString() }

  // 只接受合法的字段，其它一律忽略（防止前端塞进来 ownerId 之类的字段搞破坏）
  if (typeof body.name === 'string' && body.name.trim()) patch.name = sanitizeName(body.name)
  if (CATEGORIES.includes(body.category)) patch.category = body.category

  const updated = updateFile(id, user.id, patch)
  if (!updated) return fail(res, 404, '文件不存在', 'NOT_FOUND')
  json(res, 200, { file: publicFile(updated) })
}

/* ──────────────────────────── 回收站 ──────────────────────────── */

/**
 * 删除 → 移入回收站，不真删。
 *
 * 只给记录打一个 deleted_at 时间戳：
 *   - 数据库行还在
 *   - 磁盘文件还在
 *   - 但列表查询会把它过滤掉（deleted_at IS NULL）
 * 24 小时内可以恢复，超时由定时任务真正清除。
 */
function handleDelete(res, id, user) {
  const record = softDeleteFile(id, user.id)
  if (!record) return fail(res, 404, '文件不存在', 'NOT_FOUND')

  json(res, 200, {
    ok: true,
    file: publicFile(record),
    trashTtlMs: TRASH_TTL_MS,
  })
}

/** 由删除时间推算自动清除时间，前端拿来显示倒计时。 */
function trashExpiresAt(deletedAt) {
  const ts = Date.parse(deletedAt)
  if (Number.isNaN(ts)) return null
  return new Date(ts + TRASH_TTL_MS).toISOString()
}

/** 回收站列表。分页逻辑和普通列表一致，只是数据源换成已删除的记录。 */
function handleTrashList(req, res, url, user) {
  const rawLimit = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
    : PAGE_SIZE
  const rawOffset = Number(url.searchParams.get('offset'))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  const query = String(url.searchParams.get('q') || '').trim()
  const filter = { ownerId: user.id, deleted: true, query }
  const rows = listFiles({ ...filter, sort: 'deleted', limit, offset })
  const total = countFiles(filter)

  json(res, 200, {
    files: rows.map((record) => ({
      ...publicFile(record),
      expiresAt: trashExpiresAt(record.deletedAt),
    })),
    usage: usageFor(user.id),
    page: { limit, offset, total, hasMore: offset + rows.length < total },
    ttlMs: TRASH_TTL_MS,
  })
}

/** 从回收站恢复。 */
function handleRestore(res, id, user) {
  const record = restoreFile(id, user.id)
  if (!record) return fail(res, 404, '回收站里没有这个文件', 'NOT_FOUND')
  json(res, 200, { ok: true, file: publicFile(record) })
}

/**
 * 彻底删除单个文件：先删磁盘，再删记录。
 *
 * 为什么先删磁盘？如果先删记录后删磁盘时失败，磁盘上就留下一个
 * 谁也访问不到的孤儿文件，永远占着空间。反过来先删磁盘，
 * 即便记录删除失败，下次定时清理还会再试一次。
 */
function handlePurge(res, id, user) {
  const record = findFileForOwner(id, user.id)
  if (!record || !record.deletedAt) {
    return fail(res, 404, '回收站里没有这个文件', 'NOT_FOUND')
  }

  removeStoredFile(record)
  purgeFile(id, user.id)
  json(res, 200, { ok: true })
}

/** 清空回收站：一次性把所有已删除的文件彻底清除。 */
function handleEmptyTrash(res, user) {
  const rows = emptyTrashFor(user.id)
  for (const record of rows) removeStoredFile(record)
  json(res, 200, { ok: true, removed: rows.length })
}

/**
 * 定时清扫：把所有超过 24 小时的回收站文件真正删掉。
 *
 * 启动时先立即扫一次（进程重启过，期间可能已经过期了），
 * 之后每 10 分钟扫一次。
 *
 * 为什么用 setInterval 而不是精确的定时器？
 *   过期时间点很分散，为每个文件挂一个定时器既费内存、
 *   又会在重启后全部丢失。定期扫描的语义更简单可靠：
 *   「每 10 分钟问一次，有没有谁该走了」——
 *   最坏情况是晚 10 分钟清理，用户完全感知不到。
 */
export function startTrashSweeper() {
  const sweep = () => {
    try {
      const cutoff = new Date(Date.now() - TRASH_TTL_MS).toISOString()
      const expired = listExpiredFiles(cutoff)

      for (const record of expired) {
        removeStoredFile(record)
        purgeFile(record.id, record.ownerId)
      }

      if (expired.length) {
        console.log(`[trash] 已清理 ${expired.length} 个超过 24 小时的文件`)
      }
    } catch (error) {
      console.error('[trash] 清理失败:', error && error.message)
    }
  }

  sweep()
  const timer = setInterval(sweep, TRASH_SWEEP_INTERVAL_MS)
  // unref：这个定时器不应该拖住进程退出
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}

/* ══════════════════════════════════════════════════════════════════════════
   五、路由（把「请求」分派给上面那些处理函数）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 处理本次请求。
 * @returns {Promise<boolean>} true  = 已经处理完了
 *                             false = 不是接口请求，交回 server.js 去发静态文件
 *
 * 整个函数就是一个大的 if 判断链：按「路径 + 方法」找到该执行哪段代码。
 * 这叫「路由」，是所有 Web 框架最核心的东西。
 */
export async function handleApi(req, res, url) {
  const { pathname } = url

  // 不是 /api/ 开头就不是接口请求，直接交回去
  if (!pathname.startsWith('/api/')) return false

  try {
    /**
     * 来源校验。
     * 浏览器发起的请求会带 Origin 头（标明来自哪个网站）。
     * 只允许「同源」或「配置过的白名单来源」，其它一律 403。
     *
     * 这一层在 Cookie 放宽为 SameSite=None 之后尤其重要：
     * 否则别的网站可以偷偷借用你浏览器里的登录凭证来操作本系统（CSRF 攻击）。
     */
    // 浏览器播放视频时会自动发起大量 Range 请求；媒体流必须使用独立高额度，
    // 否则连续拖动或长时间缓冲后会被普通 API 的限流误伤，表现为视频永久卡住。
    const isMediaStream = /^\/api\/files\/[A-Za-z0-9_-]+\/(?:raw|download)$/.test(pathname)
    const apiLimit = isMediaStream ? 3000 : 600
    const rateScope = isMediaStream ? 'media' : 'api'
    if (!enforceRateLimit(res, `${rateScope}:${requestIp(req)}`, apiLimit, 60_000, '请求过于频繁，请稍后再试')) return true

    const origin = req.headers.origin
    const fetchSite = String(req.headers['sec-fetch-site'] || '')
    if ((!origin && fetchSite === 'cross-site') || (origin && !isOriginAllowed(req, origin))) {
      // 注意：这里必须是「先 fail 再 return true」。
      // 如果写成 `return fail(...)`，返回的是 undefined，
      // server.js 会误以为「这个接口没处理」，接着又去走静态文件分支，
      // 造成同一个请求写两次响应头（ERR_HTTP_HEADERS_SENT）。
      fail(res, 403, '请求来源不被允许', 'ORIGIN_NOT_ALLOWED')
      return true
    }

    /* ── 公开接口：不需要登录 ────────────────────────────────────────── */
    /**
     * 告诉前端「注册需不需要注册码」。
     * 前端据此决定要不要显示注册码输入框 —— 不需要时不该让用户看到一个多余的空格。
     * 这个接口不返回注册码本身，只返回一个布尔值。
     */
    if (pathname === '/api/auth/config' && req.method === 'GET') {
      json(res, 200, { requireRegistrationCode: REQUIRE_REGISTRATION_CODE })
      return true
    }
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      await handleRegister(req, res)
      return true
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      await handleLogin(req, res)
      return true
    }

    /* ── 以下接口都需要登录 ─────────────────────────────────────────── */
    const user = getSessionUser(req)

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      // 清除 Cookie 即可。因为令牌是无状态的，服务端没有「会话表」要清理。
      json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(cookieOptions(req)) })
      return true
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      if (!user) {
        fail(res, 401, '未登录', 'UNAUTHENTICATED')
        return true
      }
      json(res, 200, { user: publicUser(user) })
      return true
    }

    /**
     * ★ 登录闸门 ★
     * 放在这里意味着：下面所有接口一旦没登录，统统会被挡掉返回 401。
     * 这样的好处是不用在每个处理函数里重复写一遍登录检查 ——
     * 万一漏写一个就是漏洞，集中判断更安全。
     */
    if (!user) {
      fail(res, 401, '请先登录', 'UNAUTHENTICATED')
      return true
    }

    if (pathname === '/api/auth/password' && req.method === 'PATCH') {
      await handleChangePassword(req, res, user)
      return true
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      handleList(req, res, url, user)
      return true
    }
    if (pathname === '/api/files/upload' && req.method === 'POST') {
      if (!enforceRateLimit(res, `upload:${user.id}`, 120, 60 * 60 * 1000, '上传过于频繁，请稍后再试')) return true
      if (!acquireUploadSlot(user.id)) {
        fail(res, 503, '当前上传任务过多，请稍后再试', 'UPLOAD_BUSY', { 'Retry-After': 1 })
        return true
      }
      try {
        await handleUpload(req, res, url, user)
      } finally {
        releaseUploadSlot(user.id)
      }
      return true
    }

    /* ── 回收站 ──────────────────────────────────────────────────────── */
    if (pathname === '/api/trash' && req.method === 'GET') {
      handleTrashList(req, res, url, user)
      return true
    }
    if (pathname === '/api/trash' && req.method === 'DELETE') {
      handleEmptyTrash(res, user)
      return true
    }

    // /api/trash/:id —— 彻底删除单个文件
    const purgeMatch = /^\/api\/trash\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (purgeMatch && req.method === 'DELETE') {
      handlePurge(res, purgeMatch[1], user)
      return true
    }

    // /api/files/:id/restore —— 从回收站恢复
    const restoreMatch = /^\/api\/files\/([A-Za-z0-9_-]+)\/restore$/.exec(pathname)
    if (restoreMatch) {
      if (req.method !== 'POST') {
        fail(res, 405, '方法不支持', 'METHOD_NOT_ALLOWED')
        return true
      }
      handleRestore(res, restoreMatch[1], user)
      return true
    }

    /**
     * 带 id 的路径用「正则」匹配。
     *   ([A-Za-z0-9_-]+)       第一个括号 = 文件 id
     *   (?:\/(raw|download))?   可选的后缀：raw（预览）或 download（下载）
     * 匹配上之后，match[1] 是 id，match[2] 是 'raw' / 'download' / undefined
     */
    const match = /^\/api\/files\/([A-Za-z0-9_-]+)(?:\/(raw|download))?$/.exec(pathname)
    if (match) {
      const [, id, action] = match

      if (action === 'raw' || action === 'download') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fail(res, 405, '方法不支持', 'METHOD_NOT_ALLOWED')
          return true
        }
        // ★ 归属检查：不是本人的文件当作不存在
        const record = findFileForOwner(id, user.id)
        if (!record) {
          fail(res, 404, '文件不存在', 'NOT_FOUND')
          return true
        }
        // 预览用 inline（页面里直接显示），下载用 attachment（弹另存为）
        sendStoredFile(req, res, record, action === 'download' ? 'attachment' : 'inline')
        return true
      }
      if (req.method === 'PATCH') {
        await handlePatch(req, res, id, user)
        return true
      }
      if (req.method === 'DELETE') {
        handleDelete(res, id, user)
        return true
      }
    }

    // 路径以 /api/ 开头但没有匹配上任何规则 → 接口不存在
    fail(res, 404, '接口不存在', 'NOT_FOUND')
    return true
  } catch (error) {
    /**
     * 兜底错误处理。
     * 上面任何一步抛出异常都会落到这里，保证接口一定给出一个明确回应，
     * 而不是让浏览器一直转圈等超时。
     */
    if (res.headersSent) return true   // 响应已经开始发了，没法再改状态码

    const status = error && error.status ? error.status : 500
    // 500 是「服务器自己的问题」，不该把内部错误详情泄露给用户
    const message = status === 500 ? '服务器开小差了，请稍后重试' : error.message
    if (status === 500) console.error('[api]', error && error.message)
    fail(res, status, message, status === 500 ? 'INTERNAL' : 'BAD_REQUEST')
    return true
  }
}
