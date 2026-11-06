/**
 * 将文件夹树以 ZIP 形式流式发送。
 *
 * ZIP 中央目录要求每个条目在写文件数据前就确定 CRC32 和大小，所以这里先顺序
 * 读取一遍文件计算 CRC，再以 store（不压缩）模式发送。代价是每个文件多读一次，
 * 但内存占用与目录总大小无关，适合大文件夹下载。实现遵循 ZIP32 上限：
 * 最多 65535 个条目、总大小不超过 4GiB；超出时在发送响应头前抛错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { UPLOAD_DIR } from './paths.js'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[n] = c >>> 0
}

/** 增量 CRC32；value 允许把上一次分块的中间结果带进来。 */
function crc32(buffer, value = 0) {
  let crc = (value ^ 0xffffffff) >>> 0
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 流式计算文件 CRC，避免将大文件整体读入内存。 */
async function fileCrc32(filePath) {
  let crc = 0
  for await (const chunk of fs.createReadStream(filePath)) crc = crc32(chunk, crc)
  return crc >>> 0
}

/** ZIP 是跨平台格式；清除路径分隔符和控制字符，防止条目逃逸或显示异常。 */
function zipName(value) {
  return String(value || '未命名')
    .replace(/[\\/:\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 180) || '未命名'
}

/** 转换为 ZIP 使用的 DOS 日期时间；ZIP 格式不支持 1980 年以前的时间。 */
function dosDateTime(dateValue) {
  const date = new Date(dateValue || Date.now())
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** 写入 30 字节本地文件头，UTF-8 文件名通过通用标志位 11 标记。 */
function localHeader(name, crc, size, date) {
  const nameBuffer = Buffer.from(name, 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(date.time, 10)
  header.writeUInt16LE(date.date, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(size, 18)
  header.writeUInt32LE(size, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBuffer])
}

/** 写入 46 字节中央目录项，并记录本地文件头相对 ZIP 起点的偏移。 */
function centralHeader(entry) {
  const nameBuffer = Buffer.from(entry.name, 'utf8')
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(entry.date.time, 12)
  header.writeUInt16LE(entry.date.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.size, 20)
  header.writeUInt32LE(entry.size, 24)
  header.writeUInt16LE(nameBuffer.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(entry.isDirectory ? 0x10 : 0, 38)
  header.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([header, nameBuffer])
}

/**
 * 写入响应并在内核缓冲区满时等待 drain。
 * state.offset 必须与实际写出的字节数同步，否则中央目录偏移会损坏。
 */
async function writeBuffer(res, buffer, state) {
  if (res.destroyed) throw new Error('下载连接已关闭')
  state.offset += buffer.length
  if (!res.write(buffer)) await new Promise((resolve) => res.once('drain', resolve))
}

export function folderDownloadName(folderName) {
  return `${zipName(folderName)}.zip`
}

/**
 * @param {import('node:http').ServerResponse} res HTTP 响应流
 * @param {{root:object,folders:object[],files:object[]}} tree 文件夹子树及其文件
 * @returns {Promise<void>}
 * @throws {Error & {status?:number,code?:string}} 条目或总大小超过 ZIP32 上限
 */
export async function streamFolderZip(res, tree) {
  const folderById = new Map(tree.folders.map((folder) => [folder.id, folder]))
  const folderPaths = new Map()

  const resolveFolderPath = (folder) => {
    if (folderPaths.has(folder.id)) return folderPaths.get(folder.id)
    const parent = folder.parentId ? folderById.get(folder.parentId) : null
    const prefix = parent ? resolveFolderPath(parent) : ''
    const value = `${prefix}${zipName(folder.name)}/`
    folderPaths.set(folder.id, value)
    return value
  }

  const entries = []
  for (const folder of tree.folders) {
    entries.push({ name: resolveFolderPath(folder), isDirectory: true, size: 0, crc: 0, date: dosDateTime(folder.createdAt) })
  }

  const usedNames = new Set(entries.map((entry) => entry.name.toLowerCase()))
  for (const record of tree.files) {
    const filePath = path.join(UPLOAD_DIR, record.ownerId, record.storedName)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      const base = `${folderPaths.get(record.folderId) || ''}${zipName(record.name)}`
      let name = base
      let suffix = 1
      while (usedNames.has(name.toLowerCase())) {
        const ext = path.extname(base)
        name = `${base.slice(0, base.length - ext.length)} (${suffix})${ext}`
        suffix += 1
      }
      usedNames.add(name.toLowerCase())
      entries.push({
        name,
        filePath,
        isDirectory: false,
        size: stat.size,
        crc: await fileCrc32(filePath),
        date: dosDateTime(record.updatedAt || record.createdAt),
      })
    } catch {
      // 文件在打包期间被删除时跳过，避免整个下载失败。
    }
  }

  const totalSize = entries.reduce((sum, entry) => sum + entry.size + 30 + Buffer.byteLength(entry.name) + 46 + Buffer.byteLength(entry.name), 0) + 22
  if (entries.length > 65535 || totalSize > 0xffffffff) {
    throw Object.assign(new Error('文件夹内容过大，暂不支持打包下载'), { status: 413, code: 'ZIP_TOO_LARGE' })
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(totalSize),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(folderDownloadName(tree.root.name))}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })

  const state = { offset: 0 }
  const centralEntries = []
  for (const entry of entries) {
    const localOffset = state.offset
    await writeBuffer(res, localHeader(entry.name, entry.crc, entry.size, entry.date), state)
    if (!entry.isDirectory) {
      for await (const chunk of fs.createReadStream(entry.filePath)) await writeBuffer(res, chunk, state)
    }
    centralEntries.push({ ...entry, offset: localOffset })
  }

  const centralOffset = state.offset
  for (const entry of centralEntries) await writeBuffer(res, centralHeader(entry), state)
  const centralSize = state.offset - centralOffset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centralEntries.length, 8)
  end.writeUInt16LE(centralEntries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  await writeBuffer(res, end, state)
  res.end()
}