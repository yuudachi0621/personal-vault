export const JSON_BODY_LIMIT_BYTES = 256 * 1024
export const JSON_BODY_IDLE_TIMEOUT_MS = 30_000
export const JSON_BODY_TOTAL_TIMEOUT_MS = 60_000

function bodyError(message, status, code, closeConnection = false) {
  return Object.assign(new Error(message), { status, code, closeConnection })
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读取普通 JSON API 请求体。
 *
 * 与上传流不同，JSON 请求体应当很小，因此同时限制总字节数、空闲时长和总时长。
 * 超限或超时后不再继续缓存数据，并通过 resume() 丢弃剩余请求体，让调用方
 * 仍有机会返回明确的 413/408 JSON 错误。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?: number, idleTimeoutMs?: number, totalTimeoutMs?: number}} options
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, {
  limit = JSON_BODY_LIMIT_BYTES,
  idleTimeoutMs = JSON_BODY_IDLE_TIMEOUT_MS,
  totalTimeoutMs = JSON_BODY_TOTAL_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let idleTimer = null
    let totalTimer = null

    const clearTimers = () => {
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      idleTimer = null
      totalTimer = null
    }

    const removeListeners = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }

    const finishResolve = (value) => {
      if (settled) return
      settled = true
      clearTimers()
      removeListeners()
      chunks.length = 0
      resolve(value)
    }

    const finishReject = (error, { drain = false } = {}) => {
      if (settled) return
      settled = true
      clearTimers()
      removeListeners()
      chunks.length = 0

      if (drain && typeof req.resume === 'function') {
        // 保留一个 error 监听器，避免排空过程中客户端断连产生未处理 error 事件。
        req.on('error', () => {})
        req.resume()
      }
      reject(error)
    }

    const armIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = null
      if (idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => {
          finishReject(
            bodyError('请求体读取超时', 408, 'REQUEST_TIMEOUT', true),
            { drain: true },
          )
        }, idleTimeoutMs)
      }
    }

    function onData(chunk) {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finishReject(
          bodyError('请求体过大', 413, 'BODY_TOO_LARGE', true),
          { drain: true },
        )
        return
      }
      chunks.push(chunk)
      armIdleTimer()
    }

    function onEnd() {
      if (settled) return
      if (!chunks.length) {
        finishResolve({})
        return
      }

      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
      } catch {
        finishReject(bodyError('请求体不是有效的 JSON', 400, 'INVALID_JSON'))
        return
      }

      if (!isJsonObject(parsed)) {
        finishReject(bodyError('请求体必须是 JSON 对象', 400, 'INVALID_JSON_BODY'))
        return
      }
      finishResolve(parsed)
    }

    function onError(error) {
      finishReject(Object.assign(error, {
        status: 400,
        code: 'REQUEST_BODY_ERROR',
        closeConnection: true,
      }))
    }

    req.on('data', onData)
    req.once('end', onEnd)
    req.on('error', onError)
    armIdleTimer()

    if (totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        finishReject(
          bodyError('请求体读取超时', 408, 'REQUEST_TIMEOUT', true),
          { drain: true },
        )
      }, totalTimeoutMs)
    }
  })
}
