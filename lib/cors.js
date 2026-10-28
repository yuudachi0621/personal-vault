/**
 * ============================================================================
 *  lib/cors.js —— 跨域支持（分离部署时才会真正起作用）
 * ============================================================================
 *
 * 【同源策略是什么】
 *   浏览器有一条铁律：页面里的 JS 只能读取「同源」的接口返回的数据。
 *   所谓同源 = 协议 + 域名 + 端口 三者完全相同。
 *
 *     https://vault.example.com  →  https://vault.example.com/api   ✅ 同源
 *     https://vault.example.com  →  https://api.example.com/api     ❌ 端口/域名不同
 *
 * 【注意：被拦的是「读」，不是「发」】
 *   跨源请求其实照发不误，服务器也确实执行了 ——
 *   只是浏览器不把结果交给 JS。所以排错时常常看到
 *   「后端日志显示处理成功了，前端却报错」，就是这个原因。
 *
 * 【CORS 就是服务器开的许可证】
 *   服务器在响应头里加上 Access-Control-Allow-Origin: <某个具体来源>，
 *   浏览器看到「对方明确点名允许我」，才把数据交给 JS。
 *
 * 【两个易错点】
 *   1. 带了 Cookie 的跨域请求，这个头必须是具体域名，不能用 * 
 *   2. 某些请求（比如带 JSON 请求体的 POST）浏览器会先自动发一个
 *      OPTIONS 请求「探路」，这叫「预检」。预检没通过，真正的请求根本不会发出。
 *      下面 handlePreflight 就是负责应答这个探路的。
 */

import { isOriginAllowed, needsCorsHeaders, ALLOWED_ORIGINS } from './config.js'

const ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Content-Type, Authorization'
const EXPOSE_HEADERS = 'Content-Disposition, Content-Range, Accept-Ranges, Content-Length, X-Video-Preview'

/**
 * 为请求设置 CORS 响应头。
 * 返回 false 表示该来源不被允许，调用方应直接拒绝。
 */
export function applyCors(req, res) {
  const origin = req.headers.origin
  if (!origin) return true

  if (!isOriginAllowed(req, origin)) return false

  res.setHeader('Vary', 'Origin')
  if (needsCorsHeaders(req, origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS)
  }
  return true
}

/**
 * 处理浏览器预检请求。已响应返回 true。
 * 注意：带 Cookie 的跨域请求必须回显具体 Origin，不能用 `*`。
 */
export function handlePreflight(req, res) {
  if (req.method !== 'OPTIONS') return false

  const origin = req.headers.origin
  const requestedMethod = req.headers['access-control-request-method']

  // 非 /api 路径的 OPTIONS 不按预检处理，交回后续流程。
  const isApi = String(req.url || '').startsWith('/api/')
  if (!isApi && !requestedMethod) return false

  if (!origin || !needsCorsHeaders(req, origin)) {
    res.writeHead(204, { Allow: ALLOW_METHODS })
    res.end()
    return true
  }

  res.writeHead(204, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  })
  res.end()
  return true
}

/** 启动日志用。 */
export function corsSummary() {
  return ALLOWED_ORIGINS.length
    ? `CORS 已启用 → ${ALLOWED_ORIGINS.join(', ')}`
    : 'CORS 未启用（仅同源）'
}
