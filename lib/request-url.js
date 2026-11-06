/**
 * 解析 HTTP 请求目标，只提取 pathname 与 searchParams。
 *
 * req.url 通常是相对路径。使用固定内部基准可避免把客户端可控的 Host
 * 放进 URL 解析器；即使 Host 非法，也不会在这里抛异常。
 *
 * @param {string | undefined} rawUrl
 * @returns {URL | null} 合法时返回 URL，非法时返回 null
 */
export function parseRequestUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '/'), 'http://localhost')
  } catch {
    return null
  }
}
