import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDb, db, initializeDatabase } from '../lib/db.js'
import { createSession, deleteSession, findSessionById, listFiles } from '../lib/store.js'

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-db-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('临时目录清理路径越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return dir
}

test('imports without opening a database and requires explicit initialization', async (t) => {
  assert.equal(db, null)
  assert.throws(
    () => listFiles({ ownerId: 'u_not_initialized' }),
    /数据库尚未初始化/,
  )

  const dataDir = createTempDir(t)
  const uploadDir = path.join(dataDir, 'uploads')
  const dbFile = path.join(dataDir, 'vault.db')

  try {
    const first = await initializeDatabase({ dataDir, uploadDir, dbFile })
    const second = await initializeDatabase({ dataDir, uploadDir, dbFile })

    assert.equal(second, first)
    assert.equal(first.migrationResult.skipped, true)
    assert.equal(first.mediaCategoryFixResult.skipped, false)
    assert.equal(first.mediaCategoryFixResult.fixed, 0)
    assert.ok(db)
    assert.equal(fs.existsSync(dbFile), true)
    assert.equal(fs.existsSync(uploadDir), true)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'files'").get().n, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().n, 1)
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.deepEqual(listFiles({ ownerId: 'u_not_initialized' }), [])

    db.prepare('INSERT INTO users (id, email, nickname, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u_session', 'session@example.com', 'Session', 'salt', 'hash', '2026-01-01T00:00:00.000Z')
    createSession({
      id: 's_1',
      userId: 'u_session',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    assert.equal(findSessionById('s_1').userId, 'u_session')
    assert.equal(deleteSession('s_1', 'u_session'), true)
    assert.equal(findSessionById('s_1'), null)
  } finally {
    closeDb()
  }

  assert.equal(db, null)
})