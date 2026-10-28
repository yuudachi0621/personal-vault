/**
 * 视频在线播放预览副本。
 *
 * 原文件绝不修改：下载、MD5/SHA-256 仍以原始上传文件为准。
 * 如果服务器安装了 ffmpeg，可另外生成低码率、fast-start 的 MP4，
 * 只用于浏览器在线播放，解决公网上行带宽低于原视频码率时不断缓冲的问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { UPLOAD_DIR, PREVIEW_DIR } from './paths.js'

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'
const AUTO_VIDEO_PREVIEW = process.env.AUTO_VIDEO_PREVIEW !== '0'
const configuredPreviewTimeout = Number(process.env.VIDEO_PREVIEW_TIMEOUT_MS)
// 默认 2 小时；设为 0 表示不限制。命令行脚本会直接使用 0。
const PREVIEW_TIMEOUT_MS = Number.isFinite(configuredPreviewTimeout) && configuredPreviewTimeout >= 0
  ? configuredPreviewTimeout
  : 2 * 60 * 60_000
const configuredPreviewThreads = Number(process.env.VIDEO_PREVIEW_THREADS)
const PREVIEW_THREADS = Number.isInteger(configuredPreviewThreads) && configuredPreviewThreads >= 0
  ? configuredPreviewThreads
  : 2
let ffmpegAvailability = null
let queue = Promise.resolve()

export function videoPreviewPath(record) {
  return path.join(PREVIEW_DIR, record.ownerId, `${record.id}.mp4`)
}

export function videoPreviewExists(record) {
  try {
    return fs.statSync(videoPreviewPath(record)).size > 0
  } catch {
    return false
  }
}

/** 彻底删除原文件时同步清理播放副本，避免孤儿文件占磁盘。 */
export function removeVideoPreview(record) {
  try { fs.unlinkSync(videoPreviewPath(record)) } catch { /* 不存在即可 */ }
}

/** 检查 ffmpeg 是否可用，结果只检查一次。 */
export function isFfmpegAvailable() {
  if (ffmpegAvailability !== null) return ffmpegAvailability
  const result = spawnSync(FFMPEG_PATH, ['-version'], {
    stdio: 'ignore',
    timeout: 5000,
  })
  ffmpegAvailability = !result.error && result.status === 0
  if (!ffmpegAvailability) {
    console.warn('[video-preview] 未找到 ffmpeg，视频将回退使用原始文件在线播放')
  }
  return ffmpegAvailability
}

/**
 * 生成低码率预览副本。
 * 默认 720p、视频约 1.8Mbps、音频 96kbps，适合 3–5Mbps 的公网上行带宽。
 */
export async function generateVideoPreview(record, { force = false, timeoutMs = PREVIEW_TIMEOUT_MS, threads = PREVIEW_THREADS, onProgress = null } = {}) {
  if (!record || record.category !== 'video') {
    throw new Error('只有视频文件可以生成播放预览')
  }
  if (!isFfmpegAvailable()) {
    throw Object.assign(new Error('服务器未安装 ffmpeg'), { code: 'FFMPEG_NOT_AVAILABLE' })
  }

  const sourcePath = path.join(UPLOAD_DIR, record.ownerId, record.storedName)
  const outputPath = videoPreviewPath(record)
  const sourceStat = fs.statSync(sourcePath)

  if (!force && videoPreviewExists(record)) {
    const previewStat = fs.statSync(outputPath)
    if (previewStat.mtimeMs >= sourceStat.mtimeMs) {
      return { path: outputPath, generated: false }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  // 清理旧版本超时或进程中断后遗留的临时文件，避免它们继续占用磁盘
  try {
    const dir = path.dirname(outputPath)
    const prefix = `${record.id}.`
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp.mp4')) {
        try { fs.unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
      }
    }
  } catch { /* 目录刚创建或不可读 */ }
  const tempPath = `${outputPath}.${process.pid}.tmp.mp4`
  try { fs.unlinkSync(tempPath) } catch { /* 不存在即可 */ }

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '1800k',
    '-maxrate', '2200k',
    '-bufsize', '4400k',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-threads', String(threads),
    '-movflags', '+faststart',
    '-f', 'mp4',
    tempPath,
  ]

  try {
    const startedAt = Date.now()
    await new Promise((resolve, reject) => {
      const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      let settled = false
      let timer = 0
      const progressTimer = setInterval(() => {
        if (settled || typeof onProgress !== 'function') return
        try {
          const bytes = fs.statSync(tempPath).size
          onProgress({ bytes, elapsedMs: Date.now() - startedAt })
        } catch { /* 临时文件尚未出现 */ }
      }, 30_000)
      if (typeof progressTimer.unref === 'function') progressTimer.unref()

      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(progressTimer)
        if (error) reject(error)
        else resolve()
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish(new Error('视频预览生成超时'))
        }, timeoutMs)
      }

      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000)
      })
      child.on('error', (error) => finish(error))
      child.on('close', (code) => {
        if (code === 0) finish()
        else finish(new Error(`ffmpeg 退出码 ${code}: ${stderr.trim()}`))
      })
    })

    if (!fs.statSync(tempPath).size) throw new Error('生成的预览文件为空')
    fs.renameSync(tempPath, outputPath)
    try { fs.chmodSync(outputPath, 0o600) } catch { /* Windows / 特殊文件系统忽略 */ }
    return { path: outputPath, generated: true }
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    throw error
  }
}

/** 新视频上传后串行排队生成，避免多个 ffmpeg 同时占满 CPU。 */
export function queueVideoPreview(record, options = {}) {
  if (!AUTO_VIDEO_PREVIEW || !isFfmpegAvailable()) return Promise.resolve(null)
  queue = queue
    .then(() => generateVideoPreview(record, options))
    .then((result) => {
      console.log(`[video-preview] 已生成播放预览：${record.name}`)
      return result
    })
    .catch((error) => {
      console.error(`[video-preview] 生成失败：${record.name}`, error && error.message)
      return null
    })
  return queue
}
