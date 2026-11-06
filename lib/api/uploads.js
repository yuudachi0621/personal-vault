/** 上传处理器：分块会话、兼容上传、配额与媒体派生任务。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readJsonBody } from '../request-body.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { UPLOAD_DIR, DATA_DIR } from '../paths.js'
import { inferMime, detectCategory } from '../media.js'
import { MAX_USER_BYTES, MAX_UPLOAD_BYTES, MIN_FREE_BYTES, UPLOAD_IDLE_TIMEOUT_MS, freeDiskBytes } from '../config.js'
import {
  UPLOAD_CHUNK_BYTES, createUploadSession, getUploadSession, deleteUploadSession,
  appendUploadChunk, hashUploadSession, uploadSessionPartPath, verifyUploadSessionPart,
  countUploadSessions, reservedUploadBytes, cleanupExpiredUploadSessions, uploadSessionExpiresAt,
} from '../upload-session.js'
import { createFile, findFileByContentHash, totalBytesFor } from '../store.js'
import { queueVideoPreview } from '../video-preview.js'
import { queueMediaThumbnail } from '../media-thumbnail.js'
import { prepareUploadRecord } from '../upload-finalizer.js'
import {
  acquireUploadSlot, releaseUploadSlot, enforceRateLimit, getPrivacyUser, privacyLocked,
  streamToFile, safeExt, sanitizeName, ensureOwnedDir, formatBytes,
  findDuplicateUpload, duplicateUploadResponse, publicFile,
} from './core.js'
/* ══════════════════════════════════════════════════════════════════════════
   四、文件相关接口
   ══════════════════════════════════════════════════════════════════════════ */

/** 派发上传完成后的缩略图和视频预览任务。 */
export function queueDerivedMedia(record) {
  if (!['image', 'video'].includes(record.category)) return
  setImmediate(() => {
    if (record.category === 'video') void queueVideoPreview(record)
    void queueMediaThumbnail(record)
  })
}

export function publicUploadSession(meta) {
  return {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    offset: meta.offset,
    chunkSize: UPLOAD_CHUNK_BYTES,
    isPrivate: meta.isPrivate,
    expiresAt: uploadSessionExpiresAt(meta),
  }
}

export function uploadSessionHeaders(meta) {
  return {
    'Upload-Offset': String(meta.offset),
    'Upload-Length': String(meta.size),
    'Cache-Control': 'no-store',
  }
}

/** 创建断点续传上传会话，并预留完整文件容量。 */
export async function handleCreateUploadSession(req, res, user) {
  if (!enforceRateLimit(res, `upload-create:${user.id}`, 120, 60 * 60 * 1000, '创建上传任务过于频繁，请稍后再试')) return
  cleanupExpiredUploadSessions()
  const body = await readJsonBody(req)
  const name = sanitizeName(body.name)
  const mime = inferMime(name, body.mime)
  const category = detectCategory(mime, name)
  const size = Number(body.size)
  const isPrivate = body.private === true

  if (!Number.isInteger(size) || size <= 0) return fail(res, 400, '文件大小无效', 'INVALID_FILE_SIZE')
  if (size > MAX_UPLOAD_BYTES) {
    return fail(res, 413, `文件超出单文件上限（${formatBytes(MAX_UPLOAD_BYTES)}）`, 'FILE_TOO_LARGE')
  }
  if (isPrivate && !getPrivacyUser(req, user)) return privacyLocked(res)

  const used = totalBytesFor(user.id)
  const reserved = reservedUploadBytes(user.id)
  if (MAX_USER_BYTES > 0 && used + reserved + size > MAX_USER_BYTES) {
    return fail(res, 413, `剩余空间不足（还能存 ${formatBytes(Math.max(0, MAX_USER_BYTES - used - reserved))}）`, 'QUOTA_EXCEEDED')
  }
  const free = freeDiskBytes(DATA_DIR)
  if (free !== null && free < MIN_FREE_BYTES) {
    return fail(res, 507, '服务器磁盘空间不足，暂时无法上传，请联系管理员', 'INSUFFICIENT_STORAGE')
  }
  if (countUploadSessions(user.id) >= 4) {
    return fail(res, 503, '当前上传任务过多，请先完成或取消已有任务', 'UPLOAD_BUSY')
  }

  const meta = createUploadSession({ ownerId: user.id, name, category, mime, size, isPrivate })
  json(res, 201, { upload: publicUploadSession(meta) })
}

/** 查询断点续传状态。 */
export function handleUploadSessionStatus(req, res, id, user) {
  const meta = getUploadSession(user.id, id)
  if (!meta) return fail(res, 404, '上传任务不存在或已过期', 'UPLOAD_SESSION_NOT_FOUND')
  if (meta.isPrivate && !getPrivacyUser(req, user)) return privacyLocked(res)
  if (req.method === 'HEAD') {
    res.writeHead(200, uploadSessionHeaders(meta))
    res.end()
    return
  }
  json(res, 200, { upload: publicUploadSession(meta) }, uploadSessionHeaders(meta))
}

/** 完成最后一块后，把临时文件转为正式文件记录。 */
export async function finalizeUploadSession(meta, user) {
  if (!verifyUploadSessionPart(meta)) {
    throw Object.assign(new Error('上传文件长度校验失败，请重新上传'), { status: 409, code: 'UPLOAD_INCOMPLETE' })
  }
  const contentHash = await hashUploadSession(meta)
  let prepared
  try {
    prepared = await prepareUploadRecord({
      user,
      name: meta.name,
      category: meta.category,
      mime: meta.mime,
      size: meta.size,
      contentHash,
      isPrivate: meta.isPrivate,
    })
  } catch (error) {
    if (error && error.code === 'DUPLICATE_FILE') deleteUploadSession(user.id, meta.id)
    throw error
  }

  const destDir = ensureOwnedDir(user.id)
  const dest = path.join(destDir, prepared.storedName)
  try {
    // 注意：rename 与 createFile 不是跨资源原子操作；进程崩溃可能产生孤儿文件。
    fs.renameSync(uploadSessionPartPath(meta), dest)
    createFile(prepared.record)
    deleteUploadSession(user.id, meta.id)
  } catch (error) {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    const concurrentDuplicate = findFileByContentHash(user.id, contentHash)
    if (concurrentDuplicate) {
      deleteUploadSession(user.id, meta.id)
      throw Object.assign(new Error('账号中已存在相同文件，无法重复上传'), {
        status: 409,
        code: 'DUPLICATE_FILE',
        duplicate: concurrentDuplicate,
      })
    }
    throw error
  }
  return prepared.record
}

/** 追加一个分块；最后一块会自动完成文件入库。 */
export async function handleUploadSessionChunk(req, res, id, user) {
  const meta = getUploadSession(user.id, id)
  if (!meta) return fail(res, 404, '上传任务不存在或已过期', 'UPLOAD_SESSION_NOT_FOUND')
  if (meta.isPrivate && !getPrivacyUser(req, user)) return privacyLocked(res)

  const offset = Number(req.headers['upload-offset'])
  if (!Number.isInteger(offset) || offset < 0) return fail(res, 400, 'Upload-Offset 无效', 'INVALID_UPLOAD_OFFSET')
  if (offset !== meta.offset) {
    return fail(res, 409, '上传偏移量不一致，请从服务端偏移量继续', 'UPLOAD_OFFSET_MISMATCH', uploadSessionHeaders(meta))
  }

  const contentLength = Number(req.headers['content-length'])
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    return fail(res, 411, '缺少有效 Content-Length', 'CONTENT_LENGTH_REQUIRED')
  }
  if (contentLength > UPLOAD_CHUNK_BYTES) {
    return fail(res, 413, '上传分块过大', 'CHUNK_TOO_LARGE', uploadSessionHeaders(meta))
  }
  if (meta.offset + contentLength > meta.size) {
    return fail(res, 413, '上传分块超过文件总大小', 'CHUNK_TOO_LARGE', uploadSessionHeaders(meta))
  }
  if (contentLength === 0 && meta.offset !== meta.size) {
    return fail(res, 400, '上传分块为空', 'EMPTY_CHUNK', uploadSessionHeaders(meta))
  }

  if (!enforceRateLimit(res, `upload-chunk:${user.id}`, 5000, 60 * 60 * 1000, '上传请求过于频繁，请稍后再试')) return
  if (!acquireUploadSlot(user.id)) {
    return fail(res, 503, '当前上传任务过多，请稍后再试', 'UPLOAD_BUSY', { 'Retry-After': 1 })
  }

  try {
    if (contentLength > 0) {
      await appendUploadChunk(meta, req, { maxBytes: contentLength, idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS })
    }

    if (meta.offset !== meta.size) {
      res.writeHead(204, uploadSessionHeaders(meta))
      res.end()
      return
    }

    const record = await finalizeUploadSession(meta, user)
    json(res, 201, { file: publicFile(record), upload: publicUploadSession(meta) }, uploadSessionHeaders(meta))
    queueDerivedMedia(record)
  } catch (error) {
    if (error && error.code === 'DUPLICATE_FILE' && error.duplicate) {
      return duplicateUploadResponse(res, error.duplicate)
    }
    if (error && error.status) {
      return fail(res, error.status, error.message, error.code || 'UPLOAD_FAILED', uploadSessionHeaders(meta))
    }
    console.error('[upload-session] 分块写入失败:', JSON.stringify({ uploadId: id, code: error && error.code, message: error && error.message, details: error && error.details }))
    fail(res, 500, '上传失败，请重试', 'UPLOAD_FAILED', uploadSessionHeaders(meta))
  } finally {
    releaseUploadSlot(user.id)
  }
}

/** 取消上传会话及其临时文件。 */
export function handleCancelUploadSession(req, res, id, user) {
  const meta = getUploadSession(user.id, id)
  if (!meta) return fail(res, 404, '上传任务不存在或已过期', 'UPLOAD_SESSION_NOT_FOUND')
  if (meta.isPrivate && !getPrivacyUser(req, user)) return privacyLocked(res)
  deleteUploadSession(user.id, id)
  json(res, 200, { ok: true })
}
/**
 * 上传。
 *
 * 【为什么不走普通的表单上传】
 *   传统做法是 multipart/form-data，服务器还得解析那段复杂的格式。
 *   本项目的做法更直接：请求体就是文件的原始内容（raw body），
 *   文件名放在 URL 查询参数里，例如：
 *     POST /api/files/upload?name=照片.png
 *     POST /api/files/upload?name=视频.mp4&private=1
 *   分类由服务端通过 lib/media.js 自动判断，不受客户端当前浏览页面影响。
 *   private=1 只有同时持有有效隐私 Cookie 时才接受，并直接创建隐私文件。
 *   这样服务端可以直接把请求体原样写入磁盘，中间不做任何解析。
 *
 * 【三层容量把关】
 *   1. 用户配额：这个人还能存多少
 *   2. 磁盘余量：整个分区还剩多少
 *   3. 流式实时计数：真正的兜底，不管前面声明什么，超了就断
 *   只有第 3 层是绝对可靠的，前两层是为了「快速拒绝」和「给出好懂的提示」。
 */
export async function handleUpload(req, res, url, user) {
  const name = sanitizeName(url.searchParams.get('name'))
  const reportedMime = String(req.headers['content-type'] || 'application/octet-stream')
  const mime = inferMime(name, reportedMime)
  // 分类必须由服务端按真实类型判断，不能让“当前浏览的分类”覆盖 MP3 等媒体类型
  const category = detectCategory(mime, name)

  // 隐私空间内上传必须同时持有有效的隐私解锁 Cookie，不能只信前端传参。
  const isPrivate = url.searchParams.get('private') === '1'
  if (isPrivate && !getPrivacyUser(req, user)) return privacyLocked(res)

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

  let prepared
  try {
    prepared = await prepareUploadRecord({
      user,
      id,
      storedName,
      name,
      category,
      mime,
      size,
      contentHash,
      isPrivate,
    })
  } catch (error) {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    if (error && error.code === 'DUPLICATE_FILE') return duplicateUploadResponse(res, error.duplicate)
    if (error && error.status) return fail(res, error.status, error.message, error.code || 'UPLOAD_FAILED')
    throw error
  }
  const record = prepared.record

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
  queueDerivedMedia(record)
}

