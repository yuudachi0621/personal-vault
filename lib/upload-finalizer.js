import crypto from 'node:crypto'
import { findDuplicateUpload, safeExt } from './api/core.js'
import { totalBytesFor } from './store.js'
import { MAX_USER_BYTES } from './config.js'

/** 统一执行上传去重、配额检查和文件记录构造。 */
export async function prepareUploadRecord({
  user,
  id = crypto.randomUUID(),
  storedName,
  name,
  category,
  mime,
  size,
  contentHash,
  isPrivate,
}) {
  const duplicate = await findDuplicateUpload(user.id, size, contentHash)
  if (duplicate) {
    throw Object.assign(new Error('账号中已存在相同文件，无法重复上传'), {
      status: 409,
      code: 'DUPLICATE_FILE',
      duplicate,
    })
  }

  const used = totalBytesFor(user.id)
  if (MAX_USER_BYTES > 0 && used + size > MAX_USER_BYTES) {
    throw Object.assign(new Error('存储空间不足，请先删除一些文件后继续'), {
      status: 413,
      code: 'QUOTA_EXCEEDED',
    })
  }

  const now = new Date().toISOString()
  return {
    id,
    storedName: storedName || `${id}${safeExt(name, mime)}`,
    record: {
      id,
      ownerId: user.id,
      name,
      category,
      mime,
      contentHash,
      size,
      storedName: storedName || `${id}${safeExt(name, mime)}`,
      createdAt: now,
      updatedAt: now,
      isPrivate,
      privateAt: isPrivate ? now : null,
    },
  }
}