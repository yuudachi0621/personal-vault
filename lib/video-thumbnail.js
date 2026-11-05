/**
 * 视频封面缩略图。
 *
 * 卡片封面不再直接让浏览器从原视频取帧，而是优先读取服务端缓存的小尺寸
 * JPEG。这样即使原片有数百 MB，刷新列表也只需要下载几十 KB 的图片。
 * FFmpeg 不可用或生成失败时，前端会回退到原有 <video> 取帧。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { UPLOAD_DIR, PREVIEW_DIR } from './paths.js'
import { isFfmpegAvailable, videoPreviewPath, videoPreviewExists } from './video-preview.js'

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const THUMBNAIL_TIMEOUT_MS = 15_000
let queue = Promise.resolve()

/** 与视频预览副本放在同一用户目录下，便于随原文件一起清理。 */
export function videoThumbnailPath(record) {
  return path.join(PREVIEW_DIR, record.ownerId, `${record.id}.thumb.jpg`)
}

export function removeVideoThumbnail(record) {
  try { fs.unlinkSync(videoThumbnailPath(record)) } catch { /* 不存在即可 */ }
}

function thumbnailInputPath(record) {
  if (videoPreviewExists(record)) return videoPreviewPath(record)
  return path.join(UPLOAD_DIR, record.ownerId, record.storedName)
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    let timer = 0

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new Error('视频封面生成超时'))
      }, timeoutMs)
    }

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-3000)
    })
    child.on('error', finish)
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(`ffmpeg 退出码 ${code}: ${stderr.trim()}`))
    })
  })
}

/**
 * 生成或复用视频封面。
 *
 * @param {object} record 视频文件记录
 * @param {{force?: boolean, timeoutMs?: number}} options
 * @returns {Promise<{path: string, generated: boolean}>}
 * @throws {Error} FFmpeg 不可用、源文件缺失或生成失败
 */
export async function generateVideoThumbnail(record, {
  force = false,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
} = {}) {
  if (!record || record.category !== 'video') throw new Error('只有视频文件可以生成封面')
  if (!isFfmpegAvailable()) throw Object.assign(new Error('服务器未安装 ffmpeg'), { code: 'FFMPEG_NOT_AVAILABLE' })

  const inputPath = thumbnailInputPath(record)
  const inputStat = fs.statSync(inputPath)
  const outputPath = videoThumbnailPath(record)

  if (!force) {
    try {
      const existing = fs.statSync(outputPath)
      if (existing.size > 0 && existing.mtimeMs >= inputStat.mtimeMs) {
        return { path: outputPath, generated: false }
      }
    } catch { /* 缓存不存在 */ }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  const tempPath = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp.jpg`
  try { fs.unlinkSync(tempPath) } catch { /* 不存在即可 */ }

  const filter = "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"
  const baseArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-frames:v', '1',
    '-an',
    '-vf', filter,
    '-c:v', 'mjpeg',
    '-q:v', '4',
    '-f', 'image2',
    tempPath,
  ]

  try {
    try {
      // 先尝试 0.5 秒处，通常比黑屏首帧更适合作为封面。
      await runFfmpeg([...baseArgs.slice(0, 6), '-ss', '0.5', ...baseArgs.slice(6)], timeoutMs)
    } catch {
      // 极短视频可能没有 0.5 秒处画面，回退到首帧再试一次。
      await runFfmpeg(baseArgs, timeoutMs)
    }

    const stat = fs.statSync(tempPath)
    if (!stat.size) throw new Error('生成的视频封面为空')
    fs.renameSync(tempPath, outputPath)
    try { fs.chmodSync(outputPath, 0o600) } catch { /* Windows 忽略权限位 */ }
    return { path: outputPath, generated: true }
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    throw error
  }
}

/**
 * 串行生成封面，避免列表首次加载时同时启动多个 FFmpeg。
 * 失败返回 null，让调用方回退到视频取帧。
 */
export function queueVideoThumbnail(record, options = {}) {
  if (!isFfmpegAvailable()) return Promise.resolve(null)
  queue = queue
    .then(() => generateVideoThumbnail(record, options))
    .then((result) => result.path)
    .catch((error) => {
      console.warn(`[video-thumbnail] 生成失败：${record.name}`, error && error.message)
      return null
    })
  return queue
}