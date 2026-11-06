import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { removeFileIfExists } from '../lib/fs-utils.js'

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-fs-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('临时目录清理路径越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return dir
}

test('removes an existing file and treats a missing file as success', (t) => {
  const dir = createTempDir(t)
  const filePath = path.join(dir, 'file.txt')
  fs.writeFileSync(filePath, 'data', 'utf8')

  assert.equal(removeFileIfExists(filePath), true)
  assert.equal(fs.existsSync(filePath), false)
  assert.equal(removeFileIfExists(filePath), true)
})

test('reports a real filesystem error instead of silently succeeding', (t) => {
  const dir = createTempDir(t)
  assert.equal(removeFileIfExists(dir), false)
})