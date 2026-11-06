/**
 * 执行编号式数据库迁移；每个迁移单独事务并记录版本。
 * 安全审计注记：当前只记录迁移 ID，没有 checksum；修改已应用迁移不会被检测。
 */
export function runMigrations(db, migrations, logger = console) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id))
  let count = 0
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
      db.exec('COMMIT')
      count += 1
    } catch (error) {
      db.exec('ROLLBACK')
      logger.error(`[migration] ${migration.id} 失败`, error && error.message)
      throw error
    }
  }
  return count
}