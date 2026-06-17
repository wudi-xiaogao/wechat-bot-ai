/**
 * 会话状态管理
 * 用于追踪用户是否在对话中，实现连续对话
 */

// 会话状态 Map<roomId_userId, { lastQuestionTime, lastQuestion, replyCount }>
const sessionMap = new Map()

// 会话超时时间（毫秒）- 5分钟内视为同一对话
const SESSION_TIMEOUT = 5 * 60 * 1000

// 最大对话轮数
const MAX_CONVERSATION_TURNS = 10

/**
 * 生成会话 key
 */
function getSessionKey(roomId, userId) {
  return `${roomId}_${userId}`
}

/**
 * 检查用户是否在对话中
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @returns {boolean} 是否在对话中
 */
export function isInConversation(roomId, userId) {
  const key = getSessionKey(roomId, userId)
  const session = sessionMap.get(key)

  if (!session) return false

  // 检查是否超时
  if (Date.now() - session.lastQuestionTime > SESSION_TIMEOUT) {
    sessionMap.delete(key)
    return false
  }

  return true
}

/**
 * 获取用户最近的提问
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @returns {string|null} 最近的问题
 */
export function getLastQuestion(roomId, userId) {
  const key = getSessionKey(roomId, userId)
  const session = sessionMap.get(key)
  return session?.lastQuestion || null
}

/**
 * 获取对话历史（用于构建 RAG history）
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @returns {Array<{role: string, content: string}>} 对话历史
 */
export function getConversationHistory(roomId, userId) {
  const key = getSessionKey(roomId, userId)
  const session = sessionMap.get(key)

  if (!session || !session.history) return []

  return session.history
}

/**
 * 开始新对话（用户提问）
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @param {string} question 问题内容
 */
export function startConversation(roomId, userId, question) {
  const key = getSessionKey(roomId, userId)

  sessionMap.set(key, {
    lastQuestionTime: Date.now(),
    lastQuestion: question,
    replyCount: 1,
    history: [
      { role: 'user', content: question }
    ]
  })

  console.log(`🎭 开始新对话 [${key}]: "${question.substring(0, 30)}"`)
}

/**
 * 记录机器人回复
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @param {string} reply 回复内容
 */
export function recordReply(roomId, userId, reply) {
  const key = getSessionKey(roomId, userId)
  const session = sessionMap.get(key)

  if (!session) return

  session.history.push({ role: 'assistant', content: reply })
  session.lastQuestionTime = Date.now()

  // 限制历史长度
  if (session.history.length > MAX_CONVERSATION_TURNS * 2) {
    // 保留最近 N 轮对话（每轮 2 条消息）
    session.history = session.history.slice(-MAX_CONVERSATION_TURNS * 2)
  }
}

/**
 * 追加用户补充信息（连续对话）
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 * @param {string} content 补充内容
 */
export function appendUserMessage(roomId, userId, content) {
  const key = getSessionKey(roomId, userId)
  const session = sessionMap.get(key)

  if (!session) {
    // 没有对话记录，创建新的
    startConversation(roomId, userId, content)
    return
  }

  session.history.push({ role: 'user', content })
  session.lastQuestion = content
  session.lastQuestionTime = Date.now()
  session.replyCount++

  console.log(`📝 追加对话 [${key}]: "${content.substring(0, 30)}"`)
}

/**
 * 结束对话
 * @param {string} roomId 群ID
 * @param {string} userId 用户ID
 */
export function endConversation(roomId, userId) {
  const key = getSessionKey(roomId, userId)
  sessionMap.delete(key)
  console.log(`🔚 结束对话 [${key}]`)
}

/**
 * 清理过期会话
 */
export function cleanExpiredSessions() {
  const now = Date.now()
  let cleaned = 0

  for (const [key, session] of sessionMap) {
    if (now - session.lastQuestionTime > SESSION_TIMEOUT) {
      sessionMap.delete(key)
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 清理了 ${cleaned} 个过期会话`)
  }
}

// 定期清理过期会话（每分钟）
setInterval(cleanExpiredSessions, 60 * 1000)
