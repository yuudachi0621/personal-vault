/**
 * ============================================================================
 *  lib/db.js —— SQLite 数据库连接、建表、旧数据迁移
 * ============================================================================
 *
 * 【为什么从 JSON 文件换成 SQLite】
 *
 *   旧实现把所有记录放在 JSON 数组中，每次修改都要重写整个文件；
 *   数据越多，序列化和写盘成本越高，也更容易在并发写入时互相覆盖。
 *
 *   SQLite 是嵌入式数据库（一个文件就是一个库，不需要额外服务），
 *   支持按行更新、索引、事务和外键，适合本项目单机部署的规模。
 *   旧 JSON 数据仍由 migrateLegacyJson() 在首次升级时导入。
 *
 * 【为什么用 node:sqlite 而不是 better-sqlite3】
 *   node:sqlite 随 Node 提供，不需要 npm 安装或编译原生模块，
 *   因而减少部署依赖。代价是它仍属于实验性 API，需要关注 Node 版本兼容性。
 *
 * 【为什么用「同步」的数据库 API】
 *   本项目的查询都是面向本地 SQLite 的短操作，同步 API 让调用点更直接，
 *   也避免大量异步分支。代价是长事务或大范围查询会阻塞事件循环，
 *   因此新增查询应保持有界，并尽量利用索引。
 */

import fs from 'node:fs'
import { DATA_DIR, UPLOAD_DIR, DB_FILE } from './paths.js'
import { migrateLegacyJson } from './legacy-migration.js'
import { detectCategory, inferMime } from './media.js'
import { runMigrations } from './migrations.js'

/**
 * ── 版本闸门 ────────────────────────────────────────────────────────────
 *
 * node:sqlite 是 Node 22.5 才加入的内置模块。
 * 版本不够时，直接 import 会抛出这么一行天书：
 *   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 * 看的人完全不知道该怎么办。所以这里先自己检查一遍，
 * 给出「你是什么版本、需要什么版本、怎么升级」的明确提示。
 *
 * 实际导入发生在显式初始化函数中，模块加载本身不会打开数据库。
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
  throw new Error(`Node.js 版本过低：当前 v${current}，需要 v22.5 或更高`)
}

export let db = null
let runtimeInfo = null
let initializationPromise = null

async function importNodeSqlite() {
  const originalEmit = process.emit
  process.emit = function filteredEmit(event, payload, ...rest) {
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
  try {
    return await import('node:sqlite')
  } finally {
    process.emit = originalEmit
  }
}

/**
 * 显式初始化 SQLite、目录、schema、迁移和一次性数据修复。
 * 导入本模块不会打开数据库或写入文件系统。
 *
 * @param {{dataDir?: string, uploadDir?: string, dbFile?: string}} options
 * @returns {Promise<{migrationResult: object, mediaCategoryFixResult: object}>}
 */
export async function initializeDatabase({
  dataDir = DATA_DIR,
  uploadDir = UPLOAD_DIR,
  dbFile = DB_FILE,
} = {}) {
  if (runtimeInfo) return runtimeInfo
  if (initializationPromise) return initializationPromise

  initializationPromise = (async () => {
    assertNodeVersion()
    // 动态导入：确保版本检查和上面的警告过滤器都先生效
    const { DatabaseSync } = await importNodeSqlite()

    // 目录和上传文件默认只允许运行服务的系统账号访问（Windows 下会忽略 Unix 权限位）
    try { process.umask(0o077) } catch { /* 平台不支持时忽略 */ }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 })
    for (const dir of [dataDir, uploadDir]) {
      try { fs.chmodSync(dir, 0o700) } catch { /* Windows / 特殊文件系统忽略 */ }
    }

    db = new DatabaseSync(dbFile)
    try { fs.chmodSync(dbFile, 0o600) } catch { /* Windows / 特殊文件系统忽略 */ }

    /**
     * ── 四个关键 PRAGMA ─────────────────────────────────────────────────────
     *
     * journal_mode = WAL
     *   预写日志模式。默认模式下一次写入会锁住整个库，读操作得等着；
     *   WAL 让「读」和「写」可以同时进行，响应明显更顺畅。
     *   代价是磁盘上会多出 vault.db-wal 和 vault.db-shm 两个文件，属正常现象。
     *
     * synchronous = NORMAL
     *   WAL 模式下的常用折中值。它能保持数据库一致性，但操作系统或硬件突然断电时，
     *   最近已提交的事务仍可能丢失，不能等同于 FULL 的持久性保证。
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
     * users 中同时保存账号密码与隐私密码各自的盐、哈希和版本号；
     * privacy_version 用于撤销旧的隐私解锁令牌。
     *
     * files 中 deleted_at 表示回收站，is_private 表示隐私空间。
     * 隐私文件不参与普通列表与回收站查询，但仍计入总配额。
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
        session_version INTEGER NOT NULL DEFAULT 0,
        privacy_salt  TEXT,
        privacy_hash  TEXT,
        privacy_version INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS files (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        category    TEXT NOT NULL,
        mime        TEXT NOT NULL,
        content_hash TEXT,
        size        INTEGER NOT NULL,
        stored_name TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT,
        is_private  INTEGER NOT NULL DEFAULT 0,
        private_at  TEXT
      );
    `)

    /**
     * ── 建索引 ──────────────────────────────────────────────────────────────
     *
     * 索引就像书的目录：没有它，查「我的照片」要把整张表从头扫到尾（全表扫描）；
     * 有了它，可以直接跳到对应位置。
     *
     * 这里会建立普通列表、回收站、内容去重、排序和隐私空间查询所需的索引。
     * 注意列的先后顺序有意义 —— owner_id 必须放第一位，因为每次查询都带着它。
     */
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_owner_created
        ON files(owner_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_files_owner_category
        ON files(owner_id, category, created_at DESC);
    `)

    /**
     * ── 回收站的列迁移 ──────────────────────────────────────────────────────
     *
     * `deleted_at` 是后加的列：老数据库里没有它。
     * 上面的 CREATE TABLE IF NOT EXISTS 对已存在的表不起作用，
     * 所以必须单独 ALTER 一次。
     *
     * 为什么先查 PRAGMA table_info？
     *   因为 ALTER TABLE ADD COLUMN 不是幂等的 —— 重复执行会报
     *   "duplicate column name" 直接让启动失败。
     *   PRAGMA table_info(files) 返回这张表的所有列信息，
     *   检查一下有没有 deleted_at，没有才加。
     *
     * deleted_at 为 NULL    → 正常文件
     * deleted_at 是时间字符串 → 这个时间被放进回收站，24 小时后自动清除
     */
    const userColumns = db.prepare('PRAGMA table_info(users)').all()
    if (!userColumns.some((column) => column.name === 'session_version')) {
      db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0')
    }
    if (!userColumns.some((column) => column.name === 'privacy_salt')) {
      db.exec('ALTER TABLE users ADD COLUMN privacy_salt TEXT')
    }
    if (!userColumns.some((column) => column.name === 'privacy_hash')) {
      db.exec('ALTER TABLE users ADD COLUMN privacy_hash TEXT')
    }
    if (!userColumns.some((column) => column.name === 'privacy_version')) {
      db.exec('ALTER TABLE users ADD COLUMN privacy_version INTEGER NOT NULL DEFAULT 0')
    }

    const fileColumns = db.prepare('PRAGMA table_info(files)').all()
    if (!fileColumns.some((column) => column.name === 'deleted_at')) {
      db.exec('ALTER TABLE files ADD COLUMN deleted_at TEXT')
    }

    if (!fileColumns.some((column) => column.name === 'content_hash')) {
      db.exec('ALTER TABLE files ADD COLUMN content_hash TEXT')
    }
    if (!fileColumns.some((column) => column.name === 'is_private')) {
      db.exec('ALTER TABLE files ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0')
    }
    if (!fileColumns.some((column) => column.name === 'private_at')) {
      db.exec('ALTER TABLE files ADD COLUMN private_at TEXT')
    }

    /**
     * content_hash 是上传内容的 SHA-256。新上传会实时计算；
     * 老记录在第一次遇到「大小相同」的上传时再懒计算，避免启动时扫描全部大文件。
     */
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_owner_size ON files(owner_id, size)')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_owner_content_hash ON files(owner_id, content_hash) WHERE content_hash IS NOT NULL')
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_owner_private_created ON files(owner_id, is_private, created_at DESC)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_files_owner_private_category ON files(owner_id, is_private, category, created_at DESC)')
    runMigrations(db, [
      {
        id: '001_core_schema',
        up() {
          // users/files 基线由上方幂等 schema 建立；此记录用于建立迁移基线。
        },
      },
      {
        id: '002_sessions',
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
              id          TEXT PRIMARY KEY,
              user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at  TEXT NOT NULL,
              expires_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
          `)
        },
      },
      {
        id: '003_folders',
        /**
         * 文件夹树使用 parent_id 自引用；files.folder_id 通过 ALTER TABLE 追加，
         * 没有重建旧 files 表，因此文件归属的一致性主要由应用层校验和清理逻辑保证。
         */
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS folders (
              id          TEXT PRIMARY KEY,
              owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
              name        TEXT NOT NULL,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              deleted_at  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_folders_owner_parent
              ON folders(owner_id, parent_id, deleted_at, name);
            CREATE INDEX IF NOT EXISTS idx_folders_owner_deleted
              ON folders(owner_id, deleted_at);
          `)
          const columns = database.prepare('PRAGMA table_info(files)').all()
          if (!columns.some((column) => column.name === 'folder_id')) {
            database.exec('ALTER TABLE files ADD COLUMN folder_id TEXT')
          }
          database.exec(`
            CREATE INDEX IF NOT EXISTS idx_files_owner_folder
              ON files(owner_id, folder_id, deleted_at, created_at DESC);
          `)
        },
      },
    ])
    const migrationResult = migrateLegacyJson({ db, dataDir })

    /**
     * ── 历史媒体分类修复 ────────────────────────────────────────────────────
     *
     * 旧版本会把「当前浏览的筛选分类」当成上传分类。例如在“文件”页拖入 MP3，
     * 记录就会被写成 file。现在上传已改为服务端自动判断，这里再用 user_version
     * 做一次性回填，修正升级前已经产生的错误分类。
     *
     * 只处理能明确识别为照片 / 视频 / 音乐的文件，不把普通文件强行改走。
     * user_version 确保只执行一次，之后通过 PATCH /api/files/:id 手动调整的分类会被保留。
     */
    const CATEGORY_NORMALIZATION_VERSION = 2

    function normalizeHistoricalMediaCategories() {
      const currentVersion = Number(db.prepare('PRAGMA user_version').get().user_version) || 0
      if (currentVersion >= CATEGORY_NORMALIZATION_VERSION) {
        return { fixed: 0, skipped: true }
      }

      const rows = db.prepare('SELECT id, name, category, mime FROM files').all()
      const update = db.prepare('UPDATE files SET category = ?, mime = ? WHERE id = ?')
      let fixed = 0

      db.exec('BEGIN')
      try {
        for (const row of rows) {
          const category = detectCategory(row.mime, row.name)
          const mime = inferMime(row.name, row.mime)
          const isSvg = mime === 'image/svg+xml'
          // 普通文件不强行改分类；SVG 例外，必须移出图片预览，避免主动内容 XSS
          if ((category !== 'file' || isSvg) && (category !== row.category || mime !== row.mime)) {
            update.run(category, mime, row.id)
            fixed += 1
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }

      db.exec(`PRAGMA user_version = ${CATEGORY_NORMALIZATION_VERSION}`)
      return { fixed, skipped: false }
    }

    const mediaCategoryFixResult = normalizeHistoricalMediaCategories()

    return { migrationResult, mediaCategoryFixResult }
  })().catch((error) => {
    try {
      if (db) db.close()
    } catch { /* 初始化失败时尽力关闭 */ }
    db = null
    runtimeInfo = null
    initializationPromise = null
    throw error
  })

  initializationPromise = initializationPromise.then((info) => {
    runtimeInfo = info
    return info
  })
  return initializationPromise
}

/** 把数据库里的原始行（snake_case）转成代码里用的对象（camelCase）。 */
export function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    salt: row.salt,
    passwordHash: row.password_hash,
    sessionVersion: Number(row.session_version) || 0,
    privacySalt: row.privacy_salt || null,
    privacyHash: row.privacy_hash || null,
    privacyVersion: Number(row.privacy_version) || 0,
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
    contentHash: row.content_hash || null,
    size: row.size,
    storedName: row.stored_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // NULL 表示正常文件；有时间值表示在回收站里
    deletedAt: row.deleted_at || null,
    isPrivate: Boolean(row.is_private),
    privateAt: row.private_at || null,
    folderId: row.folder_id || null,
  }
}

/** 把数据库中的文件夹行转换成 camelCase 对象。 */
export function mapFolder(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerId: row.owner_id,
    parentId: row.parent_id || null,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  }
}

/** 关闭数据库连接（进程退出时用，保证 WAL 内容合并回主文件）。 */
export function closeDb() {
  try {
    if (db) db.close()
  } catch {
    /* 已经关了，忽略 */
  } finally {
    db = null
    runtimeInfo = null
    initializationPromise = null
  }
}
