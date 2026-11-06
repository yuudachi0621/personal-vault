/** 统一发送 JSON 响应。 */
export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

/** 统一发送 { error, code } 错误响应。 */
export function sendError(res, status, message, code = 'ERROR', extraHeaders = {}) {
  sendJson(res, status, { error: message, code }, extraHeaders)
}