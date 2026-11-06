import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrateLegacyJson } from '../lib/legacy-migration.js'

const USER_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`

function createDb(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(USER_SCHEMA)
  t.after(() => db.close())
  return db
}

function createDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-migration-'))
  t.after(() => {
    const resolved = path.resolve(dir)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('临时目录清理路径越界')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return dir
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function validUser(overrides = {}) {
  return {
    id: 'u_1',
    email: 'one@example.com',
    nickname: 'One',
    salt: 'dummy-salt',
    passwordHash: 'dummy-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function validFile(overrides = {}) {
  return {
    id: 'f_1',
    ownerId: 'u_1',
    name: 'note.txt',
    category: 'file',
    mime: 'text/plain',
    size: 12,
    storedName: 'stored-file.txt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('migrates valid legacy users and files, then creates backups', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  const filesPath = path.join(dataDir, 'files.json')
  const users = [validUser()]
  const files = [validFile()]
  writeJson(usersPath, users)
  writeJson(filesPath, files)

  const result = migrateLegacyJson({ db, dataDir })

  assert.deepEqual(result, { users: 1, files: 1, skipped: false, warnings: [] })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1)
  assert.equal(fs.existsSync(usersPath), false)
  assert.equal(fs.existsSync(filesPath), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(`${usersPath}.migrated`, 'utf8')), users)
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filesPath}.migrated`, 'utf8')), files)
})

test('fails on malformed JSON without exposing file content or changing database', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  fs.writeFileSync(usersPath, '{"email":"private@example.com"', 'utf8')

  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    (error) => error.message.includes('不是有效 JSON') && !error.message.includes('private@example.com'),
  )
  assert.equal(fs.existsSync(usersPath), true)
  assert.equal(fs.existsSync(`${usersPath}.migrated`), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
})

test('fails when a legacy JSON file is not an array', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  writeJson(path.join(dataDir, 'users.json'), { users: [] })

  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    /users\.json 必须是数组/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
})

test('fails when files.json exists without users.json', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const filesPath = path.join(dataDir, 'files.json')
  writeJson(filesPath, [validFile()])

  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    /users\.json 缺失/,
  )
  assert.equal(fs.existsSync(filesPath), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0)
})

test('fails and rolls back when a file references an unknown owner', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  const filesPath = path.join(dataDir, 'files.json')
  writeJson(usersPath, [validUser()])
  writeJson(filesPath, [validFile({ ownerId: 'u_missing' })])

  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    /引用了不存在的用户/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0)
  assert.equal(fs.existsSync(usersPath), true)
  assert.equal(fs.existsSync(`${usersPath}.migrated`), false)
})

test('rejects unsafe owner ids and stored names before importing', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  const filesPath = path.join(dataDir, 'files.json')

  writeJson(usersPath, [validUser({ id: '../u_1' })])
  writeJson(filesPath, [])
  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    /users.json 第 1 条记录的 id 不安全/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)

  writeJson(usersPath, [validUser()])
  writeJson(filesPath, [validFile({ storedName: '../stored.txt' })])
  assert.throws(
    () => migrateLegacyJson({ db, dataDir }),
    /storedName 不安全/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0)
})

test('never overwrites an existing migrated backup', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  const filesPath = path.join(dataDir, 'files.json')
  writeJson(usersPath, [validUser()])
  writeJson(filesPath, [validFile()])
  fs.writeFileSync(`${usersPath}.migrated`, 'KEEP', 'utf8')

  const result = migrateLegacyJson({ db, dataDir })

  assert.equal(result.skipped, false)
  assert.equal(result.warnings.length, 1)
  assert.equal(fs.readFileSync(`${usersPath}.migrated`, 'utf8'), 'KEEP')
  assert.equal(fs.existsSync(usersPath), true)
  assert.equal(fs.existsSync(filesPath), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1)
})

test('rolls back the whole transaction when insertion fails', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  const usersPath = path.join(dataDir, 'users.json')
  writeJson(usersPath, [
    validUser({ id: 'u_1', email: 'duplicate@example.com' }),
    validUser({ id: 'u_2', email: 'duplicate@example.com' }),
  ])

  assert.throws(() => migrateLegacyJson({ db, dataDir }))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  assert.equal(fs.existsSync(usersPath), true)
  assert.equal(fs.existsSync(`${usersPath}.migrated`), false)
})

test('keeps the existing skip behavior when the database already has data', (t) => {
  const db = createDb(t)
  const dataDir = createDataDir(t)
  db.prepare('INSERT INTO users (id, email, nickname, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('u_existing', 'existing@example.com', 'Existing', 'salt', 'hash', '2026-01-01T00:00:00.000Z')
  const usersPath = path.join(dataDir, 'users.json')
  fs.writeFileSync(usersPath, '{broken', 'utf8')

  const result = migrateLegacyJson({ db, dataDir })

  assert.deepEqual(result, { users: 0, files: 0, skipped: true, warnings: [] })
  assert.equal(fs.readFileSync(usersPath, 'utf8'), '{broken')
})