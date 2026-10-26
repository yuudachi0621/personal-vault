/**
 * ============================================================================
 *  lib/paths.js —— 项目路径常量（单独放一个文件，避免模块之间循环依赖）
 * ============================================================================
 *
 * 【为什么要单独拆出来】
 *   数据库模块要读 data/，静态资源模块要读 public/，
 *   如果这些常量都放在 store.js 里，就会出现「store 引 db、db 又引 store」
 *   的循环依赖。ESM 虽然能处理，但初始化顺序很容易出坑。
 *   所以把「路径」这种最底层的东西单独放一层，谁都能引，谁也不依赖谁。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 项目根目录的绝对路径。
 * import.meta.url 是「当前文件自己的地址」，例如
 *   file:///opt/personal-vault/lib/paths.js
 * new URL('..', ...) 退回上一层 → file:///opt/personal-vault/
 * fileURLToPath 再转成系统真实路径。
 *
 * 好处：不管从哪个目录启动程序，路径都算得对。
 */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export const PUBLIC_DIR = path.join(ROOT, 'public')          // 前端文件
export const DATA_DIR = path.join(ROOT, 'data')              // 数据目录
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')     // 上传的文件本体

/** SQLite 数据库文件。所有账号和文件索引都在这里面。 */
export const DB_FILE = path.join(DATA_DIR, 'vault.db')
