/**
 * 断点续传上传会话。
 *
 * 临时数据放在 data/upload-sessions/<ownerId>/，会话元数据与 .part 文件分开保存。
 * 元数据只在完整写入一个分块后原子更新；服务异常中断时，下次读取会把 .part
 * 截断回已确认偏移量，避免重复或损坏数据进入正式上传目录。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DATA_DIR } from './paths.js'

export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const SESSION_ROOT = path.join(DATA_DIR, 'upload-sessions')
const activeSessions = new Set()

function assertOwnerId(ownerId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(ownerId || ''))) throw new Error('上传会话用户 ID 无效')
}

function assertSessionId(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) throw new Error('上传会话 ID 无效')
}

function ownerDir(ownerId) {
  assertOwnerId(ownerId)
  return path.join(SESSION_ROOT, ownerId)
}

function sessionPaths(ownerId, id) {
  assertSessionId(id)
  const dir = ownerDir(ownerId)
  return {
    dir,
    meta: path.join(dir, `${id}.json`),
    part: path.join(dir, `${id}.part`),
  }
}

function writeMeta(meta) {
  const paths = sessionPaths(meta.ownerId, meta.id)
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  const temp = `${paths.meta}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2), { mode: 0o600 })
  fs.renameSync(temp, paths.meta)
  try { fs.chmodSync(paths.meta, 0o600) } catch { /* Windows 忽略权限位 */ }
}

function cleanStagedChunks(ownerId, id) {
  const paths = sessionPaths(ownerId, id)
  let names = []
  try { names = fs.readdirSync(paths.dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(`${id}.`) || !name.endsWith('.chunk')) continue
    try { fs.unlinkSync(path.join(paths.dir, name)) } catch { /* already gone */ }
  }
}

function cleanSessionFiles(ownerId, id) {
  const paths = sessionPaths(ownerId, id)
  try { fs.unlinkSync(paths.meta) } catch { /* already gone */ }
  try { fs.unlinkSync(paths.part) } catch { /* already gone */ }
  cleanStagedChunks(ownerId, id)
}

function expired(meta, now = Date.now()) {
  return !meta || !Number.isFinite(Date.parse(meta.updatedAt)) || Date.parse(meta.updatedAt) + UPLOAD_SESSION_TTL_MS <= now
}

function readMeta(ownerId, id, { touch = false } = {}) {
  const paths = sessionPaths(ownerId, id)
  let meta
  try { meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8')) } catch { return null }
  if (!meta || meta.id !== id || meta.ownerId !== ownerId) return null
  if (expired(meta)) {
    cleanSessionFiles(ownerId, id)
    return null
  }

  const confirmed = Number(meta.offset) || 0
  // 写入中的 .part 会暂时大于元数据偏移量，这是正常中间状态。
  // 如果此时并发 GET、容量统计或创建其它会话，绝不能按旧偏移量截断它，
  // 否则正在写入的请求会丢失开头字节并报“上传分块写入长度不一致”。
  if (!activeSessions.has(id)) {
    let partSize = 0
    try { partSize = fs.statSync(paths.part).size } catch { /* first chunk not written */ }
    if (partSize < confirmed) meta.offset = partSize
    if (partSize > confirmed) {
      try { fs.truncateSync(paths.part, confirmed) } catch { meta.offset = partSize }
    }
  }
  if (touch) meta.updatedAt = new Date().toISOString()
  if (touch || meta.offset !== confirmed) writeMeta(meta)
  return meta
}

export function createUploadSession(data) {
  const now = new Date().toISOString()
  const meta = {
    id: crypto.randomUUID(),
    ownerId: data.ownerId,
    name: data.name,
    category: data.category,
    mime: data.mime,
    size: data.size,
    offset: 0,
    isPrivate: Boolean(data.isPrivate),
    createdAt: now,
    updatedAt: now,
  }
  writeMeta(meta)
  return meta
}

export function getUploadSession(ownerId, id, options = {}) {
  return readMeta(ownerId, id, options)
}

export function countUploadSessions(ownerId) {
  const dir = ownerDir(ownerId)
  let names = []
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')) } catch { return 0 }
  return names.reduce((count, name) => count + (readMeta(ownerId, name.slice(0, -5)) ? 1 : 0), 0)
}

export function reservedUploadBytes(ownerId) {
  const dir = ownerDir(ownerId)
  let names = []
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')) } catch { return 0 }
  return names.reduce((bytes, name) => {
    const meta = readMeta(ownerId, name.slice(0, -5))
    return bytes + (meta ? Math.max(0, meta.size - meta.offset) : 0)
  }, 0)
}

export function deleteUploadSession(ownerId, id) {
  cleanSessionFiles(ownerId, id)
}

export function uploadSessionExpiresAt(meta) {
  return new Date(Date.parse(meta.updatedAt) + UPLOAD_SESSION_TTL_MS).toISOString()
}

/**
 * 按已确认偏移量直接写入 .part。
 *
 * 每次只允许一个请求写同一会话，并使用显式文件位置而不是 append 模式。
 * 这样既避免分块写两遍磁盘，也不会受到并发追加位置漂移的影响；请求失败时
 * 关闭文件描述符后截断回旧偏移量。
 */
export async function appendUploadChunk(meta, req, { maxBytes, idleTimeoutMs }) {
  if (activeSessions.has(meta.id)) {
    throw Object.assign(new Error('该上传任务已有分块正在处理'), { status: 409, code: 'UPLOAD_IN_PROGRESS' })
  }
  activeSessions.add(meta.id)
  const paths = sessionPaths(meta.ownerId, meta.id)
  const previousOffset = meta.offset
  let received = 0
  let writePosition = previousOffset
  let fd = null
  let lastActivity = Date.now()

  const closeFd = () => {
    if (fd === null) return
    try { fs.closeSync(fd) } catch { /* already closed */ }
    fd = null
  }

  try {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    try {
      fd = fs.openSync(paths.part, 'r+', 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fd = fs.openSync(paths.part, 'w+', 0o600)
    }

    const partSize = fs.fstatSync(fd).size
    if (partSize < previousOffset) {
      throw Object.assign(new Error('上传分块写入长度不一致'), {
        status: 409,
        code: 'UPLOAD_INCOMPLETE',
        details: { previousOffset, received, partSize },
      })
    }
    if (partSize > previousOffset) fs.ftruncateSync(fd, previousOffset)

    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        lastActivity = Date.now()
        if (received > maxBytes) {
          return callback(Object.assign(new Error('上传分块过大'), { status: 413, code: 'CHUNK_TOO_LARGE' }))
        }
        callback(null, chunk)
      },
    })

    const writer = new Writable({
      write(chunk, _encoding, callback) {
        let bufferOffset = 0
        const writeNext = () => {
          fs.write(fd, chunk, bufferOffset, chunk.length - bufferOffset, writePosition, (error, written) => {
            if (error) return callback(error)
            if (!written) return callback(new Error('上传分块写入长度为 0'))
            bufferOffset += written
            writePosition += written
            if (bufferOffset < chunk.length) writeNext()
            else callback()
          })
        }
        writeNext()
      },
    })

    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) {
        req.destroy(Object.assign(new Error('上传分块超时'), { status: 408, code: 'UPLOAD_TIMEOUT' }))
      }
    }, 5000)
    if (typeof watchdog.unref === 'function') watchdog.unref()

    try {
      await pipeline(req, limiter, writer)
    } finally {
      clearInterval(watchdog)
    }

    closeFd()
    const size = fs.statSync(paths.part).size
    if (received !== maxBytes || size !== previousOffset + received) {
      throw Object.assign(new Error('上传分块写入长度不一致'), {
        status: 500,
        code: 'UPLOAD_LENGTH_MISMATCH',
        details: { previousOffset, received, expected: maxBytes, partSize: size },
      })
    }

    meta.offset = size
    meta.updatedAt = new Date().toISOString()
    writeMeta(meta)
    return { received, offset: meta.offset }
  } catch (error) {
    closeFd()
    try {
      if (fs.existsSync(paths.part)) fs.truncateSync(paths.part, previousOffset)
    } catch { /* best-effort rollback */ }
    throw error
  } finally {
    closeFd()
    activeSessions.delete(meta.id)
  }
}
export async function hashUploadSession(meta) {
  const paths = sessionPaths(meta.ownerId, meta.id)
  const hasher = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(paths.part)) hasher.update(chunk)
  return hasher.digest('hex')
}

export function uploadSessionPartPath(meta) {
  return sessionPaths(meta.ownerId, meta.id).part
}

export function verifyUploadSessionPart(meta) {
  const paths = sessionPaths(meta.ownerId, meta.id)
  try {
    return fs.statSync(paths.part).size === meta.offset && meta.offset === meta.size
  } catch {
    return false
  }
}

/** 清理超过 24 小时未活动以及没有元数据的孤儿分块。 */
export function cleanupExpiredUploadSessions() {
  let ownerDirs = []
  try { ownerDirs = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()) } catch { return 0 }
  let removed = 0
  for (const ownerEntry of ownerDirs) {
    const ownerId = ownerEntry.name
    const dir = path.join(SESSION_ROOT, ownerId)
    let files = []
    try { files = fs.readdirSync(dir) } catch { continue }
    const validIds = new Set(files.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)))
    for (const id of validIds) {
      if (!readMeta(ownerId, id)) removed += 1
    }
    for (const name of files) {
      const isPart = name.endsWith('.part')
      const isStagedChunk = name.endsWith('.chunk')
      if (!isPart && !isStagedChunk) continue
      if (isPart) {
        const id = name.slice(0, -5)
        if (validIds.has(id)) continue
      }
      try {
        const stat = fs.statSync(path.join(dir, name))
        if (Date.now() - stat.mtimeMs > UPLOAD_SESSION_TTL_MS) {
          fs.unlinkSync(path.join(dir, name))
          removed += 1
        }
      } catch { /* ignore */ }
    }
  }
  return removed
}