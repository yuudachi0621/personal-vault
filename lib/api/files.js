/**
 * 文件接口：列表、文件名 / 分类 / 文件夹更新、软删除、恢复和彻底删除。
 * 文件列表响应同时包含当前目录的文件夹和面包屑；全局分类视图会忽略 folderId。
 */
import { readJsonBody } from '../request-body.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { parsePagination, buildPageInfo } from '../pagination.js'
import {
  listFiles, countFiles, usageFor, updateFile, softDeleteFile, restoreFile,
  purgeFile, listTrashFor, findFileForOwner, findActiveFileForOwner,
} from '../store.js'
import {
  listFolders, folderBreadcrumbs, findFolderForOwner, moveFileToFolder,
  listTrashFolders, listTrashFiles, countTrashFiles, purgeFolderTree,
} from '../folder-store.js'
import { CATEGORIES, PAGE_SIZE, MAX_PAGE_SIZE, TRASH_TTL_MS, publicFile, removeStoredFile, sanitizeName } from './core.js'
import { publicFolder } from './folders.js'
/**
 * 列表：分页 + 分类筛选 + 名称搜索 + 排序，并顺带返回当前目录文件夹、
 * 面包屑和用量统计。
 *
 * 【为什么要分页】
 *   之前是一次性返回全部记录。文件攒到几千个以后，
 *   一次响应要传几百 KB，前端还要一次性建出几千个 DOM 节点，
 *   浏览器先卡住，随后大量缩略图请求同时涌向服务器。
 *   分页之后，单次响应大小和渲染成本只与页大小有关，
 *   不会随着文件总数线性增长；总条数仍通过 COUNT 查询获得。
 */
export function handleList(req, res, url, user) {
  const categoryParam = url.searchParams.get('category')
  const category = CATEGORIES.includes(categoryParam) ? categoryParam : null
  const query = String(url.searchParams.get('q') || '').trim()
  const sort = url.searchParams.get('sort') || 'newest'
  const folderId = String(url.searchParams.get('folderId') || '').trim() || null
  const currentFolder = folderId ? findFolderForOwner(folderId, user.id) : null
  if (folderId && !currentFolder) return fail(res, 404, '文件夹不存在', 'FOLDER_NOT_FOUND')

  // 把前端传来的分页参数限制在合理范围内，防止有人传 limit=999999 拖垮服务
  const { limit, offset } = parsePagination(url.searchParams, { defaultLimit: PAGE_SIZE, maxLimit: MAX_PAGE_SIZE })

  // 分类视图是全局视图，必须包含所有文件夹中的文件。
  const filter = { ownerId: user.id, category, query, folderId: category ? undefined : folderId }

  // 数据库只返回这一页的数据
  const rows = listFiles({ ...filter, sort, limit, offset })
  const total = countFiles(filter)
  const folders = category ? [] : listFolders({ ownerId: user.id, parentId: currentFolder ? currentFolder.id : null, query, sort })

  json(res, 200, {
    files: rows.map(publicFile),
    folders: folders.map(publicFolder),
    folder: publicFolder(currentFolder),
    breadcrumbs: currentFolder ? folderBreadcrumbs(currentFolder.id, user.id).map(publicFolder) : [],
    usage: usageFor(user.id),
    page: buildPageInfo({ limit, offset, total, returned: rows.length }),
  })
}

/** 更新普通文件：可改名、改分类，或通过 folderId 移动到文件夹 / 根目录。 */
export async function handlePatch(req, res, id, user) {
  // ★ 只在未删除且非隐私的文件里找；回收站和隐私空间都不允许走普通改名接口
  const existing = findActiveFileForOwner(id, user.id)
  if (!existing) return fail(res, 404, '文件不存在', 'NOT_FOUND')

  const body = await readJsonBody(req)
  const patch = { updatedAt: new Date().toISOString() }

  // 只接受合法的字段，其它一律忽略（防止前端塞进来 ownerId 之类的字段搞破坏）
  if (typeof body.name === 'string' && body.name.trim()) patch.name = sanitizeName(body.name)
  if (CATEGORIES.includes(body.category)) patch.category = body.category
  let targetFolderId
  if (Object.prototype.hasOwnProperty.call(body, 'folderId')) {
    targetFolderId = String(body.folderId || '').trim() || null
    if (targetFolderId && !findFolderForOwner(targetFolderId, user.id)) {
      return fail(res, 404, '目标文件夹不存在', 'FOLDER_NOT_FOUND')
    }
  }

  let updated = updateFile(id, user.id, patch)
  if (updated && targetFolderId !== undefined) updated = moveFileToFolder(id, user.id, targetFolderId)
  if (!updated) return fail(res, 404, '文件不存在', 'NOT_FOUND')
  json(res, 200, { file: publicFile(updated) })
}

/* ──────────────────────────── 回收站 ──────────────────────────── */

/**
 * 删除 → 移入回收站，不真删。
 *
 * 只给记录打一个 deleted_at 时间戳：
 *   - 数据库行还在
 *   - 磁盘文件还在
 *   - 但列表查询会把它过滤掉（deleted_at IS NULL）
 * 24 小时内可以恢复，超时由定时任务真正清除。
 */
export function handleDelete(res, id, user) {
  const record = softDeleteFile(id, user.id)
  if (!record) return fail(res, 404, '文件不存在', 'NOT_FOUND')

  json(res, 200, {
    ok: true,
    file: publicFile(record),
    trashTtlMs: TRASH_TTL_MS,
  })
}

/** 由删除时间推算自动清除时间，前端拿来显示倒计时。 */
export function trashExpiresAt(deletedAt) {
  const ts = Date.parse(deletedAt)
  if (Number.isNaN(ts)) return null
  return new Date(ts + TRASH_TTL_MS).toISOString()
}

/** 回收站列表。分页逻辑和普通列表一致，只是数据源换成已删除的记录。 */
export function handleTrashList(req, res, url, user) {
  const { limit, offset } = parsePagination(url.searchParams, { defaultLimit: PAGE_SIZE, maxLimit: MAX_PAGE_SIZE })

  const query = String(url.searchParams.get('q') || '').trim()
  const sort = url.searchParams.get('sort') || 'deleted'
  const rows = listTrashFiles(user.id, { query, limit, offset, sort })
  const total = countTrashFiles(user.id, query)
  const folders = listTrashFolders(user.id)

  json(res, 200, {
    files: rows.map((record) => ({
      ...publicFile(record),
      expiresAt: trashExpiresAt(record.deletedAt),
    })),
    folders: folders.map((folder) => ({
      ...publicFolder(folder),
      expiresAt: trashExpiresAt(folder.deletedAt),
    })),
    usage: usageFor(user.id),
    page: buildPageInfo({ limit, offset, total, returned: rows.length }),
    ttlMs: TRASH_TTL_MS,
  })
}

/** 从回收站恢复。 */
export function handleRestore(res, id, user) {
  const record = restoreFile(id, user.id)
  if (!record) return fail(res, 404, '回收站里没有这个文件', 'NOT_FOUND')
  json(res, 200, { ok: true, file: publicFile(record) })
}

/**
 * 彻底删除单个文件：先删磁盘，再删记录。
 *
 * 为什么先删磁盘？如果先删记录后删磁盘时失败，磁盘上就留下一个
 * 谁也访问不到的孤儿文件，永远占着空间。反过来先删磁盘，
 * 即便记录删除失败，下次定时清理还会再试一次。
 */
export function handlePurge(res, id, user) {
  const record = findFileForOwner(id, user.id)
  if (!record || !record.deletedAt) {
    return fail(res, 404, '回收站里没有这个文件', 'NOT_FOUND')
  }

  if (!removeStoredFile(record)) return fail(res, 500, '文件删除失败，请稍后重试', 'FILE_DELETE_FAILED')
  if (!purgeFile(id, user.id)) return fail(res, 404, '回收站里没有这个文件', 'NOT_FOUND')
  json(res, 200, { ok: true })
}

/** 清空回收站：逐文件清理，失败项保留数据库记录以便重试。 */
export function handleEmptyTrash(res, user) {
  const rows = listTrashFor(user.id)
  let removed = 0
  let failed = 0
  for (const record of rows) {
    if (!removeStoredFile(record)) {
      failed += 1
      continue
    }
    if (purgeFile(record.id, user.id)) removed += 1
  }
  for (const folder of listTrashFolders(user.id)) {
    if (purgeFolderTree(folder.id, user.id)) removed += 1
    else failed += 1
  }
  json(res, 200, { ok: failed === 0, removed, failed })
}

