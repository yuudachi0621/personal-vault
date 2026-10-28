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
const configuredPreviewCrf = Number(process.env.VIDEO_PREVIEW_CRF)
const PREVIEW_CRF = Number.isInteger(configuredPreviewCrf) && configuredPreviewCrf >= 0 && configuredPreviewCrf <= 51
  ? configuredPreviewCrf
  : 26
const configuredPreviewMaxrate = Number(process.env.VIDEO_PREVIEW_MAXRATE_KBPS)
const PREVIEW_MAXRATE_KBPS = Number.isFinite(configuredPreviewMaxrate) && configuredPreviewMaxrate >= 300
  ? Math.floor(configuredPreviewMaxrate)
  : 2200
const configuredPreviewAudio = Number(process.env.VIDEO_PREVIEW_AUDIO_KBPS)
const PREVIEW_AUDIO_KBPS = Number.isFinite(configuredPreviewAudio) && configuredPreviewAudio >= 32
  ? Math.floor(configuredPreviewAudio)
  : 96
// 转码策略变化时递增，避免旧版本的“跳过”结论继续生效。
const PREVIEW_POLICY_VERSION = 1
let ffmpegAvailability = null
let queue = Promise.resolve()

export function videoPreviewPath(record) {
  return path.join(PREVIEW_DIR, record.ownerId, `${record.id}.mp4`)
}

/** 记录“重编码也不会更小”的结论，避免每次手动批处理都重复消耗 CPU。 */
function videoPreviewSkipPath(record) {
  return `${videoPreviewPath(record)}.skip.json`
}

function clearVideoPreviewSkipMarker(record) {
  try { fs.unlinkSync(videoPreviewSkipPath(record)) } catch { /* 不存在即可 */ }
}

function videoPreviewSkipMatches(record, sourceStat) {
  try {
    const marker = JSON.parse(fs.readFileSync(videoPreviewSkipPath(record), 'utf8'))
    return marker
      && marker.policyVersion === PREVIEW_POLICY_VERSION
      && Number(marker.sourceSize) === sourceStat.size
      && Math.abs(Number(marker.sourceMtimeMs) - sourceStat.mtimeMs) < 1
      && Number(marker.crf) === PREVIEW_CRF
      && Number(marker.maxrateKbps) === PREVIEW_MAXRATE_KBPS
      && Number(marker.audioKbps) === PREVIEW_AUDIO_KBPS
  } catch {
    return false
  }
}

function writeVideoPreviewSkipMarker(record, sourceStat) {
  const markerPath = videoPreviewSkipPath(record)
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(markerPath, JSON.stringify({
      policyVersion: PREVIEW_POLICY_VERSION,
      reason: 'not_smaller_than_source',
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      crf: PREVIEW_CRF,
      maxrateKbps: PREVIEW_MAXRATE_KBPS,
      audioKbps: PREVIEW_AUDIO_KBPS,
      createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 })
  } catch { /* 写标记失败只会导致下次重试，不影响当前结果 */ }
}

/**
 * 判断预览副本能否使用。
 *
 * 旧版本使用固定 1.8Mbps 转码，低码率长视频可能被放大数倍。这里以数据库里
 * 的原片大小为硬上限：达到或超过原片大小的副本直接删除并回退原画。
 * 副作用：可能删除空文件、超大旧副本，并清理与之冲突的跳过标记。
 *
 * @param {object} record 文件记录，至少需要 id、ownerId、name、size
 * @returns {boolean} 是否存在可安全使用的预览副本
 */
export function videoPreviewExists(record) {
  const previewPath = videoPreviewPath(record)
  try {
    const preview = fs.statSync(previewPath)
    const sourceSize = Number(record.size) || 0
    if (!preview.isFile() || preview.size <= 0) {
      try { fs.unlinkSync(previewPath) } catch { /* 不存在或无法删除时仍按不可用处理 */ }
      return false
    }
    if (sourceSize > 0 && preview.size >= sourceSize) {
      try {
        fs.unlinkSync(previewPath)
        console.warn(`[video-preview] 已清理过大的旧预览副本：${record.name}`)
      } catch { /* 无法删除时也不能继续使用 */ }
      return false
    }
    clearVideoPreviewSkipMarker(record)
    return true
  } catch {
    return false
  }
}

/** 彻底删除原文件时同步清理播放副本，避免孤儿文件占磁盘。 */
export function removeVideoPreview(record) {
  try { fs.unlinkSync(videoPreviewPath(record)) } catch { /* 不存在即可 */ }
  clearVideoPreviewSkipMarker(record)
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
 * 生成低码率、fast-start 的 MP4 播放副本。
 *
 * 使用 CRF 按画面复杂度分配码率，并用 maxrate 限制峰值；临时文件一旦达到
 * 原片大小就终止。最终仍大于等于原片的输出会被删除，并写入 .skip.json，
 * 避免后续批处理重复编码。原文件只读，绝不覆盖。
 *
 * 副作用：启动 ffmpeg 子进程，在 data/previews/ 下写临时文件、正式副本或
 * 跳过标记，并周期性调用 onProgress。
 *
 * @param {object} record 视频文件记录，至少需要 id、ownerId、name、size、storedName
 * @param {{force?: boolean, timeoutMs?: number, threads?: number,
 *          onProgress?: ((info: {bytes: number, elapsedMs: number}) => void)|null}} options
 * @returns {Promise<{path: string, generated: boolean}>} generated=false 表示复用了已有副本
 * @throws {Error & {code?: string}} ffmpeg 不可用、转码失败、超时，或结果无法小于原片
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

  if (!force && videoPreviewSkipMatches(record, sourceStat)) {
    throw Object.assign(
      new Error('此前已确认预览副本不会更小，已跳过重复编码'),
      { code: 'PREVIEW_NOT_SMALLER', cachedSkip: true },
    )
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
    // 固定平均码率会把低码率原片转得更大；CRF 让简单画面少占空间，
    // maxrate 继续约束公网播放时的带宽峰值。
    '-crf', String(PREVIEW_CRF),
    '-maxrate', `${PREVIEW_MAXRATE_KBPS}k`,
    '-bufsize', `${PREVIEW_MAXRATE_KBPS * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${PREVIEW_AUDIO_KBPS}k`,
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
        if (settled) return
        try {
          const bytes = fs.statSync(tempPath).size
          // MP4 临时文件只会继续变大；一旦达到原片大小，完整结果不可能更小。
          // 提早在编码阶段终止，避免先写出一个比原片还大的文件再删除。
          if (bytes >= sourceStat.size) {
            child.kill('SIGKILL')
            finish(Object.assign(
              new Error('预览副本已达到原片大小，已停止生成'),
              { code: 'PREVIEW_NOT_SMALLER' },
            ))
            return
          }
          if (typeof onProgress === 'function') {
            onProgress({ bytes, elapsedMs: Date.now() - startedAt })
          }
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

    const previewSize = fs.statSync(tempPath).size
    if (!previewSize) throw new Error('生成的预览文件为空')
    if (previewSize >= sourceStat.size) {
      throw Object.assign(
        new Error('预览副本不小于原片，已丢弃'),
        { code: 'PREVIEW_NOT_SMALLER' },
      )
    }
    fs.renameSync(tempPath, outputPath)
    try { fs.chmodSync(outputPath, 0o600) } catch { /* Windows / 特殊文件系统忽略 */ }
    clearVideoPreviewSkipMarker(record)
    return { path: outputPath, generated: true }
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    if (error && error.code === 'PREVIEW_NOT_SMALLER') {
      // 关键：没有生成副本也要留下结论，否则每次 npm run preview:videos 都会重来一遍。
      writeVideoPreviewSkipMarker(record, sourceStat)
    }
    // 强制重转失败时保留旧的“好副本”；如果旧副本本身就比原片大，则顺手清理。
    if (fs.existsSync(outputPath)) videoPreviewExists(record)
    throw error
  }
}

/**
 * 新视频上传后串行排队生成，避免多个 ffmpeg 同时占满 CPU。
 * 失败会记录日志并解析为 null，调用方不需要额外 catch。
 *
 * @param {object} record 视频文件记录
 * @param {object} options 透传给 generateVideoPreview 的选项
 * @returns {Promise<object|null>} 成功结果；禁用、失败或无需生成时为 null
 */
export function queueVideoPreview(record, options = {}) {
  if (!AUTO_VIDEO_PREVIEW || !isFfmpegAvailable()) return Promise.resolve(null)
  queue = queue
    .then(() => generateVideoPreview(record, options))
    .then((result) => {
      console.log(`[video-preview] 已生成播放预览：${record.name}`)
      return result
    })
    .catch((error) => {
      if (error && error.code === 'PREVIEW_NOT_SMALLER') {
        console.log(`[video-preview] 已跳过，原片已足够小：${record.name}`)
      } else {
        console.error(`[video-preview] 生成失败：${record.name}`, error && error.message)
      }
      return null
    })
  return queue
}
