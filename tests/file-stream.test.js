import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sendStoredFile } from '../lib/file-stream.js'

function responseCapture() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = body },
  }
}

function createTempRecord(t, content = 'hello') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-stream-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('临时目录清理路径越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const ownerId = 'u1'
  fs.mkdirSync(path.join(dir, ownerId))
  const storedName = 'file.txt'
  fs.writeFileSync(path.join(dir, ownerId, storedName), content)
  return {
    record: {
      id: 'f1', ownerId, storedName, name: 'note.txt', category: 'file',
      mime: 'text/plain', size: Buffer.byteLength(content), contentHash: 'abc',
    },
    filePath: path.join(dir, ownerId, storedName),
  }
}

test('HEAD responses do not read the entire file body', (t) => {
  const { record, filePath } = createTempRecord(t)
  const res = responseCapture()
  sendStoredFile({ method: 'HEAD' }, res, record, 'attachment', { filePath })
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers['Content-Length']), 5)
  assert.equal(res.body, '')
})

test('missing files return the standard JSON error envelope', (t) => {
  const { record } = createTempRecord(t)
  const res = responseCapture()
  sendStoredFile({ method: 'GET' }, res, record, 'attachment', { filePath: path.join(os.tmpdir(), 'missing-file') })
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).code, 'FILE_MISSING')
})