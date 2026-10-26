/**
 * ============================================================================
 *  lib/static.js —— 前端文件怎么发给浏览器
 * ============================================================================
 *
 * 【浏览器拿到一个网页，其实要发好几次请求】
 *   访问 http://localhost:8787 时：
 *     第 1 次  GET /          → 拿到 index.html
 *     第 2 次  GET /styles.css → 拿到样式
 *     第 3 次  GET /app.js     → 拿到脚本
 *     第 4 次  GET /config.js  → 拿到配置
 *     ...
 *   index.html 里写了 <link href="/styles.css">，浏览器读到就会自动再发一次请求。
 *   本文件的工作就是「有人要文件，找到并给他」。
 *
 * 【什么是 MIME 类型】
 *   浏览器靠响应头 Content-Type 判断收到的是什么。
 *   类型写错的话，CSS 会被当成纯文本，页面就花了。
 *   下面的 MIME 表就是「扩展名 → 类型」的对照。
 */

import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_DIR } from './paths.js'

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
 * 如果请求的路径找不到文件，就回落到 index.html —— 这是单页应用（SPA）的常规做法。
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

  // 访问根路径就当作要首页
  if (pathname === '/' || pathname === '') pathname = '/index.html'

  /**
   * ── 防目录穿越（重要的安全措施）────────────────────────────────────
   *
   * 如果不做检查，攻击者请求 /../../lib/auth.js 就能下载到后端源码，
   * 甚至 /../../data/users.json 拿到所有用户数据。
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

  // 文件不存在（或者上面判定越界了）→ 回落到首页，交给前端路由处理
  if (!filePath || !fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html')
    if (!fs.existsSync(filePath)) {
      // 连首页都没有，说明项目文件缺失
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('404 Not Found')
    }
  }

  const ext = path.extname(filePath).toLowerCase()   // 扩展名，如 '.css'
  const stat = fs.statSync(filePath)                 // 文件信息（大小、修改时间）

  /**
   * ── 缓存控制 ──────────────────────────────────────────────────────
   *
   * 用「文件大小 + 修改时间」拼一个指纹（ETag）。
   * 浏览器再次请求时会带上 If-None-Match，内容没变就只需回一个 304，
   * 不用重传整个文件，省流量也更快。
   */
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304)   // 304 = 内容没变，你用缓存里的那份
    return res.end()
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',  // 认不出就按二进制流处理
    'Content-Length': stat.size,
    ETag: etag,
    // 页面本体不缓存（否则改完刷新看不到新版），其它资源缓存 1 小时
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })

  // HEAD 请求只要头，不要内容
  if (req.method === 'HEAD') return res.end()

  /**
   * ── 流式发送 ──────────────────────────────────────────────────────
   *
   * createReadStream 是「流」：不是一次性把整个文件读进内存，
   * 而是一小块一小块地读、边读边发。
   * 左边 .pipe(res) 表示「把读到的数据直接灌进响应里」。
   *
   * 好处：传一个 2GB 的视频，内存占用依然很小。
   * 如果写成 fs.readFileSync 再 res.end(内容)，2GB 文件会直接把进程撑爆。
   */
  fs.createReadStream(filePath).pipe(res)
}
