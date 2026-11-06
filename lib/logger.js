import crypto from 'node:crypto'

const SENSITIVE_KEY = /password|token|secret|cookie|authorization/i

/** 递归脱敏日志字段。 */
export function redactLogFields(value, depth = 0) {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.map((item) => redactLogFields(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactLogFields(item, depth + 1)
  }
  return output
}

/** 写入一条结构化日志。 */
export function logEvent(level, event, fields = {}, sink = console) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redactLogFields(fields),
  })
  if (level === 'error') sink.error(line)
  else if (level === 'warn') sink.warn(line)
  else sink.log(line)
}

export function newRequestId() {
  return crypto.randomUUID()
}