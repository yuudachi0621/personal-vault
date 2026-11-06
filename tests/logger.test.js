import test from 'node:test'
import assert from 'node:assert/strict'

import { logEvent, redactLogFields } from '../lib/logger.js'

test('redacts sensitive keys recursively', () => {
  assert.deepEqual(redactLogFields({
    email: 'user@example.com',
    password: 'secret',
    nested: { token: 'abc', cookie: 'session', safe: 1 },
  }), {
    email: 'user@example.com',
    password: '[redacted]',
    nested: { token: '[redacted]', cookie: '[redacted]', safe: 1 },
  })
})

test('writes structured JSON to the requested sink', () => {
  const lines = []
  const sink = { log: (line) => lines.push(line), warn() {}, error() {} }
  logEvent('info', 'test_event', { requestId: 'r1', durationMs: 12 }, sink)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.event, 'test_event')
  assert.equal(parsed.requestId, 'r1')
  assert.equal(parsed.durationMs, 12)
  assert.equal(typeof parsed.ts, 'string')
})