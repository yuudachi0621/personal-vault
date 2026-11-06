import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  consumeRateLimit,
  loginAccountRateKey,
  resetRateLimit,
} from '../lib/rate-limit.js'

test('normalizes account email before creating the rate-limit key', () => {
  const canonical = loginAccountRateKey('user@example.com')
  assert.equal(loginAccountRateKey('  USER@Example.COM  '), canonical)
  assert.notEqual(loginAccountRateKey('other@example.com'), canonical)
})

test('does not expose the email address in the account rate-limit key', () => {
  const email = 'private@example.com'
  const key = loginAccountRateKey(email)
  assert.match(key, /^login-account:[a-f0-9]{20}$/)
  assert.equal(key.includes(email), false)
  assert.equal(key.includes('private'), false)
})

test('enforces a fixed-window limit and resets after success', () => {
  const key = `test:${crypto.randomUUID()}`
  assert.equal(consumeRateLimit(key, 2, 60_000).allowed, true)
  assert.equal(consumeRateLimit(key, 2, 60_000).allowed, true)
  assert.equal(consumeRateLimit(key, 2, 60_000).allowed, false)

  resetRateLimit(key)
  assert.equal(consumeRateLimit(key, 2, 60_000).allowed, true)
})

test('keeps separate counters for different account keys', () => {
  const first = `test:${crypto.randomUUID()}`
  const second = `test:${crypto.randomUUID()}`
  assert.equal(consumeRateLimit(first, 1, 60_000).allowed, true)
  assert.equal(consumeRateLimit(first, 1, 60_000).allowed, false)
  assert.equal(consumeRateLimit(second, 1, 60_000).allowed, true)
})