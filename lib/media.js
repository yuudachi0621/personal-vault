/**
 * ============================================================================
 *  lib/media.js —— MIME 补全与文件分类
 * ============================================================================
 *
 * 浏览器上报的 Content-Type 并不总是可靠：某些系统会把 MP3、WAV、图片都报成
 * application/octet-stream。这里统一用扩展名补全 MIME，再据此判断文件分类。
 *
 * 这个模块被上传接口和数据库迁移共同使用，避免两处各维护一套扩展名列表。
 */

import path from 'node:path'

/** 常见扩展名对应的标准 MIME 类型。 */
export const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',

  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',

  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  ape: 'audio/x-ape',
  amr: 'audio/amr',
  mid: 'audio/midi',
  midi: 'audio/midi',

  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
}

/**
 * 对已知扩展名以扩展名为准，避免浏览器上报的通用或错误类型破坏预览。
 * 扩展名不在表里时，才回退到请求头里的 Content-Type。
 */
export function inferMime(name, mime) {
  const reported = String(mime || '').split(';')[0].trim().toLowerCase()
  const ext = path.extname(String(name || '')).toLowerCase().replace(/^\./, '')
  return MIME_BY_EXT[ext] || reported || 'application/octet-stream'
}

/**
 * 文件分类只由真实 MIME / 扩展名决定，不受用户当前浏览的筛选分类影响。
 * 返回值固定为 image / video / music / file 之一。
 */
export function detectCategory(mime, name) {
  const type = inferMime(name, mime)
  // SVG 可以携带脚本，直接按普通文件处理，避免进入图片预览链路。
  if (type === 'image/svg+xml') return 'file'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'music'
  return 'file'
}

const SAFE_INLINE_IMAGES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'image/avif', 'image/heic', 'image/tiff',
])

/**
 * 只允许浏览器能安全直接渲染的媒体类型以内联方式返回。
 * HTML、SVG、XML、PDF 等主动内容一律按附件下载，避免同源存储型 XSS。
 */
export function safeInlineMime(name, mime) {
  const type = inferMime(name, mime)
  if (SAFE_INLINE_IMAGES.has(type)) return type
  if (type.startsWith('video/') || type.startsWith('audio/')) return type
  return null
}
