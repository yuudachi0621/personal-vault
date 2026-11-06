import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePublicOrigin, requestProtocol } from '../lib/config.js'
import { requestIp } from '../lib/rate-limit.js'

function req({ headers = {}, remoteAddress = '10.0.0.1', encrypted = false } = {}) {
  return { headers, socket: { remoteAddress, encrypted } }
}

test('ignores forwarded headers when proxy trust is disabled', () => {
  const request = req({
    headers: {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
    },
  })

  assert.equal(requestIp(request, { trustProxy: false }), '10.0.0.1')
  assert.equal(requestProtocol(request, { trustProxy: false }), 'http')
})

test('uses proxy headers when proxy trust is enabled', () => {
  const request = req({
    headers: {
      'x-forwarded-for': '203.0.113.9, 10.0.0.2',
      'x-forwarded-proto': 'https',
    },
  })

  assert.equal(requestIp(request, { trustProxy: true }), '203.0.113.9')
  assert.equal(requestProtocol(request, { trustProxy: true }), 'https')
})

test('ignores invalid forwarded protocol values', () => {
  const request = req({ headers: { 'x-forwarded-proto': 'ftp' } })
  assert.equal(requestProtocol(request, { trustProxy: true }), 'http')
})

test('normalizes valid public origins and rejects non-origin values', () => {
  assert.equal(normalizePublicOrigin('https://vault.example.com/'), 'https://vault.example.com')
  assert.equal(normalizePublicOrigin('http://localhost:8787'), 'http://localhost:8787')
  assert.equal(normalizePublicOrigin('https://vault.example.com/path'), null)
  assert.equal(normalizePublicOrigin('ftp://vault.example.com'), null)
  assert.equal(normalizePublicOrigin('not a url'), null)
})