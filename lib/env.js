/**
 * 读取并校验整数环境变量。
 *
 * 未设置或空白值使用默认值；显式值必须是十进制安全整数，
 * 且位于 [min, max] 范围内。非法配置直接抛错，避免 NaN
 * 进入配额、上传上限或超时判断后静默绕过保护。
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} defaultValue
 * @param {{min?: number, max?: number}} options
 * @returns {number}
 */
export function readIntegerEnv(env, name, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(defaultValue) || defaultValue < min || defaultValue > max) {
    throw new Error(`环境变量 ${name} 的内部默认值无效`)
  }

  const raw = env && env[name]
  if (raw === undefined || String(raw).trim() === '') return defaultValue

  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`环境变量 ${name} 必须是 ${min} 到 ${max} 之间的十进制整数`)
  }

  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min} 到 ${max} 之间的十进制整数`)
  }
  return value
}
