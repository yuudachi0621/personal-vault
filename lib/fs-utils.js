import fs from 'node:fs'

/** 删除文件；不存在视为成功，其它文件系统错误返回 false。 */
export function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT')
  }
}