/**
 * ============================================================================
 *  server.js —— 程序入口，整个网站从这里开始运行
 * ============================================================================
 *
 * 【怎么跑起来】
 *   终端执行 `node server.js`，Node 会把本文件从头到尾读一遍并执行。
 *   执行到最后一行 server.listen(...) 时，程序会「停在那里」不退出，
 *   一直等着别人来访问 —— 这就是所谓的「服务器」。
 *   普通脚本跑完就结束了；服务器脚本跑完不结束，这是二者最大的区别。
 *
 * 【Node.js 是什么】
 *   浏览器里的 JavaScript 只能操作网页，不能读硬盘、不能监听网络端口。
 *   Node.js 是把同一个 JS 引擎搬到了电脑上运行，于是 JS 也能
 *   读写文件、开网络端口了。所以这个项目前后端都是 JS。
 *
 * 【本文件做的事】
 *   打开 HTTP 端口（默认 8787），为每个请求设置基础安全响应头，
 *   先处理 CORS / API，再按配置决定是否托管 public/。
 *   启动阶段还会初始化配置与数据库、执行历史数据迁移、打印运行模式，
 *   并启动回收站定时清扫；退出时停止接收新连接、等待在途请求并关闭 SQLite。
 *
 * 【读代码前需要知道的 4 个概念】
 *
 *   1. import —— 把别的文件里的东西引进来用。
 *      'node:http' 这种带 node: 前缀的是 Node 自带模块，不需要安装。
 *      带 './lib/' 前缀的是本项目自己写的文件，.js 后缀不能省。
 *
 *   2. async / await —— 「等这个操作完成，再往下走」。
 *      读写文件、网络请求都是耗时的。不加 await 会拿到还没准备好的结果。
 *
 *   3. req / res —— 一次请求的两个对象，贯穿全程：
 *        req = request  浏览器发过来的东西（地址、请求头、上传的数据）
 *        res = response 你要发回去的东西（状态码、响应头、内容）
 *
 *   4. 回调函数 —— 传给别人的函数，等某个时机到了由别人来调用。
 *      下面 http.createServer(回调) 的意思是：
 *      「每来一个请求，就调用这个函数，并把 req 和 res 交给你」。
 */

import http from 'node:http'                                   // Node 自带的 HTTP 模块
import {
  SERVE_STATIC,
  describeMode,
  describeRegistration,
  initializeConfig,
  PORT,
  requestProtocol,
} from './lib/config.js'   // 部署配置
import { parseRequestUrl } from './lib/request-url.js'
import { createShutdownHandler } from './lib/shutdown.js'
import { logEvent, newRequestId } from './lib/logger.js'
import { handleApi, startTrashSweeper } from './lib/api.js'      // 处理 /api/** 接口请求
import { serveStatic } from './lib/static.js'                  // 返回前端静态文件
import { applyCors, handlePreflight, corsSummary } from './lib/cors.js'  // 跨域支持
import { initializeDatabase, closeDb } from './lib/db.js'
import { databaseStats } from './lib/store.js'                  // 统计信息

/**
 * 0.0.0.0 表示「监听本机所有网卡」，外部机器也能连进来。
 * 如果写 127.0.0.1，就只有本机能访问，部署到服务器后外面打不开。
 */
const HOST = '0.0.0.0'
let trashSweeperTimer = null
const fileConfig = initializeConfig()
const { migrationResult, mediaCategoryFixResult } = await initializeDatabase()

/**
 * 创建服务器。注意这里只是「创建」，还没开始监听 ——
 * 真正开始对外服务是最后那行 server.listen()。
 *
 * 传进去的这个 async 函数就是「回调」：每来一个请求都会被调用一次，
 * 参数 req/res 对应这一次的请求和响应。
 */
const server = http.createServer(async (req, res) => {
  const requestId = newRequestId()
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  const startedAt = performance.now()
  res.once('finish', () => {
    logEvent('info', 'http_request', {
      requestId,
      method: req.method,
      path: req.logPath || 'invalid',
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    })
  })
  // ── 基础安全响应头 ──────────────────────────────────────────────────────
  // 每收到一个请求都会先设置这几项，用来收紧浏览器的默认行为。
  res.setHeader('X-Content-Type-Options', 'nosniff')   // 不许浏览器「猜」文件类型
  res.setHeader('Referrer-Policy', 'same-origin')      // 跳走时不泄露来源地址
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')       // 禁止别的站点用 iframe 嵌本页
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (requestProtocol(req) === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  /**
   * try / catch —— 兜住意外错误。
   * 如果下面任何一步抛出异常，都会跳到最后的 catch，
   * 返回一个 500 而不是让整个程序崩溃退出。
   */
  try {
    // req.url 只提供路径和查询参数，使用固定内部基准，绝不能依赖客户端 Host。
    const url = parseRequestUrl(req.url)
    req.logPath = url ? url.pathname : 'invalid'
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ error: '请求地址无效', code: 'INVALID_URL' }))
    }

    // ── 第 1 步：跨域检查 ────────────────────────────────────────────────
    // applyCors 会补上跨域响应头。返回 false 说明这个来源不被允许，
    // 直接 403 拒绝，后面的业务逻辑一概不执行。
    if (!applyCors(req, res)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: '请求来源不被允许', code: 'ORIGIN_NOT_ALLOWED' }))
    }

    // ── 第 2 步：浏览器预检 ──────────────────────────────────────────────
    // 跨域且「不简单」的请求，浏览器会先自动发一个 OPTIONS 请求来问路。
    // handlePreflight 如果应答了，就返回 true，本次处理到此结束。
    if (handlePreflight(req, res)) return

    // ── 第 3 步：接口请求 ────────────────────────────────────────────────
    // handleApi 内部会判断路径是否以 /api/ 开头。
    // 是 → 处理完返回 true；不是 → 返回 false，继续往下走。
    // 前面的 await 表示「等接口处理完」。注意这里必须 await，
    // 否则会先走到下面的静态资源分支，造成一个请求被处理两次。
    if (await handleApi(req, res, url)) return

    // 兜底：如果接口层其实已经发过响应、却返回了 false，
    // 这里绝不能再写一次响应头，否则会抛 ERR_HTTP_HEADERS_SENT 并污染日志。
    if (res.headersSent || res.writableEnded) return

    // ── 第 4 步：静态文件 ────────────────────────────────────────────────
    // 走到这里说明不是接口请求，那就是要前端文件（HTML/CSS/JS/图片）。
    if (SERVE_STATIC) {
      serveStatic(req, res, url)
      return
    }

    // API-only 模式（分离部署时用）：本进程不托管前端，未知路径统一 404。
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '接口不存在', code: 'NOT_FOUND' }))
  } catch (error) {
    logEvent('error', 'server_error', { requestId, message: error && error.message, stack: error && error.stack })
    // headersSent 判断「响应头是不是已经发出去了」。
    // 已经发出去就不能再改状态码了，否则 Node 会报错，所以这里要判断一下。
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '服务器内部错误', code: 'INTERNAL' }))
    }
  }
})

/**
 * 监听「错误」事件。最常见的是端口被占用（EADDRINUSE）。
 * 不做处理的话 Node 会甩一大段看不懂的堆栈，所以这里换成能照做的提示。
 */
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n启动失败：端口 ${PORT} 已被占用。`)
    console.error('多半是已经有一个实例在跑了。可以这样处理：')
    console.error('  1. 找出来并关掉：netstat -ano | findstr :' + PORT + '，再 taskkill /PID <进程号> /F')
    console.error('  2. 或者换个端口：$env:PORT=8788; node server.js')
    console.error('\n注意：不要让两个实例同时指向同一个 data/ 目录 ——')
    console.error('    多个进程共享同一个 data/ 会导致 SQLite 锁竞争、定时任务重复执行，')
    console.error('    并破坏内存限流和上传并发限制的全局性；请保持一个数据目录只运行一个实例。\n')
    process.exit(1)   // 以「失败」状态退出（0 表示正常退出）
  }
  throw error
})

/**
 * 真正开始监听端口。这一行执行后程序就「挂」在这里等请求，不会退出。
 * 最后一个参数是回调：端口成功打开后会被调用一次，用来打印启动信息。
 */
server.listen(PORT, HOST, () => {
  console.log(`个人云存储已启动 → http://localhost:${PORT}`)
  console.log(`  运行模式：${describeMode()}`)
  console.log(`  ${corsSummary()}`)
  console.log(`  注册策略：${describeRegistration()}`)

  // 首次启动会自动生成 config.json 和随机注册码，这里把码打出来方便直接使用
  if (fileConfig.justCreated) {
    console.log('')
    // 安全审计注记：注册码会进入启动日志；应优先仅在交互式 TTY 中显示。
    console.log('  已生成 config.json，本次注册码：')
    console.log(`      ${fileConfig.registrationCode}`)
    console.log('  把它发给要注册的人。想更换就直接改 config.json 里的 registrationCode，重启生效。')
    console.log('')
  }

  // 如果这次启动检测到了旧的 JSON 数据，说明刚做完迁移，值得明确告诉用户。
  if (!migrationResult.skipped) {
    console.log(`  数据迁移：已从 JSON 导入 ${migrationResult.users} 个用户、${migrationResult.files} 条文件记录`)
    if (migrationResult.warnings.length) {
      for (const warning of migrationResult.warnings) console.warn(`  数据迁移警告：${warning}`)
    } else {
      console.log('           旧文件已备份为 data/*.json.migrated')
    }
  }
  if (mediaCategoryFixResult.fixed > 0) {
    console.log(`  分类修复：已修正 ${mediaCategoryFixResult.fixed} 个历史媒体文件的分类`)
  }

  const stats = databaseStats()
  console.log(`  数据库：${stats.users} 个用户 · ${stats.files} 条文件记录`)

  // 启动回收站的定时清扫（启动时先扫一次，之后每 10 分钟一次）
  trashSweeperTimer = startTrashSweeper()
  console.log('  回收站：删除的文件保留 24 小时，超时自动清除')
})

// 允许大文件上传，但给整个请求一个绝对上限。
// 普通 JSON 请求体另有更短的读取超时（见 lib/request-body.js），不会占用 30 分钟。
server.requestTimeout = 30 * 60_000
// 读取请求头的超时限制为 60 秒，避免有人连上却不发数据、白占连接
server.headersTimeout = 60_000

const shutdown = createShutdownHandler({
  server,
  closeDb,
  beforeClose() {
    if (trashSweeperTimer) {
      clearInterval(trashSweeperTimer)
      trashSweeperTimer = null
    }
  },
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
