import fs from 'node:fs'
import path from 'node:path'

function readLegacyArray(filePath, label) {
  if (!fs.existsSync(filePath)) return null

  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`旧数据文件 ${label} 读取失败（${error.code || 'UNKNOWN'}），已停止迁移`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 不回显解析错误原文，避免把文件内容片段写入日志。
    throw new Error(`旧数据文件 ${label} 不是有效 JSON，已停止迁移`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`旧数据文件 ${label} 必须是数组，已停止迁移`)
  }
  return parsed
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function isSafePathSegment(value) {
  const text = String(value)
  return text !== '.' && text !== '..'
    && !text.includes('/') && !text.includes('\\') && !text.includes('\0')
}

function validateLegacyData(legacyUsers, legacyFiles) {
  const ownerIds = new Set()

  for (let index = 0; index < legacyUsers.length; index += 1) {
    const user = legacyUsers[index]
    if (!user || typeof user !== 'object' || !hasValue(user.id) || !hasValue(user.email)) {
      throw new Error(`users.json 第 ${index + 1} 条记录缺少 id 或 email，已停止迁移`)
    }
    const id = String(user.id)
    if (!isSafePathSegment(id)) {
      throw new Error(`users.json 第 ${index + 1} 条记录的 id 不安全，已停止迁移`)
    }
    if (ownerIds.has(id)) {
      throw new Error('users.json 存在重复用户 id，已停止迁移')
    }
    ownerIds.add(id)
  }

  for (let index = 0; index < legacyFiles.length; index += 1) {
    const file = legacyFiles[index]
    if (!file || typeof file !== 'object' || !hasValue(file.id) || !hasValue(file.ownerId) || !hasValue(file.storedName)) {
      throw new Error(`files.json 第 ${index + 1} 条记录缺少 id、ownerId 或 storedName，已停止迁移`)
    }
    const ownerId = String(file.ownerId)
    if (!isSafePathSegment(ownerId)) {
      throw new Error(`files.json 第 ${index + 1} 条记录的 ownerId 不安全，已停止迁移`)
    }
    if (!ownerIds.has(ownerId)) {
      throw new Error(`files.json 第 ${index + 1} 条记录引用了不存在的用户，已停止迁移`)
    }
    const storedName = String(file.storedName)
    if (!isSafePathSegment(storedName)) {
      throw new Error(`files.json 第 ${index + 1} 条记录的 storedName 不安全，已停止迁移`)
    }
    const size = Number(file.size)
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`files.json 第 ${index + 1} 条记录的 size 无效，已停止迁移`)
    }
  }
}

function backupLegacyFiles(sources) {
  const warnings = []
  for (const [sourcePath, label] of sources) {
    if (!fs.existsSync(sourcePath)) continue
    const backupPath = `${sourcePath}.migrated`

    try {
      // COPYFILE_EXCL 保证任何已有备份都不会被覆盖。
      fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      warnings.push(`旧数据文件 ${label} 未能备份为 ${path.basename(backupPath)}（${error.code || 'UNKNOWN'}），原文件已保留`)
      continue
    }

    try {
      fs.unlinkSync(sourcePath)
    } catch (error) {
      warnings.push(`旧数据文件 ${label} 已备份，但原文件清理失败（${error.code || 'UNKNOWN'}）`)
    }
  }
  return warnings
}

/**
 * 把旧 JSON 数据迁移到空 SQLite 数据库。
 *
 * 迁移前严格校验数据；任何损坏、结构错误或 owner 引用错误都会中止迁移。
 * 数据库事务成功后才复制备份，备份文件绝不覆盖已有文件。
 *
 * @param {{db: import('node:sqlite').DatabaseSync, dataDir: string}} options
 * @returns {{users: number, files: number, skipped: boolean, warnings: string[]}}
 */
export function migrateLegacyJson({ db, dataDir }) {
  const existingUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  const existingFiles = db.prepare('SELECT COUNT(*) AS n FROM files').get().n
  if (existingUsers > 0 || existingFiles > 0) {
    return { users: 0, files: 0, skipped: true, warnings: [] }
  }

  const usersPath = path.join(dataDir, 'users.json')
  const filesPath = path.join(dataDir, 'files.json')
  const legacyUsers = readLegacyArray(usersPath, 'users.json')
  const legacyFiles = readLegacyArray(filesPath, 'files.json')

  if (legacyUsers === null && legacyFiles === null) {
    return { users: 0, files: 0, skipped: true, warnings: [] }
  }
  if (legacyUsers === null && legacyFiles.length > 0) {
    throw new Error('检测到 files.json，但 users.json 缺失，已停止迁移')
  }

  const users = legacyUsers || []
  const files = legacyFiles || []
  if (!users.length && !files.length) {
    return { users: 0, files: 0, skipped: true, warnings: [] }
  }

  validateLegacyData(users, files)

  const insertUser = db.prepare(`
    INSERT INTO users (id, email, nickname, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertFile = db.prepare(`
    INSERT INTO files
      (id, owner_id, name, category, mime, size, stored_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let importedUsers = 0
  let importedFiles = 0

  db.exec('BEGIN')
  try {
    for (const user of users) {
      insertUser.run(
        String(user.id),
        String(user.email),
        String(user.nickname || String(user.email).split('@')[0]),
        String(user.salt || ''),
        String(user.passwordHash || ''),
        String(user.createdAt || new Date().toISOString()),
      )
      importedUsers += 1
    }

    for (const file of files) {
      insertFile.run(
        String(file.id),
        String(file.ownerId),
        String(file.name || '未命名文件'),
        String(file.category || 'file'),
        String(file.mime || 'application/octet-stream'),
        Number(file.size),
        String(file.storedName),
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

  const warnings = backupLegacyFiles([
    [usersPath, 'users.json'],
    [filesPath, 'files.json'],
  ])

  return { users: importedUsers, files: importedFiles, skipped: false, warnings }
}