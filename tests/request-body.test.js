import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'

import { readJsonBody } from '../lib/request-body.js'

function bodyStream(text) {
  return Readable.from([Buffer.from(text)])
}

test('parses a JSON object and treats an empty body as an empty object', async () => {
  assert.deepEqual(
    await readJsonBody(bodyStream('{"email":"user@example.com"}')),
    { email: 'user@example.com' },
  )
  assert.deepEqual(await readJsonBody(Readable.from([])), {})
})

test('rejects invalid JSON and non-object JSON values', async () => {
  await assert.rejects(
    readJsonBody(bodyStream('{')),
    (error) => error.status === 400 && error.code === 'INVALID_JSON',
  )

  for (const payload of ['null', '[]', '"text"', '1', 'true']) {
    await assert.rejects(
      readJsonBody(bodyStream(payload)),
      (error) => error.status === 400 && error.code === 'INVALID_JSON_BODY',
    )
  }
})

test('rejects an oversized body without buffering the full payload', async () => {
  await assert.rejects(
    readJsonBody(Readable.from([Buffer.alloc(11)]), { limit: 10 }),
    (error) => error.status === 413
      && error.code === 'BODY_TOO_LARGE'
      && error.closeConnection === true,
  )
})

test('rejects a body that stays idle', async () => {
  const req = new PassThrough()
  try {
    await assert.rejects(
      readJsonBody(req, { idleTimeoutMs: 25, totalTimeoutMs: 500 }),
      (error) => error.status === 408
        && error.code === 'REQUEST_TIMEOUT'
        && error.closeConnection === true,
    )
  } finally {
    req.destroy()
  }
})

test('rejects a body that exceeds the total timeout despite activity', async () => {
  const req = new PassThrough()
  const interval = setInterval(() => req.write(' '), 10)
  try {
    await assert.rejects(
      readJsonBody(req, { idleTimeoutMs: 200, totalTimeoutMs: 50 }),
      (error) => error.status === 408 && error.code === 'REQUEST_TIMEOUT',
    )
  } finally {
    clearInterval(interval)
    req.destroy()
  }
})

test('maps a stream error to a request body error', async () => {
  const req = new PassThrough()
  const result = readJsonBody(req, { idleTimeoutMs: 500, totalTimeoutMs: 500 })
  req.destroy(new Error('stream failed'))

  await assert.rejects(
    result,
    (error) => error.status === 400
      && error.code === 'REQUEST_BODY_ERROR'
      && error.closeConnection === true,
  )
})
