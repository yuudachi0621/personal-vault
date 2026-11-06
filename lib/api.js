/**
 * lib/api.js —— HTTP 路由与认证闸门。
 *
 * 业务处理器已拆分到 lib/api/auth.js、privacy.js、uploads.js、files.js；
 * 本模块只负责请求来源校验、限流、公开路由、登录闸门、路由匹配和错误映射。
 *
 * 安全审计注记：会话与隐私令牌目前共享 HMAC 密钥，且旧版无 sid 令牌仍兼容。
 * 收紧令牌类型、轮换密钥或改变密码学协议前必须先取得人工确认。
 */

import { sendJson as json, sendError as fail } from './http-response.js'
import { logEvent } from './logger.js'
import { getAppVersion } from './version.js'
import { sendStoredFile } from './file-stream.js'
import { createTrashSweeper } from './trash-sweeper.js'
import { requestIp } from './rate-limit.js'
import { videoPreviewPath, videoPreviewExists } from './video-preview.js'
import { queueMediaThumbnail } from './media-thumbnail.js'
import { cleanupExpiredUploadSessions } from './upload-session.js'
import { findFileForOwner, listExpiredFiles, purgeFile, deleteSession } from './store.js'
import { listExpiredFolderRoots, folderTreeFiles, purgeFolderTree } from './folder-store.js'
import { clearCookie, clearPrivacyCookie } from './auth.js'
import { cookieOptions, isOriginAllowed, isRegistrationCodeRequired } from './config.js'
import {
  acquireUploadSlot,
  releaseUploadSlot,
  enforceRateLimit,
  getSessionUser,
  getPrivacyUser,
  publicUser,
  removeStoredFile,
  TRASH_TTL_MS,
  TRASH_SWEEP_INTERVAL_MS,
} from './api/core.js'
import { handleRegister, handleLogin, handleChangePassword } from './api/auth.js'
import {
  handlePrivacySetup, handlePrivacyUnlock, handlePrivacyReset, handlePrivacyLock,
  handlePrivacyHeartbeat, handlePrivacyList, handleMoveToPrivacy, handleMoveOutOfPrivacy,
  handleDeletePrivateFile,
} from './api/privacy.js'
import {
  handleCreateUploadSession, handleUploadSessionStatus, handleUploadSessionChunk,
  handleCancelUploadSession, handleUpload,
} from './api/uploads.js'
import {
  handleList, handlePatch, handleDelete, handleTrashList, handleRestore,
  handlePurge, handleEmptyTrash,
} from './api/files.js'
import {
  handleFolderList, handleFolderCreate, handleFolderPatch, handleFolderDelete,
  handleFolderRestore, handleFolderPurge, handleFolderDownload,
} from './api/folders.js'
/**
 * 定时清扫：把所有超过 24 小时的回收站文件与文件夹树真正删掉。
 *
 * 启动时先立即扫一次（进程重启过，期间可能已经过期了），
 * 之后每 10 分钟扫一次。返回的 timer 已 unref，不会阻止进程退出。
 *
 * 为什么用 setInterval 而不是精确的定时器？
 *   过期时间点很分散，为每个文件挂一个定时器既费内存、
 *   又会在重启后全部丢失。定期扫描的语义更简单可靠：
 *   「每 10 分钟问一次，有没有谁该走了」——
 *   最坏情况是晚 10 分钟清理，用户完全感知不到。
 */
const startTrashSweeperImpl = createTrashSweeper({
  listExpiredFiles,
  listExpiredFolders: listExpiredFolderRoots,
  folderTreeFiles,
  purgeFolderTree,
  removeStoredFile,
  purgeFile,
  cleanupExpiredUploadSessions,
  trashTtlMs: TRASH_TTL_MS,
  intervalMs: TRASH_SWEEP_INTERVAL_MS,
})

export function startTrashSweeper() {
  return startTrashSweeperImpl()
}
/* ══════════════════════════════════════════════════════════════════════════
   五、路由（把「请求」分派给上面那些处理函数）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 处理本次请求。
 * @returns {Promise<boolean>} true  = 已经处理完了
 *                             false = 不是接口请求，交回 server.js 去发静态文件
 *
 * 整个函数就是一个大的 if 判断链：按「路径 + 方法」找到该执行哪段代码。
 * 这叫「路由」，是所有 Web 框架最核心的东西。
 */
export async function handleApi(req, res, url) {
  const { pathname } = url

  // 不是 /api/ 开头就不是接口请求，直接交回去
  if (!pathname.startsWith('/api/')) return false

  try {
    /**
     * 来源校验。
     * 浏览器发起的请求会带 Origin 头（标明来自哪个网站）。
     * 只允许「同源」或「配置过的白名单来源」，其它一律 403。
     *
     * 这一层在 Cookie 放宽为 SameSite=None 之后尤其重要：
     * 否则别的网站可以偷偷借用你浏览器里的登录凭证来操作本系统（CSRF 攻击）。
     */
    // 浏览器播放视频时会自动发起大量 Range 请求；媒体流必须使用独立高额度，
    // 否则连续拖动或长时间缓冲后会被普通 API 的限流误伤，表现为视频永久卡住。
    const isMediaStream = /^\/api\/files\/[A-Za-z0-9_-]+\/(?:raw|download|preview|thumbnail)$/.test(pathname)
    const apiLimit = isMediaStream ? 3000 : 600
    const rateScope = isMediaStream ? 'media' : 'api'
    if (!enforceRateLimit(res, `${rateScope}:${requestIp(req)}`, apiLimit, 60_000, '请求过于频繁，请稍后再试')) return true

    const origin = req.headers.origin
    const fetchSite = String(req.headers['sec-fetch-site'] || '')
    if ((!origin && fetchSite === 'cross-site') || (origin && !isOriginAllowed(req, origin))) {
      // 注意：这里必须是「先 fail 再 return true」。
      // 如果写成 `return fail(...)`，返回的是 undefined，
      // server.js 会误以为「这个接口没处理」，接着又去走静态文件分支，
      // 造成同一个请求写两次响应头（ERR_HTTP_HEADERS_SENT）。
      fail(res, 403, '请求来源不被允许', 'ORIGIN_NOT_ALLOWED')
      return true
    }

    /* ── 公开接口：不需要登录 ────────────────────────────────────────── */
    /**
     * 告诉前端「注册需不需要注册码」。
     * 前端据此决定要不要显示注册码输入框 —— 不需要时不该让用户看到一个多余的空格。
     * 这个接口不返回注册码本身，只返回一个布尔值。
     */
    if (pathname === '/api/meta' && req.method === 'GET') {
      json(res, 200, { version: getAppVersion() })
      return true
    }
    if (pathname === '/api/auth/config' && req.method === 'GET') {
      json(res, 200, { requireRegistrationCode: isRegistrationCodeRequired() })
      return true
    }
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      await handleRegister(req, res)
      return true
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      await handleLogin(req, res)
      return true
    }

    /* ── 以下接口都需要登录 ─────────────────────────────────────────── */
    const user = getSessionUser(req)

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      if (user && user.sessionId) deleteSession(user.sessionId, user.id)
      json(res, 200, { ok: true }, {
        'Set-Cookie': [clearCookie(cookieOptions(req)), clearPrivacyCookie(cookieOptions(req))],
      })
      return true
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      if (!user) {
        fail(res, 401, '未登录', 'UNAUTHENTICATED')
        return true
      }
      json(res, 200, { user: publicUser(user) })
      return true
    }

    /**
     * ★ 登录闸门 ★
     * 放在这里意味着：下面所有接口一旦没登录，统统会被挡掉返回 401。
     * 这样的好处是不用在每个处理函数里重复写一遍登录检查 ——
     * 万一漏写一个就是漏洞，集中判断更安全。
     */
    if (!user) {
      fail(res, 401, '请先登录', 'UNAUTHENTICATED')
      return true
    }

    if (pathname === '/api/auth/password' && req.method === 'PATCH') {
      await handleChangePassword(req, res, user)
      return true
    }

    /* ── 隐私空间解锁与访问 ─────────────────────────────────────────── */
    if (pathname === '/api/privacy/setup' && req.method === 'POST') {
      await handlePrivacySetup(req, res, user)
      return true
    }
    if (pathname === '/api/privacy/unlock' && req.method === 'POST') {
      await handlePrivacyUnlock(req, res, user)
      return true
    }
    if (pathname === '/api/privacy/reset' && req.method === 'POST') {
      await handlePrivacyReset(req, res, user)
      return true
    }
    if (pathname === '/api/privacy/lock' && req.method === 'POST') {
      handlePrivacyLock(req, res)
      return true
    }
    if (pathname === '/api/privacy/heartbeat' && req.method === 'POST') {
      handlePrivacyHeartbeat(req, res, user)
      return true
    }
    if (pathname === '/api/privacy/files' && req.method === 'GET') {
      handlePrivacyList(req, res, url, user)
      return true
    }

    const privacyFileMatch = /^\/api\/privacy\/files\/([A-Za-z0-9_-]+)(?:\/(move-out))?$/.exec(pathname)
    if (privacyFileMatch) {
      if (!getPrivacyUser(req, user)) {
        privacyLocked(res)
        return true
      }
      const [, privacyId, privacyAction] = privacyFileMatch
      if (req.method === 'POST' && privacyAction === undefined) {
        handleMoveToPrivacy(res, privacyId, user)
        return true
      }
      if (req.method === 'POST' && privacyAction === 'move-out') {
        handleMoveOutOfPrivacy(res, privacyId, user)
        return true
      }
      if (req.method === 'DELETE' && privacyAction === undefined) {
        handleDeletePrivateFile(res, privacyId, user)
        return true
      }
    }

    /* ── 断点续传上传会话 ───────────────────────────────────────────── */
    if (pathname === '/api/uploads' && req.method === 'POST') {
      await handleCreateUploadSession(req, res, user)
      return true
    }
    const uploadSessionMatch = /^\/api\/uploads\/([a-f0-9-]{36})$/i.exec(pathname)
    if (uploadSessionMatch) {
      const uploadId = uploadSessionMatch[1]
      if (req.method === 'GET' || req.method === 'HEAD') {
        handleUploadSessionStatus(req, res, uploadId, user)
        return true
      }
      if (req.method === 'PATCH') {
        await handleUploadSessionChunk(req, res, uploadId, user)
        return true
      }
      if (req.method === 'DELETE') {
        handleCancelUploadSession(req, res, uploadId, user)
        return true
      }
    }

    /* ── 普通空间文件夹 ──────────────────────────────────────────────── */
    if (pathname === '/api/folders' && req.method === 'GET') {
      handleFolderList(req, res, user)
      return true
    }
    if (pathname === '/api/folders' && req.method === 'POST') {
      await handleFolderCreate(req, res, user)
      return true
    }
    const folderDownloadMatch = /^\/api\/folders\/([A-Za-z0-9_-]+)\/download$/.exec(pathname)
    if (folderDownloadMatch && req.method === 'GET') {
      await handleFolderDownload(req, res, folderDownloadMatch[1], user)
      return true
    }
    const folderRestoreMatch = /^\/api\/folders\/([A-Za-z0-9_-]+)\/restore$/.exec(pathname)
    if (folderRestoreMatch && req.method === 'POST') {
      handleFolderRestore(res, folderRestoreMatch[1], user)
      return true
    }
    const folderMatch = /^\/api\/folders\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (folderMatch) {
      if (req.method === 'PATCH') {
        await handleFolderPatch(req, res, folderMatch[1], user)
        return true
      }
      if (req.method === 'DELETE') {
        handleFolderDelete(res, folderMatch[1], user)
        return true
      }
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      handleList(req, res, url, user)
      return true
    }
    if (pathname === '/api/files/upload' && req.method === 'POST') {
      if (!enforceRateLimit(res, `upload:${user.id}`, 120, 60 * 60 * 1000, '上传过于频繁，请稍后再试')) return true
      if (!acquireUploadSlot(user.id)) {
        fail(res, 503, '当前上传任务过多，请稍后再试', 'UPLOAD_BUSY', { 'Retry-After': 1 })
        return true
      }
      try {
        await handleUpload(req, res, url, user)
      } finally {
        releaseUploadSlot(user.id)
      }
      return true
    }

    /* ── 回收站 ──────────────────────────────────────────────────────── */
    if (pathname === '/api/trash' && req.method === 'GET') {
      handleTrashList(req, res, url, user)
      return true
    }
    if (pathname === '/api/trash' && req.method === 'DELETE') {
      handleEmptyTrash(res, user)
      return true
    }

    const folderPurgeMatch = /^\/api\/trash\/folders\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (folderPurgeMatch && req.method === 'DELETE') {
      handleFolderPurge(res, folderPurgeMatch[1], user)
      return true
    }

    // /api/trash/:id —— 彻底删除单个文件
    const purgeMatch = /^\/api\/trash\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (purgeMatch && req.method === 'DELETE') {
      handlePurge(res, purgeMatch[1], user)
      return true
    }

    // /api/files/:id/restore —— 从回收站恢复
    const restoreMatch = /^\/api\/files\/([A-Za-z0-9_-]+)\/restore$/.exec(pathname)
    if (restoreMatch) {
      if (req.method !== 'POST') {
        fail(res, 405, '方法不支持', 'METHOD_NOT_ALLOWED')
        return true
      }
      handleRestore(res, restoreMatch[1], user)
      return true
    }

    /**
     * 带 id 的路径用「正则」匹配。
     *   ([A-Za-z0-9_-]+)       第一个括号 = 文件 id
     *   (?:\/(raw|download|preview|thumbnail))?  可选后缀
     * 匹配上之后，match[1] 是 id，match[2] 是 'raw' / 'download' /
     * 'preview' / 'thumbnail' / undefined。
     */
    const match = /^\/api\/files\/([A-Za-z0-9_-]+)(?:\/(raw|download|preview|thumbnail))?$/.exec(pathname)
    if (match) {
      const [, id, action] = match

      if (action === 'raw' || action === 'download' || action === 'preview' || action === 'thumbnail') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fail(res, 405, '方法不支持', 'METHOD_NOT_ALLOWED')
          return true
        }
        // ★ 归属检查：不是本人的文件当作不存在
        const record = findFileForOwner(id, user.id)
        if (!record || (record.isPrivate && !getPrivacyUser(req, user))) {
          fail(res, 404, '文件不存在', 'NOT_FOUND')
          return true
        }
        if (action === 'thumbnail') {
          if (!['image', 'video'].includes(record.category)) {
            fail(res, 404, '该文件没有媒体封面', 'THUMBNAIL_NOT_AVAILABLE')
            return true
          }
          const thumbnailPath = await queueMediaThumbnail(record)
          if (!thumbnailPath) {
            fail(res, 404, '媒体封面暂不可用', 'THUMBNAIL_NOT_AVAILABLE')
            return true
          }
          sendStoredFile(req, res, record, 'inline', {
            filePath: thumbnailPath,
            mime: 'image/jpeg',
            inlineMime: 'image/jpeg',
            cacheControl: 'private, max-age=604800',
            isPreview: true,
          })
          return true
        }
        if (action === 'preview') {
          if (record.category !== 'video') {
            fail(res, 404, '该文件没有视频预览', 'PREVIEW_NOT_AVAILABLE')
            return true
          }
          const previewPath = videoPreviewPath(record)
          const hasPreview = videoPreviewExists(record)
          // 预览副本不存在时自动回退原始视频，不阻塞现有播放流程
          sendStoredFile(req, res, record, 'inline', hasPreview
            ? { filePath: previewPath, mime: 'video/mp4', isPreview: true }
            : { isPreview: false })
          return true
        }
        // 预览用 inline（页面里直接显示），下载用 attachment（弹另存为）
        sendStoredFile(req, res, record, action === 'download' ? 'attachment' : 'inline')
        return true
      }
      if (req.method === 'PATCH') {
        await handlePatch(req, res, id, user)
        return true
      }
      if (req.method === 'DELETE') {
        handleDelete(res, id, user)
        return true
      }
    }

    // 路径以 /api/ 开头但没有匹配上任何规则 → 接口不存在
    fail(res, 404, '接口不存在', 'NOT_FOUND')
    return true
  } catch (error) {
    /**
     * 兜底错误处理。
     * 上面任何一步抛出异常都会落到这里，保证接口一定给出一个明确回应，
     * 而不是让浏览器一直转圈等超时。
     */
    if (res.headersSent) return true   // 响应已经开始发了，没法再改状态码

    const status = error && error.status ? error.status : 500
    // 500 是「服务器自己的问题」，不该把内部错误详情泄露给用户
    const message = status === 500 ? '服务器开小差了，请稍后重试' : error.message
    const code = status === 500 ? 'INTERNAL' : ((error && error.code) || 'BAD_REQUEST')
    const closeConnection = Boolean(error && error.closeConnection)
    const extraHeaders = closeConnection ? { Connection: 'close' } : {}
    if (status === 500) {
      logEvent('error', 'api_error', {
        requestId: req.requestId,
        status,
        code,
        message: error && error.message,
        stack: error && error.stack,
      })
    }
    if (closeConnection) {
      res.once('finish', () => {
        if (!req.destroyed) req.destroy()
      })
    }
    fail(res, status, message, code, extraHeaders)
    return true
  }
}
