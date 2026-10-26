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
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'music'
  return 'file'
}
