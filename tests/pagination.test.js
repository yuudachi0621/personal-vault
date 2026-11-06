import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPageInfo, parsePagination } from '../lib/pagination.js'

test('parses defaults and clamps the maximum page size', () => {
  assert.deepEqual(parsePagination(new URLSearchParams()), { limit: 60, offset: 0 })
  assert.deepEqual(
    parsePagination(new URLSearchParams('limit=999999&offset=30.9')),
    { limit: 200, offset: 30 },
  )
})

test('rejects invalid pagination values without changing defaults', () => {
  assert.deepEqual(parsePagination(new URLSearchParams('limit=0&offset=-5')), { limit: 60, offset: 0 })
  assert.deepEqual(parsePagination(new URLSearchParams('limit=abc&offset=abc')), { limit: 60, offset: 0 })
})

test('builds a consistent page response shape', () => {
  assert.deepEqual(
    buildPageInfo({ limit: 30, offset: 30, total: 95, returned: 30 }),
    { limit: 30, offset: 30, total: 95, hasMore: true },
  )
  assert.deepEqual(
    buildPageInfo({ limit: 30, offset: 90, total: 95, returned: 5 }),
    { limit: 30, offset: 90, total: 95, hasMore: false },
  )
})