export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

/**
 * 创建进程关闭处理器。
 *
 * 先停止后台任务并停止接收新连接；空闲连接立即关闭，在途请求正常完成后
 * 才关闭数据库。超过 timeoutMs 后强制关闭所有连接，避免部署永久卡住。
 *
 * @param {{
 *   server: import('node:http').Server,
 *   closeDb: () => void,
 *   beforeClose?: () => void,
 *   timeoutMs?: number,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   exit?: (code: number) => void,
 * }} options
 * @returns {(signal: string) => boolean}
 */
export function createShutdownHandler({
  server,
  closeDb,
  beforeClose = () => {},
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  logger = console,
  exit = (code) => process.exit(code),
}) {
  let shuttingDown = false

  return function shutdown(signal) {
    if (shuttingDown) {
      logger.warn(`[shutdown] 已收到关闭信号，忽略重复的 ${signal}`)
      return false
    }
    shuttingDown = true
    logger.log(`\n收到 ${signal}，正在关闭…`)

    let finished = false
    let timeoutTimer = null

    const finish = (error = null) => {
      if (finished) return
      finished = true
      clearTimeout(timeoutTimer)
      timeoutTimer = null

      let exitCode = error ? 1 : 0
      try {
        closeDb()
      } catch (dbError) {
        exitCode = 1
        logger.error('[shutdown] 关闭数据库失败:', dbError)
      }

      if (error) logger.error('[shutdown] 关闭过程中发生错误:', error)
      exit(exitCode)
    }

    try {
      beforeClose()
    } catch (error) {
      logger.error('[shutdown] 停止后台任务失败:', error)
    }

    timeoutTimer = setTimeout(() => {
      logger.warn(`[shutdown] 超过 ${timeoutMs}ms 仍有连接未结束，强制关闭连接`)
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      } catch (error) {
        logger.error('[shutdown] 强制关闭连接失败:', error)
      }
      finish(Object.assign(new Error('关闭超时'), { code: 'SHUTDOWN_TIMEOUT' }))
    }, timeoutMs)

    try {
      server.close((error) => finish(error || null))
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    } catch (error) {
      finish(error)
    }

    return true
  }
}