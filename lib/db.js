/**
 * ============================================================================
 *  lib/db.js —— SQLite 数据库连接、建表、旧数据迁移
 * ============================================================================
 *
 * 【为什么从 JSON 文件换成 SQLite】
 *
 *   原来的做法是把所有记录放进一个 files.json，每次改动都「整个数组重写」。
 *   实测 10 万条记录时，一次写入要序列化 38MB、阻塞主线程 191ms ——
 *   这期间整个网站没有任何响应。而且数据越多越慢，属于「用着用着就卡死」。
 *
 *   SQLite 是嵌入式数据库（一个文件就是一个库，不需要另外装服务），
 *   每次写入只改动受影响的那几行（通常不到 0.1ms），
 *   查询还能走索引。数据量从 1 千涨到 10 万，性能几乎不变。
 *
 * 【为什么用 node:sqlite 而不是 better-sqlite3】
 *   node:sqlite 是 Node 自带的，不需要 npm install，也不需要编译原生模块。
 *   在 2G 内存的小服务器上，避免编译过程本身就是一种可靠性的提升。
 *   （代价：它目前还标着 experimental，API 未来可能有微调。）
 *
 * 【为什么用「同步」的数据库 API】
 *   直觉上同步会阻塞，但 SQLite 的单行读写是微秒级的，阻塞时间可以忽略。
 *   相比之下，异步 API 会让每个调用点都要 await，代码复杂很多。
 *   「微秒级同步」比「毫秒级全量重写」快几千倍，这是换库最核心的收益。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, UPLOAD_DIR, DB_FILE } from './paths.js'

/**
 * 屏蔽 node:sqlite 的「实验性功能」警告。
 *
 * import 语句会被提升到文件顶部先执行，警告在那时就打出来了，
 * 所以必须在 import 之前改好 process.emit —— 这也是下面用动态 import 的原因。
 *
 * 只过滤 SQLite 这一条，其它警告照常显示，不做全局静音。
 */
const originalEmit = process.emit
process.emit = function (event, payload, ...rest) {
  if (
    event === 'warning' &&
    payload &&
    payload.name === 'ExperimentalWarning' &&
    String(payload.message).includes('SQLite')
  ) {
    return false
  }
  return originalEmit.call(this, event, payload, ...rest)
}

/**
 * ── 版本闸门 ────────────────────────────────────────────────────────────
 *
 * node:sqlite 是 Node 22.5 才加入的内置模块。
 * 版本不够时，直接 import 会抛出这么一行天书：
 *   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 * 看的人完全不知道该怎么办。所以这里先自己检查一遍，
 * 给出「你是什么版本、需要什么版本、怎么升级」的明确提示。
 *
 * 注意：必须放在 import 之前执行，所以下面用的是动态 import。
 */
function assertNodeVersion() {
  const [major, minor] = String(process.versions.node).split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 5)) return

  const current = process.versions.node
  console.error('')
  console.error('  启动失败：Node 版本过低')
  console.error('')
  console.error(`  当前版本：v${current}`)
  console.error('  需要版本：v22.5 或更高（数据库用的 node:sqlite 从 22.5 才开始提供）')
  console.error('')
  console.error('  升级方式（Debian / Ubuntu）：')
  console.error('    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -')
  console.error('    sudo apt-get install -y nodejs')
  console.error('')
  console.error('  升级方式（CentOS / Alibaba Cloud Linux）：')
  console.error('    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -')
  console.error('    sudo dnf install -y nodejs   # 老系统用 yum')
  console.error('')
  console.error('  装完用 node -v 确认是 v22 以上，再重新启动。')
  console.error('')
  process.exit(1)
}

assertNodeVersion()

// 动态导入：确保版本检查和上面的警告过滤器都先生效
const { DatabaseSync } = await import('node:sqlite')

// 目录必须先存在，否则 SQLite 打不开文件
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

export const db = new DatabaseSync(DB_FILE)

/**
 * ── 四个关键 PRAGMA ─────────────────────────────────────────────────────
 *
 * journal_mode = WAL
 *   预写日志模式。默认模式下一次写入会锁住整个库，读操作得等着；
 *   WAL 让「读」和「写」可以同时进行，响应明显更顺畅。
 *   代价是磁盘上会多出 vault.db-wal 和 vault.db-shm 两个文件，属正常现象。
 *
 * synchronous = NORMAL
 *   WAL 模式下的推荐值。既不会因为断电丢数据，又比 FULL 快很多。
 *
 * foreign_keys = ON
 *   SQLite 默认不检查外键约束！必须手动打开，
 *   否则删用户时他名下的文件记录不会跟着删，留下孤儿数据。
 *
 * busy_timeout = 5000
 *   万一真的发生锁冲突，最多等 5 秒再报错，而不是立刻失败。
 */
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`)

/**
 * ── 建表 ────────────────────────────────────────────────────────────────
 *
 * 用 IF NOT EXISTS，所以每次启动执行都安全，不会覆盖已有数据。
 *
 * 数据类型说明：
 *   TEXT    字符串（时间也存成 ISO 字符串，例如 2026-09-28T08:49:28.667Z）
 *   INTEGER 整数（文件大小用字节数）
 *   PRIMARY KEY 主键，自带索引且必须唯一
 *
 * 注意 owner_id 上的 REFERENCES users(id) ON DELETE CASCADE：
 * 删用户时自动删掉他所有文件记录（前提是 foreign_keys 已打开）。
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    nickname      TEXT NOT NULL,
    salt          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
`)

/**
 * ── 建索引 ──────────────────────────────────────────────────────────────
 *
 * 索引就像书的目录：没有它，查「我的照片」要把整张表从头扫到尾（全表扫描）；
 * 有了它，可以直接跳到对应位置。
 *
 * 列表页最常用的查询是「某个用户的、按时间倒序、可能带分类筛选」，
 * 所以建这两个组合索引。注意列的先后顺序有意义 ——
 * owner_id 必须放第一位，因为每次查询都带着它。
 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_files_owner_created
    ON files(owner_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_files_owner_category
    ON files(owner_id, category, created_at DESC);
`)

/* ══════════════════════════════════════════════════════════════════════════
   旧数据迁移：把 data/users.json 和 data/files.json 导进数据库
   ══════════════════════════════════════════════════════════════════════════ */

function readLegacyJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 只在「数据库是空的」且「存在旧 JSON 文件」时才导入。
 * 导入完成后把旧文件改名成 .migrated，避免下次启动重复导入。
 *
 * 整个过程包在一个事务里：要么全部成功，要么全部回滚，
 * 不会出现「用户导进去了、文件只导了一半」的残缺状态。
 */
function migrateLegacyJson() {
  const existingUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  const existingFiles = db.prepare('SELECT COUNT(*) AS n FROM files').get().n
  if (existingUsers > 0 || existingFiles > 0) return { users: 0, files: 0, skipped: true }

  const usersPath = path.join(DATA_DIR, 'users.json')
  const filesPath = path.join(DATA_DIR, 'files.json')
  if (!fs.existsSync(usersPath) && !fs.existsSync(filesPath)) {
    return { users: 0, files: 0, skipped: true }
  }

  const legacyUsers = readLegacyJson(usersPath)
  const legacyFiles = readLegacyJson(filesPath)
  if (!legacyUsers.length && !legacyFiles.length) return { users: 0, files: 0, skipped: true }

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, nickname, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO files
      (id, owner_id, name, category, mime, size, stored_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let importedUsers = 0
  let importedFiles = 0

  db.exec('BEGIN')
  try {
    for (const user of legacyUsers) {
      if (!user || !user.id || !user.email) continue
      insertUser.run(
        String(user.id),
        String(user.email),
        String(user.nickname || user.email.split('@')[0]),
        String(user.salt || ''),
        String(user.passwordHash || ''),
        String(user.createdAt || new Date().toISOString()),
      )
      importedUsers += 1
    }

    // 只导入「归属用户确实存在」的文件记录，避免外键报错
    const ownerIds = new Set(
      db.prepare('SELECT id FROM users').all().map((row) => row.id),
    )

    for (const file of legacyFiles) {
      if (!file || !file.id || !ownerIds.has(file.ownerId)) continue
      insertFile.run(
        String(file.id),
        String(file.ownerId),
        String(file.name || '未命名文件'),
        String(file.category || 'file'),
        String(file.mime || 'application/octet-stream'),
        Number(file.size) || 0,
        String(file.storedName || ''),
        String(file.createdAt || new Date().toISOString()),
        String(file.updatedAt || file.createdAt || new Date().toISOString()),
      )
      importedFiles += 1
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // 备份旧文件，不直接删 —— 万一迁移有问题还能回退
  for (const [src, label] of [[usersPath, 'users'], [filesPath, 'files']]) {
    if (fs.existsSync(src)) {
      const backup = `${src}.migrated`
      if (fs.existsSync(backup)) fs.unlinkSync(backup)
      fs.renameSync(src, backup)
      void label
    }
  }

  return { users: importedUsers, files: importedFiles, skipped: false }
}

export const migrationResult = migrateLegacyJson()

/** 把数据库里的原始行（snake_case）转成代码里用的对象（camelCase）。 */
export function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    salt: row.salt,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  }
}

export function mapFile(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    category: row.category,
    mime: row.mime,
    size: row.size,
    storedName: row.stored_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 关闭数据库连接（进程退出时用，保证 WAL 内容合并回主文件）。 */
export function closeDb() {
  try {
    db.close()
  } catch {
    /* 已经关了，忽略 */
  }
}
