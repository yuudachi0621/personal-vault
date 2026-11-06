/**
 * 普通空间文件夹接口。
 *
 * 覆盖列表、创建、重命名 / 移动、递归删除与恢复、彻底删除和 ZIP 下载。
 * 路径中的文件夹 ID 始终结合当前 user.id 查询，其他账号的目录按不存在处理。
 */
import crypto from 'node:crypto'
import { readJsonBody } from '../request-body.js'
import { sendJson as json, sendError as fail } from '../http-response.js'
import { sanitizeName, removeStoredFile, TRASH_TTL_MS } from './core.js'
import {
  createFolder, findFolderForOwner, findFolderByName, renameFolder, moveFolder, listAllFolders, softDeleteFolderTree,
  restoreFolderTree, getFolderTree, folderTreeFiles, purgeFolderTree, folderBreadcrumbs,
} from '../folder-store.js'
import { streamFolderZip } from '../zip-stream.js'

/** 只向客户端暴露文件夹的必要字段，避免把数据库内部结构直接传出。 */
export function publicFolder(folder) {
  if (!folder) return null
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId || null,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    deletedAt: folder.deletedAt || null,
  }
}

function folderIdFromBody(value) {
  const id = String(value || '').trim()
  return id || null
}

/** 返回当前用户的全部正常文件夹，用于移动弹窗构建完整目录树。 */
export function handleFolderList(req, res, user) {
  json(res, 200, { folders: listAllFolders(user.id).map(publicFolder) })
}

/** 在 parentId 下创建文件夹；名称经过清洗，并在同一父目录内检查重名。 */
export async function handleFolderCreate(req, res, user) {
  const body = await readJsonBody(req)
  const name = sanitizeName(body.name)
  if (!String(body.name || '').trim()) return fail(res, 400, '文件夹名称不能为空', 'INVALID_FOLDER_NAME')
  const parentId = folderIdFromBody(body.parentId)
  if (parentId && !findFolderForOwner(parentId, user.id)) {
    return fail(res, 404, '上级文件夹不存在', 'FOLDER_NOT_FOUND')
  }
  if (findFolderByName(user.id, parentId, name)) {
    return fail(res, 409, '当前目录已存在同名文件夹', 'FOLDER_EXISTS')
  }
  const now = new Date().toISOString()
  const folder = createFolder({
    id: crypto.randomUUID(),
    ownerId: user.id,
    parentId,
    name,
    createdAt: now,
    updatedAt: now,
  })
  json(res, 201, { folder: publicFolder(folder) })
}

/**
 * 更新文件夹。
 *
 * name 用于重命名，parentId 用于移动；两者可同时提交。移动校验集中在
 * folder-store.moveFolder()，包括目标存在性、循环目录和同名冲突。
 */
export async function handleFolderPatch(req, res, id, user) {
  let folder = findFolderForOwner(id, user.id)
  if (!folder) return fail(res, 404, '文件夹不存在', 'FOLDER_NOT_FOUND')
  const body = await readJsonBody(req)
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    if (!String(body.name || '').trim()) return fail(res, 400, '文件夹名称不能为空', 'INVALID_FOLDER_NAME')
    const name = sanitizeName(body.name)
    const duplicate = findFolderByName(user.id, folder.parentId, name)
    if (duplicate && duplicate.id !== id) return fail(res, 409, '当前目录已存在同名文件夹', 'FOLDER_EXISTS')
    folder = renameFolder(id, user.id, name)
  }
  if (Object.prototype.hasOwnProperty.call(body, 'parentId')) {
    folder = moveFolder(id, user.id, String(body.parentId || '').trim() || null)
  }
  if (!folder) return fail(res, 400, '没有可更新的文件夹字段', 'NO_UPDATE')
  json(res, 200, { folder: publicFolder(folder) })
}

/** 把文件夹及全部后代软删除到回收站，并返回统一的保留时长。 */
export function handleFolderDelete(res, id, user) {
  const folder = softDeleteFolderTree(id, user.id)
  if (!folder) return fail(res, 404, '文件夹不存在', 'FOLDER_NOT_FOUND')
  json(res, 200, {
    ok: true,
    folder: publicFolder(folder),
    trashTtlMs: TRASH_TTL_MS,
  })
}

/** 按删除批次恢复整棵文件夹树。 */
export function handleFolderRestore(res, id, user) {
  const folder = restoreFolderTree(id, user.id)
  if (!folder) return fail(res, 404, '回收站里没有这个文件夹', 'FOLDER_NOT_FOUND')
  json(res, 200, { ok: true, folder: publicFolder(folder) })
}

/**
 * 彻底删除回收站文件夹。
 *
 * 先逐个删除磁盘文件，全部成功后才删除数据库记录；任一步失败都保留元数据，
 * 让用户或后台清扫任务可以再次定位并重试。
 */
export function handleFolderPurge(res, id, user) {
  const folder = findFolderForOwner(id, user.id, { deleted: true })
  if (!folder) return fail(res, 404, '回收站里没有这个文件夹', 'FOLDER_NOT_FOUND')
  const files = folderTreeFiles(id, user.id)
  for (const record of files) {
    if (!removeStoredFile(record)) {
      return fail(res, 500, '文件夹内部分文件删除失败，请稍后重试', 'FILE_DELETE_FAILED')
    }
  }
  if (!purgeFolderTree(id, user.id)) return fail(res, 404, '回收站里没有这个文件夹', 'FOLDER_NOT_FOUND')
  json(res, 200, { ok: true })
}

/**
 * 流式下载文件夹 ZIP。
 *
 * 响应头发出后无法再改写成标准 JSON 错误，因此流中途失败时直接销毁连接；
 * 尚未发送响应头时则抛给上层统一返回错误。
 */
export async function handleFolderDownload(req, res, id, user) {
  const tree = getFolderTree(user.id, id)
  if (!tree) return fail(res, 404, '文件夹不存在', 'FOLDER_NOT_FOUND')
  try {
    await streamFolderZip(res, tree)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    throw error
  }
}

/** 组合文件夹与面包屑响应，供需要同时返回两者的处理器复用。 */
export function folderPayload(folder, user) {
  if (!folder) return null
  return {
    folder: publicFolder(folder),
    breadcrumbs: folderBreadcrumbs(folder.id, user.id).map(publicFolder),
  }
}