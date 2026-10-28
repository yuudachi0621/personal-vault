/**
 * ============================================================================
 *  lib/static.js —— 前端文件怎么发给浏览器
 * ============================================================================
 *
 * 【浏览器拿到一个网页，其实要发好几次请求】
 *   访问 http://localhost:8787 时：
 *     第 1 次  GET /           → 拿到 index.html
 *     之后浏览器按 HTML 中的引用继续请求 styles.css、config.js、app.js、
 *     favicon.svg 等静态资源。
 *   index.html 里写了 <link href="/styles.css">，浏览器读到就会自动再发一次请求。
 *   本文件的工作就是「有人要文件，找到并给他」。
 *
 * 【什么是 MIME 类型】
 *   浏览器靠响应头 Content-Type 判断收到的是什么。
 *   类型写错的话，CSS 会被当成纯文本，页面就花了。
 *   下面的 MIME 表就是「扩展名 → 类型」的对照。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_DIR } from './paths.js'

const etagCache = new Map()

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

/** 用文件内容生成强 ETag；部署更换文件后浏览器一定能识别到新版本。 */
function contentEtag(filePath, stat) {
  const cacheKey = `${stat.size}:${stat.mtimeMs}`
  const cached = etagCache.get(filePath)
  if (cached && cached.cacheKey === cacheKey) return cached.etag

  const digest = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('base64url')
  const result = { cacheKey, etag: `"${digest}"` }
  etagCache.set(filePath, result)
  return result.etag
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 * 返回 public/ 目录下的文件。
 * 应用没有前端路由，因此未知路径直接 404，不会把扫描流量伪装成首页 200。
 *
 * @param {object} req 请求
 * @param {object} res 响应
 * @param {URL}    url 已解析的地址
 */
export function serveStatic(req, res, url) {
  // 静态文件只接受「读取」类请求。
  // GET  = 读内容；HEAD = 只要响应头不要内容（浏览器/监控用来探测文件是否存在）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })   // 405 = 这个方法不允许
    return res.end()
  }

  // URL 里的中文和空格会被编码成 %E4%B8%AD 这种形式，这里解码回正常字符。
  // 编码可能不合法（有人手工构造坏 URL），所以用 try 包住。
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400)
    return res.end()
  }

  if (pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('404 Not Found')
  }

  // 本应用没有前端路由，只允许根路径和明确的 index.html
  if (pathname === '/' || pathname === '') pathname = '/index.html'

  /**
   * ── 防目录穿越（重要的安全措施）────────────────────────────────────
   *
   * 如果不做检查，构造出的路径可能越过 public/ 去读取后端源码、
   * data/vault.db 或签名密钥等不应通过 HTTP 暴露的文件。
   *
   * 防御思路：把「用户给的路径」和「public 目录」拼起来，解析成绝对路径，
   * 然后确认结果确实还在 public 目录里面。
   * 不在 → 当作没找到，绝不返回文件。
   *
   * 前面加 `.` 是为了强制它变成相对路径（例如 /abc → ./abc），
   * 否则 path.resolve 遇到开头的 / 会直接当成磁盘根目录。
   */
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`)
  const isInside = resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep)

  let filePath = isInside ? resolved : null

  // 如果指向的是一个目录，就取该目录下的 index.html
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html')
  }

  // 文件不存在或路径越界时直接 404。应用没有前端路由，不再把所有未知路径都回落到首页。
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end('404 Not Found')
  }

  const ext = path.extname(filePath).toLowerCase()   // 扩展名，如 '.css'
  const stat = fs.statSync(filePath)                 // 文件信息（大小、修改时间）

  /**
   * ── 缓存控制 ──────────────────────────────────────────────────────
   *
   * 用文件内容的 SHA-1 生成强 ETag。
   * 浏览器再次请求时会带上 If-None-Match，内容没变就只回 304；
   * 文件更新后 ETag 必然变化，用户不需要手动清浏览器缓存。
   */
  const etag = contentEtag(filePath, stat)
  const cacheControl = 'no-cache, must-revalidate'
  const tags = String(req.headers['if-none-match'] || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  if (tags.includes(etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl })
    return res.end()
  }

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',  // 认不出就按二进制流处理
    'Content-Length': stat.size,
    ETag: etag,
    // no-cache 不是“不缓存”，而是每次使用前都必须向服务器确认；
    // 文件没变时 ETag 会返回 304，文件变了则立刻拿新内容，无需用户清缓存。
    'Cache-Control': cacheControl,
  }
  if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP
  res.writeHead(200, headers)

  // HEAD 请求只要头，不要内容
  if (req.method === 'HEAD') return res.end()

  /**
   * ── 流式发送 ──────────────────────────────────────────────────────
   *
   * createReadStream 是「流」：不是一次性把整个文件读进内存，
   * 而是一小块一小块地读、边读边发。
   * 左边 .pipe(res) 表示「把读到的数据直接灌进响应里」。
   *
   * 好处：无论静态文件多大，进程都只保留有限的流缓冲。
   * 如果先 readFileSync 再 res.end，大文件会被整体读入内存。
   */
  fs.createReadStream(filePath).pipe(res)
}
