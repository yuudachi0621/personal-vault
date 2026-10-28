/**
 * 轻量内存限流器。
 *
 * 适合单进程部署，作用是给登录、注册、上传等敏感接口加一道基础防线。
 * 它不能替代 Cloudflare / Nginx 等反向代理的 DDoS 防护，但可以阻止单个来源
 * 在短时间内制造大量昂贵计算或并发上传。
 */

const buckets = new Map()
const MAX_BUCKETS = 20_000
let lastSweep = 0

function sweep(now, force = false) {
  if (!force && now - lastSweep < 10_000) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/** 获取客户端 IP。只有明确设置 TRUST_PROXY=1 时才信任代理转发头。 */
export function requestIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown'
  if (process.env.TRUST_PROXY !== '1') return socketIp

  const cloudflareIp = String(req.headers['cf-connecting-ip'] || '').trim()
  if (cloudflareIp) return cloudflareIp

  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  return forwarded || socketIp
}

/** 固定窗口计数；达到上限后返回 allowed=false。 */
export function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now()
  sweep(now)

  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    // 防止攻击者用海量伪造 IP 把内存撑大；达到上限后先清理过期桶，
    // 仍然满则短暂拒绝所有新 key，宁可按限流处理也不让进程 OOM。
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      sweep(now, true)
      if (buckets.size >= MAX_BUCKETS) {
        return { allowed: false, retryAfterSec: 60 }
      }
    }
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }
  bucket.count += 1

  return {
    allowed: bucket.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}

/** 登录成功后清除该账号的失败次数窗口。 */
export function resetRateLimit(key) {
  buckets.delete(key)
}
