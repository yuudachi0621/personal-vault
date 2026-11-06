import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { runMigrations } from '../lib/migrations.js'

test('applies each numbered migration once', () => {
  const db = new DatabaseSync(':memory:')
  let runs = 0
  const migrations = [{ id: '001_test', up(database) { runs += 1; database.exec('CREATE TABLE sample (id INTEGER)') } }]
  assert.equal(runMigrations(db, migrations, { error() {} }), 1)
  assert.equal(runMigrations(db, migrations, { error() {} }), 0)
  assert.equal(runs, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1)
  db.close()
})

test('rolls back a failed migration and does not record it', () => {
  const db = new DatabaseSync(':memory:')
  assert.throws(() => runMigrations(db, [{
    id: '002_bad',
    up(database) { database.exec('CREATE TABLE rolled_back (id INTEGER)'); throw new Error('failed') },
  }], { error() {} }))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'rolled_back'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0)
  db.close()
})