/**
 * ============================================================================
 *  lib/store.js —— 数据访问层（所有 SQL 都集中在这里）
 * ============================================================================
 *
 * 【分层的原因】
 *   业务逻辑（lib/api.js）不应该关心 SQL 怎么写。
 *   这里把「怎么查、怎么改」封装成普通函数，api.js 只管调用。
 *   好处是：以后换数据库、加缓存、改索引，都只动这一个文件。
 *
 * 【一个重要的安全原则】
 *   所有用户输入都必须作为「参数」传给 SQL，用 ? 占位。
 *   绝不能写成 `WHERE name = '${用户输入}'` —— 那是 SQL 注入漏洞，
 *   输入 `' OR '1'='1` 就能把别人的数据全查出来。
 *   本项目全部使用参数化查询，唯一拼接进 SQL 的是「排序方式」，
 *   而且它来自一个写死的白名单（SORTS），不是直接拼用户输入。
 *
 * 【所有查询都带 owner_id 条件】
 *   这是数据隔离的第二道关卡：即使 api.js 忘了判断归属，
 *   SQL 层也只可能查到当前用户自己的记录。
 */

import { db, mapUser, mapFile } from './db.js'

/**
 * 预编译语句缓存。
 *
 * db.prepare() 会把 SQL 文本编译成可执行计划，有一定开销。
 * 同样的 SQL 反复用到时缓存起来，就不必每次都编译。
 * 键是 SQL 文本，值是可复用的 statement 对象。
 */
const statementCache = new Map()

function prep(sql) {
  let statement = statementCache.get(sql)
  if (!statement) {
    statement = db.prepare(sql)
    statementCache.set(sql, statement)
  }
  return statement
}

/* ══════════════════════════════════════════════════════════════════════════
   用户
   ══════════════════════════════════════════════════════════════════════════ */

/** 按邮箱查用户（登录用）。找不到返回 null。 */
export function findUserByEmail(email) {
  return mapUser(prep('SELECT * FROM users WHERE email = ?').get(email))
}

/** 按 id 查用户（每次请求验证会话时用）。 */
export function findUserById(id) {
  return mapUser(prep('SELECT * FROM users WHERE id = ?').get(id))
}

/** 新建用户。邮箱列有 UNIQUE 约束，重复会被数据库拒绝。 */
export function createUser(user) {
  prep(`
    INSERT INTO users (id, email, nickname, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.email, user.nickname, user.salt, user.passwordHash, user.createdAt)
  return user
}

/** 改密码：只更新盐和哈希两列，其它字段不动。 */
export function updateUserPassword(id, salt, passwordHash) {
  const result = prep('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?')
    .run(salt, passwordHash, id)
  return result.changes > 0
}

/** 用户总数（启动日志用）。 */
export function countUsers() {
  return prep('SELECT COUNT(*) AS n FROM users').get().n
}

/* ══════════════════════════════════════════════════════════════════════════
   文件
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 排序白名单。
 *
 * 为什么不能直接把前端传的 sort 拼进 SQL？
 *   因为 ORDER BY 后面不能用 ? 参数占位（只能拼字符串）。
 *   所以要拿用户输入去「查表」，查到哪个用哪个，
 *   查不到就用默认值。这样无论前端传什么，SQL 都安全。
 */
const SORTS = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  name: 'name ASC',
  largest: 'size DESC',
  // 回收站按「删除时间」倒序，最近删的在最上面
  deleted: 'deleted_at DESC',
}

/**
 * LIKE 通配符转义。
 * 用户搜索 "100%" 时，% 在 LIKE 里代表「任意字符」，
 * 不转义就会变成「以 100 开头的所有文件」。这里把它变成普通字符。
 */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 根据筛选条件拼出 WHERE 子句和对应的参数数组。
 * 列表查询和计数查询共用，保证两者条件完全一致。
 *
 * deleted 参数控制取哪一批：
 *   false（默认）→ 只要正常文件（deleted_at IS NULL）
 *   true        → 只要回收站里的（deleted_at IS NOT NULL）
 *
 * 注意 NULL 在 SQL 里不能用 = 比较（NULL = NULL 结果是 NULL 而不是 true），
 * 所以必须写 IS NULL / IS NOT NULL。
 */
function buildWhere({ ownerId, category, query, deleted = false }) {
  const conditions = ['owner_id = ?']
  const params = [ownerId]

  conditions.push(deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL')

  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }
  if (query) {
    conditions.push("name LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(query)}%`)
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params }
}

/** 新增一条文件记录。 */
export function createFile(record) {
  prep(`
    INSERT INTO files
      (id, owner_id, name, category, mime, size, stored_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.ownerId,
    record.name,
    record.category,
    record.mime,
    record.size,
    record.storedName,
    record.createdAt,
    record.updatedAt,
  )
  return record
}

/**
 * 按 id 查文件，且必须属于指定用户。
 * 不属于本人时返回 null —— 和「不存在」表现一致，不泄露他人文件的存在性。
 *
 * 注意：这里**不排除回收站里的记录**。
 * 因为回收站需要预览缩略图、恢复操作也要能查到它。
 * 只想要正常文件时用下面的 findActiveFileForOwner。
 */
export function findFileForOwner(id, ownerId) {
  return mapFile(
    prep('SELECT * FROM files WHERE id = ? AND owner_id = ?').get(id, ownerId),
  )
}

/** 同上，但只在「正常文件」里找（回收站里的当作不存在）。 */
export function findActiveFileForOwner(id, ownerId) {
  return mapFile(
    prep('SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').get(id, ownerId),
  )
}

/**
 * 分页查询文件列表。
 *
 * LIMIT / OFFSET 是数据库层面的分页：
 *   数据库只返回这一页的几十条，而不是把所有记录都搬到内存里。
 * 这就是「一次查 100 条」和「一次查 10 万条」的差别 ——
 * 内存占用和响应时间都从「随数据量增长」变成「恒定」。
 *
 * 索引 idx_files_owner_created 正好匹配这里的 WHERE + ORDER BY，
 * 所以数据库不需要排序整张表，直接按顺序取前 N 条即可。
 */
export function listFiles({ ownerId, category, query, deleted = false, sort = 'newest', limit = 60, offset = 0 }) {
  const { clause, params } = buildWhere({ ownerId, category, query, deleted })
  const orderBy = SORTS[sort] || (deleted ? SORTS.deleted : SORTS.newest)

  return prep(`SELECT * FROM files ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(mapFile)
}

/** 当前筛选条件下的总条数（用于判断「还有没有下一页」）。 */
export function countFiles({ ownerId, category, query, deleted = false }) {
  const { clause, params } = buildWhere({ ownerId, category, query, deleted })
  return prep(`SELECT COUNT(*) AS n FROM files ${clause}`).get(...params).n
}

/**
 * 用量统计。
 *
 * 用 SQL 的 COUNT / SUM 让数据库自己算完再返回一个数字，
 * 而不是把所有记录查出来再用 JS 循环累加 ——
 * 前者只传回一行结果，后者要把整个结果集搬到内存。
 */
export function usageFor(ownerId) {
  // 侧栏的用量只统计「正常文件」，回收站里的单独算
  const total = prep(`
    SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
    FROM files WHERE owner_id = ? AND deleted_at IS NULL
  `).get(ownerId)

  const grouped = prep(`
    SELECT category, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
    FROM files WHERE owner_id = ? AND deleted_at IS NULL GROUP BY category
  `).all(ownerId)

  const trashed = prep(`
    SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes
    FROM files WHERE owner_id = ? AND deleted_at IS NOT NULL
  `).get(ownerId)

  const byCategory = { image: 0, video: 0, music: 0, file: 0 }
  const bytesByCategory = { image: 0, video: 0, music: 0, file: 0 }

  for (const row of grouped) {
    if (row.category in byCategory) {
      byCategory[row.category] = row.n
      bytesByCategory[row.category] = row.bytes
    }
  }

  return {
    total: total.n,
    // bytes 保持为「正常文件」用量，方便按分类展示；
    // totalBytes 才是包含回收站的真实占用，与配额计算保持一致。
    bytes: total.bytes,
    totalBytes: total.bytes + trashed.bytes,
    byCategory,
    bytesByCategory,
    trash: { total: trashed.n, bytes: trashed.bytes },
  }
}

/**
 * 总占用量 —— 注意这里**包含回收站里的文件**。
 * 回收站里的文件在磁盘上还没删，空间确实被占着，
 * 配额判断必须算上它们，否则用户可以通过「先删再传」无限占用磁盘。
 */
export function totalBytesFor(ownerId) {
  return prep(
    'SELECT COALESCE(SUM(size), 0) AS bytes FROM files WHERE owner_id = ?',
  ).get(ownerId).bytes
}

/** 改名 / 改分类。只对正常文件生效，回收站里的不允许改。 */
export function updateFile(id, ownerId, patch) {
  const existing = prep(
    'SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
  ).get(id, ownerId)
  if (!existing) return null

  const name = patch.name != null ? patch.name : existing.name
  const category = patch.category != null ? patch.category : existing.category
  const updatedAt = patch.updatedAt || new Date().toISOString()

  prep(`
    UPDATE files SET name = ?, category = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).run(name, category, updatedAt, id, ownerId)

  return mapFile(prep('SELECT * FROM files WHERE id = ?').get(id))
}

/* ══════════════════════════════════════════════════════════════════════════
   回收站
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 软删除：只打一个 deleted_at 时间戳，行和磁盘文件都保留。
 *
 * 为什么不直接 DELETE？
 *   因为要能恢复。行留着、文件留着，24 小时内随时可以捞回来；
 *   超过 24 小时由定时任务真正清除（purgeFile + 删磁盘文件）。
 *
 * 已经删过的不能再删（条件里带 deleted_at IS NULL），
 * 避免覆盖原来的删除时间、重置 24 小时倒计时。
 */
export function softDeleteFile(id, ownerId, deletedAt = new Date().toISOString()) {
  const existing = prep(
    'SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
  ).get(id, ownerId)
  if (!existing) return null

  prep('UPDATE files SET deleted_at = ? WHERE id = ? AND owner_id = ?')
    .run(deletedAt, id, ownerId)

  return mapFile(prep('SELECT * FROM files WHERE id = ?').get(id))
}

/** 从回收站恢复：把 deleted_at 清回 NULL。 */
export function restoreFile(id, ownerId) {
  const existing = prep(
    'SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL',
  ).get(id, ownerId)
  if (!existing) return null

  prep('UPDATE files SET deleted_at = NULL WHERE id = ? AND owner_id = ?').run(id, ownerId)
  return mapFile(prep('SELECT * FROM files WHERE id = ?').get(id))
}

/**
 * 彻底删除数据库记录。
 * 磁盘文件由调用方先删 —— 这里只管数据库，职责分开更清楚。
 * 只能删回收站里的记录，防止误调用把正常文件删掉。
 */
export function purgeFile(id, ownerId) {
  const existing = prep(
    'SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NOT NULL',
  ).get(id, ownerId)
  if (!existing) return null

  prep('DELETE FROM files WHERE id = ? AND owner_id = ?').run(id, ownerId)
  return mapFile(existing)
}

/**
 * 找出所有「已过期」的回收站记录 —— 跨用户，供定时清理任务使用。
 * 返回值带着 ownerId 和 storedName，调用方据此删磁盘文件。
 */
export function listExpiredFiles(cutoffIso, limit = 500) {
  return prep(`
    SELECT * FROM files WHERE deleted_at IS NOT NULL AND deleted_at <= ?
    ORDER BY deleted_at ASC LIMIT ?
  `).all(cutoffIso, limit).map(mapFile)
}

/** 清空某人的回收站：先取出全部记录，再一次性删掉。 */
export function emptyTrashFor(ownerId) {
  const rows = prep(
    'SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NOT NULL',
  ).all(ownerId).map(mapFile)

  if (rows.length) {
    prep('DELETE FROM files WHERE owner_id = ? AND deleted_at IS NOT NULL').run(ownerId)
  }
  return rows
}

/** 全库统计（启动日志和诊断用）。 */
export function databaseStats() {
  const row = prep('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files').get()
  return { files: row.n, bytes: row.bytes, users: countUsers() }
}
