/** 创建回收站和过期上传会话的后台清理器。 */
export function createTrashSweeper({
  listExpiredFiles,
  removeStoredFile,
  purgeFile,
  cleanupExpiredUploadSessions,
  trashTtlMs,
  intervalMs,
  logger = console,
}) {
  const sweep = () => {
    try {
      const cutoff = new Date(Date.now() - trashTtlMs).toISOString()
      const expired = listExpiredFiles(cutoff)
      let purged = 0
      for (const record of expired) {
        if (!removeStoredFile(record)) continue
        if (purgeFile(record.id, record.ownerId)) purged += 1
      }
      if (purged) logger.log(`[trash] 已清理 ${purged} 个超过 24 小时的文件`)
      const expiredUploads = cleanupExpiredUploadSessions()
      if (expiredUploads) logger.log(`[upload] 已清理 ${expiredUploads} 个过期上传会话`)
    } catch (error) {
      logger.error('[trash] 清理失败:', error && error.message)
    }
  }

  return function startTrashSweeper() {
    sweep()
    const timer = setInterval(sweep, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
  }
}