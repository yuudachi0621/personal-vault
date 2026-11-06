/** 隐私空间处理器：设置、解锁、锁定、心跳和隐私文件操作。 */
import { readJsonBody } from '../request-body.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { cookieOptions } from '../config.js'
import { hashPassword, verifyPassword, signToken, privacyCookie, clearPrivacyCookie, PRIVACY_TTL_MS } from '../auth.js'
import {
  findUserById,
  setUserPrivacyPassword,
  privacyUsageFor,
  listFiles,
  countFiles,
  moveFileToPrivacy,
  moveFileOutOfPrivacy,
  findFileForOwner,
  deletePrivateFileRecord,
} from '../store.js'
import {
  enforceRateLimit,
  getPrivacyUser,
  privacyLocked,
  publicUser,
  publicFile,
  removeStoredFile,
  CATEGORIES,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  RATE_LIMIT_WINDOW_MS,
} from './core.js'
import { parsePagination, buildPageInfo } from '../pagination.js'
/* ══════════════════════════════════════════════════════════════════════════
   隐私空间
   ══════════════════════════════════════════════════════════════════════════ */

export function issuePrivacyToken(user) {
  return signToken({
    uid: user.id,
    scope: 'privacy',
    ver: user.privacyVersion,
    sver: user.sessionVersion,
  }, PRIVACY_TTL_MS)
}

/** 首次设置隐私密码；设置成功后立即解锁。 */
export async function handlePrivacySetup(req, res, user) {
  if (!enforceRateLimit(res, `privacy-setup:${user.id}`, 10, RATE_LIMIT_WINDOW_MS, '操作过于频繁，请稍后再试')) return
  if (user.privacyHash) return fail(res, 409, '隐私密码已经设置', 'PRIVACY_PASSWORD_EXISTS')

  const body = await readJsonBody(req)
  const password = String(body.password || '')
  if (password.length < 8) return fail(res, 400, '隐私密码至少需要 8 位', 'WEAK_PRIVACY_PASSWORD')
  if (password.length > 128) return fail(res, 400, '隐私密码不能超过 128 位', 'PRIVACY_PASSWORD_TOO_LONG')

  const { salt, hash } = await hashPassword(password)
  setUserPrivacyPassword(user.id, salt, hash)
  const updatedUser = findUserById(user.id)
  if (!updatedUser) return fail(res, 500, '账号状态异常', 'USER_MISSING')
  const token = issuePrivacyToken(updatedUser)
  json(res, 200, { user: publicUser(updatedUser) }, {
    'Set-Cookie': privacyCookie(token, cookieOptions(req)),
  })
}

/** 输入隐私密码解锁，解锁有效期 15 分钟。 */
export async function handlePrivacyUnlock(req, res, user) {
  if (!enforceRateLimit(res, `privacy-unlock:${user.id}`, 10, RATE_LIMIT_WINDOW_MS, '隐私密码尝试过于频繁，请稍后再试')) return
  if (!user.privacyHash) return fail(res, 409, '请先设置隐私密码', 'PRIVACY_SETUP_REQUIRED')

  const body = await readJsonBody(req)
  const password = String(body.password || '')
  if (password.length > 128) return fail(res, 401, '隐私密码不正确', 'INVALID_PRIVACY_PASSWORD')
  if (!(await verifyPassword(password, user.privacySalt, user.privacyHash))) {
    return fail(res, 401, '隐私密码不正确', 'INVALID_PRIVACY_PASSWORD')
  }

  const token = issuePrivacyToken(user)
  json(res, 200, { ok: true }, { 'Set-Cookie': privacyCookie(token, cookieOptions(req)) })
}

/**
 * 忘记隐私密码时，用当前账号密码验证身份并设置新的隐私密码。
 * 成功后递增 privacy_version，使其它浏览器上已有的隐私解锁令牌立即失效。
 */
export async function handlePrivacyReset(req, res, user) {
  if (!enforceRateLimit(res, `privacy-reset:${user.id}`, 10, RATE_LIMIT_WINDOW_MS, '隐私密码重置过于频繁，请稍后再试')) return
  if (!user.privacyHash) return fail(res, 409, '尚未设置隐私密码', 'PRIVACY_SETUP_REQUIRED')

  const body = await readJsonBody(req)
  const accountPassword = String(body.accountPassword || '')
  const newPassword = String(body.newPassword || '')

  if (accountPassword.length > 128) {
    return fail(res, 401, '当前账号密码不正确', 'INVALID_ACCOUNT_PASSWORD')
  }
  if (!(await verifyPassword(accountPassword, user.salt, user.passwordHash))) {
    return fail(res, 401, '当前账号密码不正确', 'INVALID_ACCOUNT_PASSWORD')
  }
  if (newPassword.length < 8) return fail(res, 400, '新隐私密码至少需要 8 位', 'WEAK_PRIVACY_PASSWORD')
  if (newPassword.length > 128) return fail(res, 400, '新隐私密码不能超过 128 位', 'PRIVACY_PASSWORD_TOO_LONG')

  const { salt, hash } = await hashPassword(newPassword)
  setUserPrivacyPassword(user.id, salt, hash)
  const updatedUser = findUserById(user.id)
  if (!updatedUser) return fail(res, 500, '账号状态异常', 'USER_MISSING')
  const token = issuePrivacyToken(updatedUser)
  json(res, 200, { user: publicUser(updatedUser) }, {
    'Set-Cookie': privacyCookie(token, cookieOptions(req)),
  })
}

export function handlePrivacyLock(req, res) {
  json(res, 200, { ok: true }, { 'Set-Cookie': clearPrivacyCookie(cookieOptions(req)) })
}

/**
 * 活跃浏览 / 播放期间续签隐私 Cookie。
 * 前端只在有真实操作或媒体仍在播放时调用，离开页面后令牌会在 15 分钟内自然失效。
 */
export function handlePrivacyHeartbeat(req, res, user) {
  if (!getPrivacyUser(req, user)) return privacyLocked(res)
  json(res, 200, { ok: true }, {
    'Set-Cookie': privacyCookie(issuePrivacyToken(user), cookieOptions(req)),
  })
}

/** 隐私空间列表，只有携带有效隐私 Cookie 才能访问。 */
export function handlePrivacyList(req, res, url, user) {
  if (!getPrivacyUser(req, user)) return privacyLocked(res)

  const { limit, offset } = parsePagination(url.searchParams, { defaultLimit: PAGE_SIZE, maxLimit: MAX_PAGE_SIZE })
  const query = String(url.searchParams.get('q') || '').trim()
  const sort = url.searchParams.get('sort') || 'newest'
  const filter = { ownerId: user.id, deleted: false, privateOnly: true, query }
  const rows = listFiles({ ...filter, sort, limit, offset })
  const total = countFiles(filter)

  json(res, 200, {
    files: rows.map(publicFile),
    usage: privacyUsageFor(user.id),
    page: buildPageInfo({ limit, offset, total, returned: rows.length }),
  })
}

export function handleMoveToPrivacy(res, id, user) {
  const record = moveFileToPrivacy(id, user.id)
  if (!record) return fail(res, 404, '文件不存在', 'NOT_FOUND')
  json(res, 200, { ok: true, file: publicFile(record) })
}

export function handleMoveOutOfPrivacy(res, id, user) {
  const record = moveFileOutOfPrivacy(id, user.id)
  if (!record) return fail(res, 404, '隐私文件不存在', 'NOT_FOUND')
  json(res, 200, { ok: true, file: publicFile(record) })
}

/** 隐私空间删除为永久删除，避免文件进入普通回收站后暴露。 */
export function handleDeletePrivateFile(res, id, user) {
  const record = findFileForOwner(id, user.id)
  if (!record || !record.isPrivate || record.deletedAt) return fail(res, 404, '隐私文件不存在', 'NOT_FOUND')
  if (!removeStoredFile(record)) return fail(res, 500, '文件删除失败，请稍后重试', 'FILE_DELETE_FAILED')
  if (!deletePrivateFileRecord(id, user.id)) return fail(res, 404, '隐私文件不存在', 'NOT_FOUND')
  json(res, 200, { ok: true })
}

