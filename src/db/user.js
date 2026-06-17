/**
 * 管理员用户 CRUD 模块
 */

import crypto from 'crypto'
import { getDb, saveDatabase } from './index.js'

/**
 * 密码哈希
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

/**
 * 初始化默认管理员（仅在无用户时创建）
 * @param {string} username 默认用户名
 * @param {string} password 默认密码
 */
export function initDefaultUser(username = 'admin', password = 'admin123') {
  const db = getDb()
  if (!db) return

  // 检查是否已有用户
  const result = db.exec('SELECT COUNT(*) FROM admin_users')
  const count = result[0]?.values[0]?.[0] || 0

  if (count === 0) {
    const passwordHash = hashPassword(password)
    db.run(
      'INSERT INTO admin_users (username, password_hash, display_name) VALUES (?, ?, ?)',
      [username, passwordHash, '管理员']
    )
    saveDatabase()
    console.log(`👤 创建默认管理员账号: ${username}`)
  }
}

/**
 * 验证用户登录
 * @param {string} username 用户名
 * @param {string} password 密码
 * @returns {Object|null} 用户对象（不含密码）或 null
 */
export function authenticateUser(username, password) {
  const db = getDb()
  if (!db) return null

  const passwordHash = hashPassword(password)

  const stmt = db.prepare('SELECT id, username, password_hash, display_name, created_at FROM admin_users WHERE username = ?')
  stmt.bind([username])

  if (stmt.step()) {
    const row = stmt.getAsObject()
    stmt.free()

    if (row.password_hash === passwordHash) {
      delete row.password_hash
      return row
    }
  } else {
    stmt.free()
  }

  return null
}

/**
 * 获取所有用户列表（不含密码）
 * @returns {Array} 用户列表
 */
export function listUsers() {
  const db = getDb()
  if (!db) return []

  const stmt = db.prepare('SELECT id, username, display_name, created_at FROM admin_users ORDER BY id')
  const results = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()
  return results
}

/**
 * 按 ID 获取用户
 * @param {number} id 用户 ID
 * @returns {Object|null} 用户对象（不含密码）
 */
export function getUserById(id) {
  const db = getDb()
  if (!db) return null

  const stmt = db.prepare('SELECT id, username, display_name, created_at FROM admin_users WHERE id = ?')
  stmt.bind([id])

  if (stmt.step()) {
    const row = stmt.getAsObject()
    stmt.free()
    return row
  }

  stmt.free()
  return null
}

/**
 * 创建新用户
 * @param {string} username 用户名
 * @param {string} password 密码
 * @param {string} displayName 显示名称
 * @returns {Object} { success: boolean, error?: string, user?: Object }
 */
export function createUser(username, password, displayName = '') {
  const db = getDb()
  if (!db) return { success: false, error: '数据库未初始化' }

  if (!username || !password) {
    return { success: false, error: '用户名和密码不能为空' }
  }

  if (username.length < 3) {
    return { success: false, error: '用户名至少3个字符' }
  }

  if (password.length < 6) {
    return { success: false, error: '密码至少6个字符' }
  }

  // 检查用户名是否已存在
  const existStmt = db.prepare('SELECT id FROM admin_users WHERE username = ?')
  existStmt.bind([username])
  if (existStmt.step()) {
    existStmt.free()
    return { success: false, error: '用户名已存在' }
  }
  existStmt.free()

  const passwordHash = hashPassword(password)
  db.run(
    'INSERT INTO admin_users (username, password_hash, display_name) VALUES (?, ?, ?)',
    [username, passwordHash, displayName || username]
  )
  saveDatabase()

  // 获取新创建的用户
  const result = db.exec('SELECT last_insert_rowid() as id')
  const id = result[0]?.values[0]?.[0]

  return { success: true, user: getUserById(id) }
}

/**
 * 更新用户信息
 * @param {number} id 用户 ID
 * @param {Object} updates 更新内容 { password?, displayName? }
 * @returns {Object} { success: boolean, error?: string }
 */
export function updateUser(id, updates = {}) {
  const db = getDb()
  if (!db) return { success: false, error: '数据库未初始化' }

  const user = getUserById(id)
  if (!user) return { success: false, error: '用户不存在' }

  if (updates.password) {
    if (updates.password.length < 6) {
      return { success: false, error: '密码至少6个字符' }
    }
    const passwordHash = hashPassword(updates.password)
    db.run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [passwordHash, id])
  }

  if (updates.displayName !== undefined) {
    db.run('UPDATE admin_users SET display_name = ? WHERE id = ?', [updates.displayName, id])
  }

  saveDatabase()
  return { success: true }
}

/**
 * 删除用户
 * @param {number} id 用户 ID
 * @returns {Object} { success: boolean, error?: string }
 */
export function deleteUser(id) {
  const db = getDb()
  if (!db) return { success: false, error: '数据库未初始化' }

  const user = getUserById(id)
  if (!user) return { success: false, error: '用户不存在' }

  db.run('DELETE FROM admin_users WHERE id = ?', [id])
  saveDatabase()

  return { success: true }
}
