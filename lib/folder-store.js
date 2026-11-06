/**
 * 文件夹数据访问层。
 *
 * 负责普通空间文件夹树、文件归属、面包屑和递归回收站操作。所有用户可访问的
 * 查询都按 ownerId 隔离；后台到期扫描会全局查找候选树。数据库只保存 parentId，
 * 层级关系由递归 CTE 按需展开。软删除整棵树时
 * 子项沿用根目录的 deletedAt，恢复和超时清理才能把同一批删除内容视为一个整体。
 */
import { db, mapFile, mapFolder } from './db.js'

/** 延迟获取数据库连接，确保未显式初始化时给出明确错误。 */
function prep(sql) {
  if (!db) throw new Error('数据库尚未初始化')
  return db.prepare(sql)
}

/** 转义 LIKE 通配符，确保用户搜索的 % 和 _ 按普通字符匹配。 */
function escapeLike(text) {
  return String(text || '').replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 返回根目录及全部后代的 ID；每一层都校验 ownerId，避免跨账号展开。 */
function folderTreeIds(ownerId, rootId) {
  return prep(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM folders WHERE id = ? AND owner_id = ?
      UNION ALL
      SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
      WHERE f.owner_id = ?
    )
    SELECT id FROM subtree
  `).all(rootId, ownerId, ownerId).map((row) => row.id)
}

/** 新建文件夹；父目录和同名冲突由调用方在写入前检查。 */
export function createFolder(record) {
  prep(`
    INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(record.id, record.ownerId, record.parentId || null, record.name, record.createdAt, record.updatedAt)
  return mapFolder(prep('SELECT * FROM folders WHERE id = ?').get(record.id))
}

/** 按所有者查找文件夹；deleted 控制查找正常目录还是回收站目录。 */
export function findFolderForOwner(id, ownerId, { deleted = false } = {}) {
  const condition = deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'
  return mapFolder(prep(`SELECT * FROM folders WHERE id = ? AND owner_id = ? AND ${condition}`).get(id, ownerId))
}

/** 重命名正常文件夹；回收站中的目录不参与普通重命名。 */
export function renameFolder(id, ownerId, name) {
  const updatedAt = new Date().toISOString()
  const result = prep('UPDATE folders SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
    .run(name, updatedAt, id, ownerId)
  return result.changes > 0 ? findFolderForOwner(id, ownerId) : null
}

/** 在同一父目录下查同名文件夹。parentId 为 null 时匹配根目录。 */
export function findFolderByName(ownerId, parentId, name) {
  return mapFolder(prep(`
    SELECT * FROM folders
    WHERE owner_id = ? AND parent_id IS ? AND deleted_at IS NULL AND name = ?
    LIMIT 1
  `).get(ownerId, parentId || null, name))
}

/** 文件夹列表允许的 ORDER BY 片段；未知排序值统一回退到名称升序。 */
const FOLDER_SORTS = {
  name: 'name COLLATE NOCASE ASC',
  'name-desc': 'name COLLATE NOCASE DESC',
  updated: 'updated_at DESC, name COLLATE NOCASE ASC',
  'updated-asc': 'updated_at ASC, name COLLATE NOCASE ASC',
}

/**
 * 列出指定目录的直接子文件夹。
 *
 * 文件夹没有可展示的大小区分，因此大小 / 类型排序时保持名称升序；名称和修改日期
 * 表头排序会实际改变文件夹顺序。返回顺序只使用上面的白名单 SQL 片段。
 */
export function listFolders({ ownerId, parentId = null, query = '', sort = 'name' } = {}) {
  const params = [ownerId, parentId || null]
  let sql = `SELECT * FROM folders WHERE owner_id = ? AND parent_id IS ? AND deleted_at IS NULL`
  if (query) {
    sql += " AND name LIKE ? ESCAPE '\\'"
    params.push(`%${escapeLike(query)}%`)
  }
  sql += ` ORDER BY ${FOLDER_SORTS[sort] || FOLDER_SORTS.name}`
  return prep(sql).all(...params).map(mapFolder)
}

/**
 * 移动文件夹到新的父目录，parentId 为 null 表示根目录。
 *
 * 必须同时拒绝自身、后代和同名目录：前两者会形成环，同名目录会让前端路径
 * 变得不可区分。返回值是更新后的文件夹；不存在时返回 null，约束冲突时抛出
 * 带 HTTP status / code 的错误，由 API 层统一转换。
 */
export function moveFolder(id, ownerId, parentId) {
  const folder = findFolderForOwner(id, ownerId)
  if (!folder) return null
  if (parentId && !findFolderForOwner(parentId, ownerId)) {
    throw Object.assign(new Error('目标文件夹不存在'), { status: 404, code: 'FOLDER_NOT_FOUND' })
  }
  if (parentId === id || (parentId && folderTreeIds(ownerId, id).includes(parentId))) {
    throw Object.assign(new Error('不能把文件夹移动到自身或其子目录'), { status: 400, code: 'FOLDER_CYCLE' })
  }
  const duplicate = findFolderByName(ownerId, parentId, folder.name)
  if (duplicate && duplicate.id !== id) {
    throw Object.assign(new Error('目标目录已存在同名文件夹'), { status: 409, code: 'FOLDER_EXISTS' })
  }
  prep('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
    .run(parentId || null, new Date().toISOString(), id, ownerId)
  return findFolderForOwner(id, ownerId)
}

/** 返回用户全部正常文件夹，供“移动到文件夹”下拉框构建完整路径。 */
export function listAllFolders(ownerId) {
  return prep(`
    SELECT * FROM folders
    WHERE owner_id = ? AND deleted_at IS NULL
    ORDER BY name COLLATE NOCASE ASC
  `).all(ownerId).map(mapFolder)
}

/**
 * 从当前目录向上构建根到当前的面包屑。
 *
 * seen 和 128 层上限用于防止历史脏数据形成环时阻塞请求；正常目录深度远低于上限。
 */
export function folderBreadcrumbs(id, ownerId) {
  const crumbs = []
  const seen = new Set()
  let currentId = id
  while (currentId && !seen.has(currentId) && crumbs.length < 128) {
    seen.add(currentId)
    const folder = findFolderForOwner(currentId, ownerId)
    if (!folder) break
    crumbs.unshift(folder)
    currentId = folder.parentId
  }
  return crumbs
}

/**
 * 把普通文件移动到 folderId，null 表示根目录。
 *
 * 调用方必须先校验目标文件夹属于同一用户；本函数只负责更新文件归属。
 * 隐私文件和非正常状态文件不会被移动。
 */
export function moveFileToFolder(id, ownerId, folderId) {
  const existing = prep('SELECT * FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND is_private = 0').get(id, ownerId)
  if (!existing) return null
  prep('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
    .run(folderId || null, new Date().toISOString(), id, ownerId)
  return mapFile(prep('SELECT * FROM files WHERE id = ?').get(id))
}

/** 读取一个正常文件夹子树，供 ZIP 下载同时获取目录层级和文件记录。 */
export function getFolderTree(ownerId, rootId) {
  const root = findFolderForOwner(rootId, ownerId)
  if (!root) return null
  const ids = folderTreeIds(ownerId, rootId)
  if (!ids.length) return null
  const placeholders = ids.map(() => '?').join(',')
  const folders = prep(`SELECT * FROM folders WHERE owner_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`)
    .all(ownerId, ...ids).map(mapFolder)
  const files = prep(`SELECT * FROM files WHERE owner_id = ? AND folder_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`)
    .all(ownerId, ...ids).map(mapFile)
  return { root, folders, files }
}
/**
 * 递归把文件夹树移入回收站。
 *
 * 目录与文件在同一事务中写入相同的 deletedAt；文件使用 COALESCE，避免覆盖此前
 * 单独删除时更早的倒计时。返回根目录记录，失败时回滚。
 */
export function softDeleteFolderTree(id, ownerId, deletedAt = new Date().toISOString()) {
  const root = findFolderForOwner(id, ownerId)
  if (!root) return null
  const ids = folderTreeIds(ownerId, id)
  if (!ids.length) return null
  const placeholders = ids.map(() => '?').join(',')
  db.exec('BEGIN')
  try {
    prep(`UPDATE folders SET deleted_at = ? WHERE owner_id = ? AND id IN (${placeholders})`)
      .run(deletedAt, ownerId, ...ids)
    prep(`UPDATE files SET deleted_at = COALESCE(deleted_at, ?) WHERE owner_id = ? AND folder_id IN (${placeholders})`)
      .run(deletedAt, ownerId, ...ids)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return mapFolder(prep('SELECT * FROM folders WHERE id = ?').get(id))
}

/**
 * 恢复一棵回收站目录树。
 *
 * 只清除 deletedAt 与根目录相同的子项，避免把后来单独删除的文件误恢复；
 * 目录和文件更新在同一事务内完成。
 */
export function restoreFolderTree(id, ownerId) {
  const root = findFolderForOwner(id, ownerId, { deleted: true })
  if (!root) return null
  const ids = folderTreeIds(ownerId, id)
  if (!ids.length) return null
  const placeholders = ids.map(() => '?').join(',')
  db.exec('BEGIN')
  try {
    prep(`UPDATE folders SET deleted_at = NULL WHERE owner_id = ? AND id IN (${placeholders}) AND deleted_at = ?`)
      .run(ownerId, ...ids, root.deletedAt)
    prep(`UPDATE files SET deleted_at = NULL WHERE owner_id = ? AND folder_id IN (${placeholders}) AND deleted_at = ?`)
      .run(ownerId, ...ids, root.deletedAt)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return findFolderForOwner(id, ownerId)
}

/** 回收站只返回被删除树的根目录，避免同一棵树的子目录重复显示。 */
export function listTrashFolders(ownerId) {
  return prep(`
    SELECT f.* FROM folders f
    WHERE f.owner_id = ? AND f.deleted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM folders p
        WHERE p.id = f.parent_id AND p.owner_id = f.owner_id AND p.deleted_at IS NOT NULL
      )
    ORDER BY f.deleted_at DESC, f.name COLLATE NOCASE
  `).all(ownerId).map(mapFolder)
}

const TRASH_TYPE_ORDER = "CASE files.category WHEN 'image' THEN 1 WHEN 'video' THEN 2 WHEN 'music' THEN 3 WHEN 'file' THEN 4 ELSE 5 END"
const TRASH_SORTS = {
  newest: 'files.deleted_at DESC',
  oldest: 'files.deleted_at ASC',
  name: 'files.name COLLATE NOCASE ASC',
  'name-desc': 'files.name COLLATE NOCASE DESC',
  largest: 'files.size DESC, files.name COLLATE NOCASE ASC',
  smallest: 'files.size ASC, files.name COLLATE NOCASE ASC',
  type: `${TRASH_TYPE_ORDER} ASC, files.name COLLATE NOCASE ASC`,
  'type-desc': `${TRASH_TYPE_ORDER} DESC, files.name COLLATE NOCASE ASC`,
  updated: 'files.updated_at DESC, files.name COLLATE NOCASE ASC',
  'updated-asc': 'files.updated_at ASC, files.name COLLATE NOCASE ASC',
  deleted: 'files.deleted_at DESC',
}

/** 列出独立删除的文件；仍属于已删除文件夹的文件由文件夹入口统一表示。 */
export function listTrashFiles(ownerId, { query = '', limit = 60, offset = 0, sort = 'deleted' } = {}) {
  const params = [ownerId]
  let sql = `
    SELECT files.* FROM files
    LEFT JOIN folders ON folders.id = files.folder_id AND folders.owner_id = files.owner_id
    WHERE files.owner_id = ? AND files.deleted_at IS NOT NULL AND files.is_private = 0
      AND (files.folder_id IS NULL OR folders.deleted_at IS NULL)
  `
  if (query) {
    sql += " AND files.name LIKE ? ESCAPE '\\'"
    params.push(`%${escapeLike(query)}%`)
  }
  sql += ` ORDER BY ${TRASH_SORTS[sort] || TRASH_SORTS.deleted} LIMIT ? OFFSET ?`
  return prep(sql).all(...params, limit, offset).map(mapFile)
}

/** 统计独立回收站文件数量，筛选条件必须与 listTrashFiles 保持一致。 */
export function countTrashFiles(ownerId, query = '') {
  const params = [ownerId]
  let sql = `
    SELECT COUNT(*) AS n FROM files
    LEFT JOIN folders ON folders.id = files.folder_id AND folders.owner_id = files.owner_id
    WHERE files.owner_id = ? AND files.deleted_at IS NOT NULL AND files.is_private = 0
      AND (files.folder_id IS NULL OR folders.deleted_at IS NULL)
  `
  if (query) {
    sql += " AND files.name LIKE ? ESCAPE '\\'"
    params.push(`%${escapeLike(query)}%`)
  }
  return prep(sql).get(...params).n
}

/**
 * 查找已经到期的回收站树根。
 *
 * 只返回根目录，后台清理会再递归取得整棵树；limit 防止单轮清扫无限占用事件循环。
 */
export function listExpiredFolderRoots(cutoffIso, limit = 500) {
  return prep(`
    SELECT f.* FROM folders f
    WHERE f.deleted_at IS NOT NULL AND f.deleted_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM folders p
        WHERE p.id = f.parent_id AND p.deleted_at IS NOT NULL AND p.deleted_at <= ?
      )
    ORDER BY f.deleted_at ASC LIMIT ?
  `).all(cutoffIso, cutoffIso, limit).map(mapFolder)
}

/** 返回一棵文件夹树中的全部文件（包括已软删除记录），供磁盘清理使用。 */
export function folderTreeFiles(id, ownerId) {
  const ids = folderTreeIds(ownerId, id)
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return prep(`SELECT * FROM files WHERE owner_id = ? AND folder_id IN (${placeholders})`)
    .all(ownerId, ...ids).map(mapFile)
}

/**
 * 彻底删除文件夹树及其文件记录。
 *
 * 本函数只处理数据库；调用方必须先删除磁盘文件，再调用这里，避免数据库记录先
 * 消失后无法定位孤儿文件。目录和文件删除在同一事务内完成。
 */
export function purgeFolderTree(id, ownerId) {
  const root = findFolderForOwner(id, ownerId, { deleted: true })
  if (!root) return false
  const ids = folderTreeIds(ownerId, id)
  if (!ids.length) return false
  const placeholders = ids.map(() => '?').join(',')
  db.exec('BEGIN')
  try {
    prep(`DELETE FROM files WHERE owner_id = ? AND folder_id IN (${placeholders})`).run(ownerId, ...ids)
    prep(`DELETE FROM folders WHERE owner_id = ? AND id IN (${placeholders})`).run(ownerId, ...ids)
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}