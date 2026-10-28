#!/usr/bin/env node
/**
 * 为已有视频生成低码率播放预览副本。
 * 原文件不会被修改，下载和 MD5 仍保持不变。
 *
 * 用法：
 *   node scripts/optimize-video-previews.mjs --all
 *   node scripts/optimize-video-previews.mjs <文件ID或完整文件名>
 *   node scripts/optimize-video-previews.mjs --all --force
 */

import fs from 'node:fs'
import { db, mapFile, closeDb } from '../lib/db.js'
import { generateVideoPreview, isFfmpegAvailable } from '../lib/video-preview.js'

const args = process.argv.slice(2)
const force = args.includes('--force')
const all = args.includes('--all')
const target = args.filter((arg) => arg !== '--force' && arg !== '--all').join(' ').trim()

if (!all && !target) {
  console.error('用法：node scripts/optimize-video-previews.mjs <文件ID或完整文件名>')
  console.error('   或：node scripts/optimize-video-previews.mjs --all')
  process.exit(1)
}
if (!isFfmpegAvailable()) {
  console.error('未找到 ffmpeg。请先安装，例如 Ubuntu：sudo apt install -y ffmpeg')
  console.error('如 ffmpeg 不在 PATH 中，可设置 FFMPEG_PATH=/absolute/path/to/ffmpeg')
  closeDb()
  process.exit(1)
}

let records
if (all) {
  records = db.prepare("SELECT * FROM files WHERE category = 'video' AND deleted_at IS NULL ORDER BY created_at ASC").all().map(mapFile)
} else {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(target)
    || db.prepare("SELECT * FROM files WHERE name = ? AND category = 'video' ORDER BY created_at DESC LIMIT 1").get(target)
  if (row && row.deleted_at) {
    console.error('该视频在回收站中，恢复后再生成预览')
    closeDb()
    process.exit(1)
  }
  records = row ? [mapFile(row)] : []
}

if (!records.length) {
  console.error('没有找到匹配的视频记录')
  closeDb()
  process.exit(1)
}

let generated = 0
let reused = 0
let skipped = 0
let failed = 0

for (const record of records) {
  try {
    const result = await generateVideoPreview(record, {
      force,
      // 长剧集可能转码数小时；命令行任务默认不设置超时。
      timeoutMs: 0,
      // 命令行手动执行时使用 ffmpeg 自动线程数；后台自动任务仍默认限制 2 线程。
      threads: 0,
      onProgress: ({ bytes, elapsedMs }) => {
        const minutes = Math.floor(elapsedMs / 60_000)
        const seconds = Math.floor((elapsedMs % 60_000) / 1000)
        console.log(`处理中：${record.name} · 已写入 ${(bytes / 1024 / 1024).toFixed(1)} MB · 已用时 ${minutes}分${seconds}秒`)
      },
    })
    if (result.generated) {
      const size = fs.statSync(result.path).size
      generated += 1
      console.log(`已生成：${record.name} → ${(size / 1024 / 1024).toFixed(1)} MB`)
    } else {
      reused += 1
      console.log(`已存在：${record.name}`)
    }
  } catch (error) {
    if (error && error.code === 'PREVIEW_NOT_SMALLER') {
      skipped += 1
      const reason = error.cachedSkip ? '已有跳过标记，无需重复编码' : '原片已经足够小，无需额外副本'
      console.log(`跳过：${record.name} · ${reason}`)
    } else {
      failed += 1
      console.error(`失败：${record.name}：${error.message}`)
    }
  }
}

console.log(`完成：新生成 ${generated}，复用 ${reused}，跳过 ${skipped}，失败 ${failed}`)
console.log('原始文件未修改，下载与 MD5/SHA-256 保持一致。')
closeDb()
if (failed) process.exitCode = 1
