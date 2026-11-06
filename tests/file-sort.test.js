import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDb, initializeDatabase } from '../lib/db.js'
import { createFile, listFiles } from '../lib/store.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-sort-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('sorts files by name, size, category and modified time', async (t) => {
  const dataDir = tempDir(t)
  await initializeDatabase({ dataDir, uploadDir: path.join(dataDir, 'uploads'), dbFile: path.join(dataDir, 'vault.db') })
  try {
    const { db } = await import('../lib/db.js')
    db.prepare('INSERT INTO users (id, email, nickname, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u_sort', 'sort@example.com', 'Sort', 'salt', 'hash', '2026-01-01T00:00:00.000Z')

    const records = [
      { id: 'f-a', name: 'a.png', category: 'image', size: 300, updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'f-m', name: 'm.mp3', category: 'music', size: 200, updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'f-z', name: 'z.mp4', category: 'video', size: 100, updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    for (const record of records) {
      createFile({
        id: record.id,
        ownerId: 'u_sort',
        name: record.name,
        category: record.category,
        mime: 'application/octet-stream',
        size: record.size,
        storedName: `${record.id}.bin`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: record.updatedAt,
      })
    }

    const ids = (sort) => listFiles({ ownerId: 'u_sort', sort, limit: 10 }).map((file) => file.id)
    assert.deepEqual(ids('name'), ['f-a', 'f-m', 'f-z'])
    assert.deepEqual(ids('name-desc'), ['f-z', 'f-m', 'f-a'])
    assert.deepEqual(ids('largest'), ['f-a', 'f-m', 'f-z'])
    assert.deepEqual(ids('smallest'), ['f-z', 'f-m', 'f-a'])
    assert.deepEqual(ids('type'), ['f-a', 'f-z', 'f-m'])
    assert.deepEqual(ids('type-desc'), ['f-m', 'f-z', 'f-a'])
    assert.deepEqual(ids('updated'), ['f-a', 'f-m', 'f-z'])
    assert.deepEqual(ids('updated-asc'), ['f-z', 'f-m', 'f-a'])
  } finally {
    closeDb()
  }
})