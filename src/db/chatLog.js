/**
 * 聊天记录 CRUD 模块
 */

import { getDb, saveDatabase } from './index.js'

/**
 * 执行带参数的查询，返回对象数组
 * sql.js 的 db.exec() 不支持参数绑定，需用 prepare + bind + step
 * @param {string} sql SQL 语句
 * @param {Array} params 参数数组
 * @returns {Array<Object>} 查询结果
 */
function queryAll(sql, params = []) {
  const db = getDb()
  if (!db) return []

  const stmt = db.prepare(sql)
  if (params.length > 0) stmt.bind(params)

  const results = []
  while (stmt.step()) {
    results.push(stmt.getAsObject())
  }
  stmt.free()
  return results
}

/**
 * 执行带参数的查询，返回单条结果的第一个字段
 * @param {string} sql SQL 语句
 * @param {Array} params 参数数组
 * @returns {*} 单个值
 */
function queryScalar(sql, params = []) {
  const rows = queryAll(sql, params)
  return rows[0] ? Object.values(rows[0])[0] : 0
}

/**
 * 插入聊天记录
 * @param {Object} params
 * @param {string} params.room_id 群ID
 * @param {string} params.room_name 群名称
 * @param {string} params.user_id 用户ID
 * @param {string} params.user_name 用户昵称
 * @param {string} params.message_type 消息类型
 * @param {string} params.content 消息内容
 * @param {string} params.reply 机器人回复
 * @returns {number} 插入的记录ID
 */
export function insertChatLog(params) {
  const db = getDb()
  if (!db) {
    console.error('数据库未初始化')
    return null
  }

  const { room_id, room_name, user_id, user_name, message_type = 'text', content, reply } = params

  const created_at = new Date().toISOString().replace('T', ' ').substring(0, 19)

  db.run(
    `INSERT INTO chat_logs (room_id, room_name, user_id, user_name, message_type, content, reply, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [room_id, room_name, user_id, user_name, message_type, content, reply, created_at]
  )

  // 获取最后插入的ID
  const result = db.exec('SELECT last_insert_rowid() as id')
  const id = result[0]?.values[0]?.[0]

  // 保存到文件
  saveDatabase()

  return id
}

/**
 * 查询聊天记录
 * @param {Object} options
 * @param {string} options.startDate 开始日期 YYYY-MM-DD
 * @param {string} options.endDate 结束日期 YYYY-MM-DD
 * @param {string} options.roomId 群ID（可选）
 * @param {string} options.roomName 群名称（可选，模糊匹配）
 * @param {string} options.keyword 关键字（可选，模糊搜索）
 * @param {number} options.page 页码（从1开始）
 * @param {number} options.pageSize 每页条数
 * @returns {Object} { list: Array, total: number, page: number, pageSize: number }
 */
export function queryChatLogs(options = {}) {
  const db = getDb()
  if (!db) {
    return { list: [], total: 0, page: 1, pageSize: 50 }
  }

  const {
    startDate,
    endDate,
    roomId,
    roomName,
    keyword,
    page = 1,
    pageSize = 50
  } = options

  const offset = (page - 1) * pageSize

  // 构建查询条件
  const conditions = []
  const params = []

  // 时间范围
  if (startDate) {
    conditions.push('created_at >= ?')
    params.push(`${startDate} 00:00:00`)
  }
  if (endDate) {
    conditions.push('created_at <= ?')
    params.push(`${endDate} 23:59:59`)
  }

  // 群ID
  if (roomId) {
    conditions.push('room_id = ?')
    params.push(roomId)
  }

  // 群名称（模糊匹配）
  if (roomName) {
    conditions.push('room_name LIKE ?')
    params.push(`%${roomName}%`)
  }

  // 关键字搜索
  if (keyword && keyword.trim()) {
    conditions.push('(content LIKE ? OR reply LIKE ?)')
    params.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 查询总数
  const countSQL = `SELECT COUNT(*) as total FROM chat_logs ${whereClause}`
  const total = queryScalar(countSQL, params)

  // 查询数据
  const dataSQL = `
    SELECT * FROM chat_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `
  const list = queryAll(dataSQL, [...params, pageSize, offset])

  return { list, total, page, pageSize }
}

/**
 * 获取所有群列表（去重）
 * @returns {Array} 群列表 [{ room_id, room_name, count, last_message_at }]
 */
export function getRoomList() {
  const db = getDb()
  if (!db) return []

  const sql = `
    SELECT
      room_id,
      room_name,
      COUNT(*) as count,
      MAX(created_at) as last_message_at
    FROM chat_logs
    GROUP BY room_id
    ORDER BY last_message_at DESC
  `

  return queryAll(sql)
}

/**
 * 删除单条聊天记录
 * @param {number} id 记录ID
 * @returns {boolean} 是否删除成功
 */
export function deleteChatLog(id) {
  const db = getDb()
  if (!db) return false

  db.run('DELETE FROM chat_logs WHERE id = ?', [id])
  saveDatabase()

  // 检查是否删除成功
  const result = db.exec('SELECT changes()')
  const changes = result[0]?.values[0]?.[0] || 0
  return changes > 0
}

/**
 * 删除指定时间之前的聊天记录（数据清理）
 * @param {number} days 保留最近多少天
 * @returns {number} 删除的记录数
 */
export function cleanOldLogs(days = 30) {
  const db = getDb()
  if (!db) return 0

  const date = new Date()
  date.setDate(date.getDate() - days)
  const beforeDate = date.toISOString().replace('T', ' ').substring(0, 19)

  db.run('DELETE FROM chat_logs WHERE created_at < ?', [beforeDate])

  const result = db.exec('SELECT changes()')
  const changes = result[0]?.values[0]?.[0] || 0

  saveDatabase()
  console.log(`🧹 清理了 ${changes} 条 ${days} 天前的聊天记录`)

  return changes
}

/**
 * 获取统计数据
 * @returns {Object} { totalMessages, totalRooms, todayMessages }
 */
export function getStats() {
  const db = getDb()
  if (!db) {
    return { totalMessages: 0, totalRooms: 0, todayMessages: 0 }
  }

  const today = new Date().toISOString().substring(0, 10)

  const totalMessages = queryScalar('SELECT COUNT(*) FROM chat_logs')
  const totalRooms = queryScalar('SELECT COUNT(DISTINCT room_id) FROM chat_logs')
  const todayMessages = queryScalar('SELECT COUNT(*) FROM chat_logs WHERE created_at >= ?', [`${today} 00:00:00`])

  return { totalMessages, totalRooms, todayMessages }
}
