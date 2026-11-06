import test from 'node:test'
import assert from 'node:assert/strict'

import { readIntegerEnv } from '../lib/env.js'

test('uses the default when the variable is missing or blank', () => {
  assert.equal(readIntegerEnv({}, 'LIMIT', 10), 10)
  assert.equal(readIntegerEnv({ LIMIT: '' }, 'LIMIT', 10), 10)
  assert.equal(readIntegerEnv({ LIMIT: '   ' }, 'LIMIT', 10), 10)
})

test('accepts a trimmed decimal integer', () => {
  assert.equal(readIntegerEnv({ LIMIT: ' 1024 ' }, 'LIMIT', 10), 1024)
  assert.equal(readIntegerEnv({ LIMIT: '0' }, 'LIMIT', 10), 0)
})

test('enforces the configured minimum', () => {
  assert.equal(readIntegerEnv({ LIMIT: '1' }, 'LIMIT', 1, { min: 1 }), 1)
  assert.throws(
    () => readIntegerEnv({ LIMIT: '0' }, 'LIMIT', 1, { min: 1 }),
    /LIMIT.*1 到/,
  )
})

test('enforces the configured maximum', () => {
  assert.throws(
    () => readIntegerEnv({ PORT: '65536' }, 'PORT', 8787, { min: 0, max: 65535 }),
    /PORT.*0 到 65535/,
  )
})

test('rejects non-decimal and non-integer values', () => {
  for (const value of ['abc', '1.5', '-1', '1e3', '0x10', '10gb']) {
    assert.throws(() => readIntegerEnv({ LIMIT: value }, 'LIMIT', 10), /LIMIT/)
  }
})

test('rejects unsafe integers', () => {
  assert.throws(
    () => readIntegerEnv({ LIMIT: String(Number.MAX_SAFE_INTEGER + 1) }, 'LIMIT', 10),
    /LIMIT/,
  )
})
