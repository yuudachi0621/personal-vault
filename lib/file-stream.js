import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { UPLOAD_DIR } from './paths.js'
import { safeInlineMime } from './media.js'
import { sendError as fail } from './http-response.js'
import { MEDIA_RANGE_CHUNK_BYTES } from './config.js'
/**
 * 把磁盘上的文件发给浏览器。
 *
 * 直接向 res 写入状态码、响应头和文件流，因此调用方不能再次响应。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} record 文件记录，提供名称、MIME、大小和内容哈希等字段
 * @param {'inline'|'attachment'} disposition 期望的内容处置方式；不安全类型会强制为附件
 * @param {{filePath?: string, mime?: string, inlineMime?: string, cacheControl?: string, isPreview?: boolean}} options 文件响应覆盖项
 * @returns {void}
 */
export function sendStoredFile(req, res, record, disposition, options = {}) {
  const filePath = options.filePath || path.join(UPLOAD_DIR, record.ownerId, record.storedName)

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
  const effectiveMime = options.mime || record.mime
  const inlineType = disposition === 'inline'
    ? (options.inlineMime || safeInlineMime(record.name, effectiveMime))
    : null
  const effectiveDisposition = inlineType ? 'inline' : 'attachment'
  // 预览副本与原始文件内容不同，ETag 必须按实际响应文件计算
  const etag = `"${options.isPreview ? `${stat.size}-${Math.floor(stat.mtimeMs)}` : (record.contentHash || `${stat.size}-${Math.floor(stat.mtimeMs)}`)}"`
  const lastModified = stat.mtime.toUTCString()

  const headers = {
    // 非安全内联类型统一按二进制附件返回，防止 HTML / SVG 等主动内容执行脚本
    'Content-Type': inlineType || 'application/octet-stream',
    'Cache-Control': options.cacheControl || 'private, max-age=3600',
    'Accept-Ranges': 'bytes',                   // 告诉浏览器「我支持分段请求」
    'Content-Disposition': `${effectiveDisposition}; filename*=UTF-8''${encodedName}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Download-Options': 'noopen',
    // 让 Nginx 对视频 Range 响应实时透传，而不是先缓存整段再发给浏览器
    'X-Accel-Buffering': 'no',
    'X-Video-Preview': options.isPreview ? 'optimized' : 'original',
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
export function pipeStream(readStream, res, onComplete = () => {}) {
  void pipeline(readStream, res)
    .then(() => onComplete())
    .catch((error) => onComplete(error))
}

export function streamOut(readStream, res) {
  pipeStream(readStream, res, () => {
    /* 客户端中断属正常情况，无需处理 */
  })
}

