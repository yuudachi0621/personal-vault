#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

const rows = Number(process.argv[2] || 10_000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-vault-bench-'))
const db = new DatabaseSync(path.join(dir, 'bench.db'))
try {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE files (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      category TEXT NOT NULL, mime TEXT NOT NULL, content_hash TEXT,
      size INTEGER NOT NULL, stored_name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, is_private INTEGER NOT NULL DEFAULT 0, private_at TEXT
    );
    CREATE INDEX idx_files_owner_created ON files(owner_id, created_at DESC);
    CREATE INDEX idx_files_owner_category ON files(owner_id, category, created_at DESC);
  `)
  const insert = db.prepare(`INSERT INTO files
    (id, owner_id, name, category, mime, size, stored_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const base = Date.now()
  db.exec('BEGIN')
  for (let i = 0; i < rows; i += 1) {
    insert.run(`f${i}`, 'u_bench', `file-${i}.txt`, 'file', 'text/plain', i,
      `stored-${i}.txt`, new Date(base - i * 1000).toISOString(), new Date(base).toISOString())
  }
  db.exec('COMMIT')

  const queries = {
    list: `SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NULL AND is_private = 0 ORDER BY created_at DESC LIMIT 30 OFFSET 0`,
    count: `SELECT COUNT(*) AS n FROM files WHERE owner_id = ? AND deleted_at IS NULL AND is_private = 0`,
    search: `SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NULL AND is_private = 0 AND name LIKE '%0%' ORDER BY created_at DESC LIMIT 30`,
  }
  const output = { rows, queries: {} }
  for (const [name, sql] of Object.entries(queries)) {
    const started = performance.now()
    db.prepare(sql).all('u_bench')
    output.queries[name] = {
      durationMs: Number((performance.now() - started).toFixed(2)),
      plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('u_bench').map((row) => row.detail),
    }
  }
  console.log(JSON.stringify(output, null, 2))
} finally {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
}