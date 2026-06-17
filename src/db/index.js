/**
 * 数据库初始化模块
 * 使用 sql.js (纯 JavaScript SQLite，无需编译原生模块)
 *
 * 优先使用 asm.js 版本（无需 wasm 文件），Docker 部署零配置
 */

import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'

// 数据库文件路径
const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DATA_DIR, 'chat_logs.db')

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

let db = null
let saveTimer = null

/**
 * 初始化数据库
 */
export async function initDatabase() {
  // 使用 asm.js 版本（无需 wasm 文件，兼容性更好）
  const SQL = await initSqlJs({
    locateFile: (file) => {
      // 优先使用 asm.js 版本（纯 JS，不依赖 wasm 文件）
      if (file.endsWith('.wasm')) {
        return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file)
      }
      return file
    }
  })

  // 尝试加载现有数据库
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
    console.log('✅ 数据库加载成功:', DB_PATH)
  } else {
    db = new SQL.Database()
    console.log('✅ 数据库创建成功:', DB_PATH)
  }

  // 创建表
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      room_name TEXT,
      user_id TEXT NOT NULL,
      user_name TEXT,
      message_type TEXT DEFAULT 'text',
      content TEXT NOT NULL,
      reply TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 创建索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_room_id ON chat_logs(room_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON chat_logs(created_at)`)

  // 创建管理员用户表
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 保存到文件
  saveDatabase()

  return db
}

/**
 * 保存数据库到文件（防抖，避免频繁写入）
 */
export function saveDatabase() {
  if (!db) return

  // 清除之前的定时器
  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  // 延迟 1 秒写入，合并多次变更
  saveTimer = setTimeout(() => {
    try {
      const data = db.export()
      const buffer = Buffer.from(data)
      fs.writeFileSync(DB_PATH, buffer)
    } catch (e) {
      console.error('❌ 数据库保存失败:', e)
    }
    saveTimer = null
  }, 1000)
}

/**
 * 立即保存数据库到文件（用于进程退出前）
 */
function saveDatabaseSync() {
  if (!db) return
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(DB_PATH, buffer)
  } catch (e) {
    console.error('❌ 数据库同步保存失败:', e)
  }
}

/**
 * 获取数据库实例
 */
export function getDb() {
  return db
}

// 定期保存数据库（每60秒）
setInterval(() => {
  saveDatabase()
}, 60000)

// 进程退出时保存
process.on('exit', () => {
  saveDatabaseSync()
})

process.on('SIGINT', () => {
  saveDatabaseSync()
  process.exit(0)
})

process.on('SIGTERM', () => {
  saveDatabaseSync()
  process.exit(0)
})
