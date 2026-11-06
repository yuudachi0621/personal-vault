import test from 'node:test'
import assert from 'node:assert/strict'

import { sendError, sendJson } from '../lib/http-response.js'

function responseCapture() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = body },
  }
}

test('sends JSON with byte-accurate content length and no-store caching', () => {
  const res = responseCapture()
  sendJson(res, 201, { message: '中文' }, { 'X-Test': 'yes' })
  assert.equal(res.status, 201)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['X-Test'], 'yes')
  assert.equal(Number(res.headers['Content-Length']), Buffer.byteLength(res.body))
  assert.deepEqual(JSON.parse(res.body), { message: '中文' })
})

test('sends the standard error envelope', () => {
  const res = responseCapture()
  sendError(res, 429, '稍后再试', 'RATE_LIMITED', { 'Retry-After': 10 })
  assert.equal(res.status, 429)
  assert.equal(res.headers['Retry-After'], 10)
  assert.deepEqual(JSON.parse(res.body), { error: '稍后再试', code: 'RATE_LIMITED' })
})