/** 认证处理器：注册、登录、密码修改。 */
import crypto from 'node:crypto'
import { readJsonBody } from '../request-body.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { requestIp, loginAccountRateKey, resetRateLimit } from '../rate-limit.js'
import { hashPassword, verifyPassword, sessionCookie, clearPrivacyCookie } from '../auth.js'
import { cookieOptions, isRegistrationCodeValid, isRegistrationCodeRequired } from '../config.js'
import { findUserByEmail, findUserById, createUser, updateUserPassword, deleteSessionsForUser } from '../store.js'
import {
  enforceRateLimit,
  issueSessionToken,
  sanitizeName,
  publicUser,
  EMAIL_RE,
  DUMMY_SALT,
  DUMMY_HASH,
  RATE_LIMIT_WINDOW_MS,
  REGISTER_RATE_WINDOW_MS,
} from './core.js'
/* ══════════════════════════════════════════════════════════════════════════
   三、认证相关接口
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 注册。
 * 流程：校验 → 查重 → 哈希密码 → 存用户 → 直接签发令牌（注册完即登录）
 */
export async function handleRegister(req, res) {
  const body = await readJsonBody(req)
  if (!enforceRateLimit(res, `register:${requestIp(req)}`, 10, REGISTER_RATE_WINDOW_MS, '注册请求过于频繁，请稍后再试')) return

  // 一律转小写，避免 Alice@x.com 和 alice@x.com 注册成两个账号
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  // 没填昵称就用邮箱 @ 前面那段
  const nickname = sanitizeName(body.nickname || email.split('@')[0]).slice(0, 32)

  // 先做各种检查，有问题就提前返回 —— 这叫「尽早失败」
  if (!EMAIL_RE.test(email)) return fail(res, 400, '请输入有效的邮箱地址', 'INVALID_EMAIL')
  if (password.length < 8) return fail(res, 400, '密码至少需要 8 位', 'WEAK_PASSWORD')
  if (password.length > 128) return fail(res, 400, '密码不能超过 128 位', 'PASSWORD_TOO_LONG')

  /**
   * 注册码校验。
   *
   * 放在「格式检查之后、查重之前」，顺序是有讲究的：
   *   - 放在最后 → 没有注册码的人也能通过「邮箱已注册」这个提示，
   *     批量探测出哪些邮箱在本站注册过
   *   - 放在最前 → 用户填错邮箱格式还要先过一次注册码，多一轮往返
   * 夹在中间两边都兼顾：格式错误优先反馈，探测被注册码挡住。
   */
  if (isRegistrationCodeRequired()) {
    const registrationCode = String(body.registrationCode || '')
    if (!registrationCode.trim()) {
      return fail(res, 403, '请填写注册码', 'REGISTRATION_CODE_REQUIRED')
    }
    if (!isRegistrationCodeValid(registrationCode)) {
      return fail(res, 403, '注册码不正确', 'INVALID_REGISTRATION_CODE')
    }
  }

  if (findUserByEmail(email)) {
    return fail(res, 409, '该邮箱已注册，请直接登录', 'EMAIL_TAKEN')
  }

  const { salt, hash } = await hashPassword(password)

  const user = {
    // randomUUID 生成全球唯一的随机串，去掉横杠后取前 20 位当用户 id
    id: `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    email,
    nickname,
    salt,          // 盐
    passwordHash: hash,  // 哈希后的密码（绝不存明文）
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
  }
  createUser(user)   // 写入数据库

  const token = issueSessionToken(user)
  // 201 = 已创建。顺便通过 Set-Cookie 把登录凭证发给浏览器，注册完直接就是登录状态。
  json(res, 201, { user: publicUser(user) }, {
    'Set-Cookie': [sessionCookie(token, cookieOptions(req)), clearPrivacyCookie(cookieOptions(req))],
  })
}

/** 登录：比对密码，成功就签发令牌。 */
export async function handleLogin(req, res) {
  const body = await readJsonBody(req)
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const ip = requestIp(req)
  const accountKey = loginAccountRateKey(email)

  if (!enforceRateLimit(res, `login-ip:${ip}`, 120, RATE_LIMIT_WINDOW_MS, '登录尝试过于频繁，请稍后再试')) return
  if (!enforceRateLimit(res, accountKey, 10, RATE_LIMIT_WINDOW_MS, '该账号登录尝试过于频繁，请稍后再试')) return

  if (password.length > 128) {
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }

  const user = findUserByEmail(email)

  /**
   * 注意：邮箱不存在和密码错误，返回的是同一句话「邮箱或密码不正确」。
   * 如果分开提示，攻击者就能靠试错问出「这个邮箱注册过没有」，
   * 从而拿到一份有效邮箱名单去撞库。这叫「不泄露账号是否存在」。
   */
  if (!user) {
    await verifyPassword(password, DUMMY_SALT, DUMMY_HASH)
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }
  if (!(await verifyPassword(password, user.salt, user.passwordHash))) {
    return fail(res, 401, '邮箱或密码不正确', 'INVALID_CREDENTIALS')
  }

  resetRateLimit(accountKey)
  const token = issueSessionToken(user)
  json(res, 200, { user: publicUser(user) }, {
    'Set-Cookie': [sessionCookie(token, cookieOptions(req)), clearPrivacyCookie(cookieOptions(req))],
  })
}

/** 修改密码：先验旧密码，再存新密码的哈希。 */
export async function handleChangePassword(req, res, user) {
  const body = await readJsonBody(req)
  if (!enforceRateLimit(res, `password:${user.id}`, 10, RATE_LIMIT_WINDOW_MS, '改密操作过于频繁，请稍后再试')) return
  const oldPassword = String(body.oldPassword || '')
  const newPassword = String(body.newPassword || '')

  if (!(await verifyPassword(oldPassword, user.salt, user.passwordHash))) {
    return fail(res, 400, '当前密码不正确', 'INVALID_CREDENTIALS')
  }
  if (newPassword.length < 8) return fail(res, 400, '新密码至少需要 8 位', 'WEAK_PASSWORD')
  if (newPassword.length > 128) return fail(res, 400, '新密码不能超过 128 位', 'PASSWORD_TOO_LONG')

  const { salt, hash } = await hashPassword(newPassword)
  updateUserPassword(user.id, salt, hash)   // 盐也要同步换新，并撤销其它旧会话
  const updatedUser = findUserById(user.id)
  if (!updatedUser) return fail(res, 500, '账号状态异常', 'USER_MISSING')
  deleteSessionsForUser(updatedUser.id)
  const token = issueSessionToken(updatedUser)
  json(res, 200, { ok: true }, {
    'Set-Cookie': [sessionCookie(token, cookieOptions(req)), clearPrivacyCookie(cookieOptions(req))],
  })
}

