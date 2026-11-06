/** 解析并限制列表分页参数。 */
export function parsePagination(searchParams, { defaultLimit = 60, maxLimit = 200 } = {}) {
  const rawLimit = Number(searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), maxLimit)
    : defaultLimit
  const rawOffset = Number(searchParams.get('offset'))
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

/** 生成统一的 page 响应结构。 */
export function buildPageInfo({ limit, offset, total, returned }) {
  return {
    limit,
    offset,
    total,
    hasMore: offset + returned < total,
  }
}