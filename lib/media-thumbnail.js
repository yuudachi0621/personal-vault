/**
 * 媒体封面缩略图。
 *
 * 照片和视频卡片都不再直接加载原文件，而是优先读取服务端缓存的小尺寸
 * JPEG。这样大照片或长视频不会因为列表刷新而反复传输完整内容。
 * FFmpeg 不可用或生成失败时，前端会回退到原图 / 视频取帧。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { UPLOAD_DIR, PREVIEW_DIR } from './paths.js'
import { isFfmpegAvailable, videoPreviewPath, videoPreviewExists } from './video-preview.js'
import { createTaskQueue } from './task-queue.js'
import { removeFileIfExists } from './fs-utils.js'

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const THUMBNAIL_TIMEOUT_MS = 15_000
const thumbnailQueue = createTaskQueue({ concurrency: 1 })

/** 与视频预览副本放在同一用户目录下，便于随原文件一起清理。 */
export function mediaThumbnailPath(record) {
  return path.join(PREVIEW_DIR, record.ownerId, `${record.id}.thumb.jpg`)
}

export function removeMediaThumbnail(record) {
  return removeFileIfExists(mediaThumbnailPath(record))
}

function thumbnailInputPath(record) {
  if (record.category === 'video' && videoPreviewExists(record)) return videoPreviewPath(record)
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
        finish(new Error('媒体封面生成超时'))
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

function thumbnailFilter(record) {
  // 视频卡片是 4:3 区域；照片保留更大的纵向空间，仍由 CSS object-fit: cover 裁切。
  const maxHeight = record.category === 'video' ? 360 : 640
  return `scale=w='min(640,iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`
}

/**
 * 生成或复用照片 / 视频封面。
 *
 * @param {object} record 文件记录，category 必须为 image 或 video
 * @param {{force?: boolean, timeoutMs?: number}} options
 * @returns {Promise<{path: string, generated: boolean}>}
 * @throws {Error} FFmpeg 不可用、源文件缺失或生成失败
 */
export async function generateMediaThumbnail(record, {
  force = false,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
} = {}) {
  if (!record || !['image', 'video'].includes(record.category)) throw new Error('只有照片或视频可以生成封面')
  if (!(await isFfmpegAvailable())) throw Object.assign(new Error('服务器未安装 ffmpeg'), { code: 'FFMPEG_NOT_AVAILABLE' })

  const inputPath = thumbnailInputPath(record)
  const inputStat = fs.statSync(inputPath)
  const outputPath = mediaThumbnailPath(record)

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

  const baseArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-frames:v', '1',
    '-an',
    '-vf', thumbnailFilter(record),
    '-c:v', 'mjpeg',
    '-q:v', '4',
    '-f', 'image2',
    tempPath,
  ]

  try {
    if (record.category === 'video') {
      try {
        // 视频优先取 0.5 秒处，通常比黑屏首帧更适合作为封面。
        await runFfmpeg([...baseArgs.slice(0, 6), '-ss', '0.5', ...baseArgs.slice(6)], timeoutMs)
      } catch {
        // 极短视频可能没有 0.5 秒处画面，回退到首帧再试一次。
        await runFfmpeg(baseArgs, timeoutMs)
      }
    } else {
      await runFfmpeg(baseArgs, timeoutMs)
    }

    const stat = fs.statSync(tempPath)
    if (!stat.size) throw new Error('生成的媒体封面为空')
    fs.renameSync(tempPath, outputPath)
    try { fs.chmodSync(outputPath, 0o600) } catch { /* Windows 忽略权限位 */ }
    return { path: outputPath, generated: true }
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    throw error
  }
}

/**
 * 串行生成照片 / 视频封面，避免列表首次加载时同时启动多个 FFmpeg。
 * 失败返回 null，让调用方回退到原图或视频取帧。
 */
export function queueMediaThumbnail(record, options = {}) {
  return thumbnailQueue.enqueue(record.id, async () => {
    if (!(await isFfmpegAvailable())) return null
    try {
      const result = await generateMediaThumbnail(record, options)
      return result.path
    } catch (error) {
      console.warn(`[media-thumbnail] 生成失败：${record.name}`, error && error.message)
      return null
    }
  })
}
