/**
 * 对话历史管理器
 * LRU + TTL 策略，按 sessionId（群ID/联系人ID）隔离
 * 所有配置从 process.env 动态读取，支持热加载
 */

const sessions = new Map()
// key: sessionId
// value: { messages: Array<{role, content, timestamp}>, lastAccess: number }

// 清除对话的触发词
const CLEAR_KEYWORDS = ['清除对话', '清空对话', '重新开始', '重置对话', '新对话', '清除历史', '清空历史']

/**
 * 动态读取配置（每次调用时读取，支持热加载）
 */
function getConfig() {
  return {
    enabled: process.env.CONVERSATION_ENABLED === 'true',
    maxGroups: parseInt(process.env.CONVERSATION_MAX_GROUPS, 10) || 500,
    maxTurns: parseInt(process.env.CONVERSATION_MAX_TURNS, 10) || 10,
    ttlMs: (parseInt(process.env.CONVERSATION_TTL, 10) || 30) * 60 * 1000,
  }
}

/**
 * 判断消息是否为清除对话指令
 * @param {string} content - 消息内容
 * @returns {boolean}
 */
export function isClearCommand(content) {
  const trimmed = content.trim()
  return CLEAR_KEYWORDS.some(kw => trimmed === kw || trimmed === `/${kw}`)
}

/**
 * 淘汰最久未访问的会话（LRU）
 * @param {number} maxGroups - 最大会话数
 */
function evictLRU(maxGroups) {
  if (sessions.size < maxGroups) return
  let oldestKey = null
  let oldestAccess = Infinity
  for (const [key, session] of sessions) {
    if (session.lastAccess < oldestAccess) {
      oldestAccess = session.lastAccess
      oldestKey = key
    }
  }
  if (oldestKey) {
    sessions.delete(oldestKey)
  }
}

/**
 * 检查并清理过期会话
 * @param {string} sessionId
 * @param {number} ttlMs - 过期时间（毫秒）
 */
function checkExpiry(sessionId, ttlMs) {
  const session = sessions.get(sessionId)
  if (!session) return
  const now = Date.now()
  // 如果最后一条消息超过 TTL，整个会话过期
  if (now - session.lastAccess > ttlMs) {
    sessions.delete(sessionId)
  }
}

/**
 * 截断历史到最大轮数
 * 1轮 = 1条 user + 1条 assistant，从最旧的开始删除
 * @param {object} session
 * @param {number} maxTurns
 */
function trimToMaxTurns(session, maxTurns) {
  // maxTurns 是轮数，每轮2条消息，最多保留 maxTurns * 2 条
  const maxMessages = maxTurns * 2
  if (session.messages.length <= maxMessages) return
  // 删除最旧的消息，保持成对（user+assistant）
  const excess = session.messages.length - maxMessages
  session.messages.splice(0, excess)
}

/**
 * 获取会话历史
 * @param {string} sessionId - 群ID 或 联系人ID
 * @returns {Array<{role: string, content: string}>} 历史消息（不含 timestamp）
 */
export function getHistory(sessionId) {
  const config = getConfig()
  if (!config.enabled) return []

  checkExpiry(sessionId, config.ttlMs)

  const session = sessions.get(sessionId)
  if (!session) return []

  session.lastAccess = Date.now()

  // 返回不含 timestamp 的消息，符合 OpenAI messages 格式
  return session.messages.map(({ role, content }) => ({ role, content }))
}

/**
 * 添加用户消息到历史
 * @param {string} sessionId
 * @param {string} content - 用户消息内容
 */
export function addUserMessage(sessionId, content) {
  const config = getConfig()
  if (!config.enabled) return

  checkExpiry(sessionId, config.ttlMs)

  // 如果会话不存在，先淘汰 LRU
  if (!sessions.has(sessionId)) {
    evictLRU(config.maxGroups)
  }

  let session = sessions.get(sessionId)
  if (!session) {
    session = { messages: [], lastAccess: Date.now() }
    sessions.set(sessionId, session)
  }

  session.messages.push({
    role: 'user',
    content,
    timestamp: Date.now(),
  })
  session.lastAccess = Date.now()

  trimToMaxTurns(session, config.maxTurns)
}

/**
 * 添加助手消息到历史
 * @param {string} sessionId
 * @param {string} content - 助手回复内容
 */
export function addAssistantMessage(sessionId, content) {
  const config = getConfig()
  if (!config.enabled) return

  const session = sessions.get(sessionId)
  // 如果没有会话记录（可能已过期或未初始化），跳过
  if (!session) return

  session.messages.push({
    role: 'assistant',
    content,
    timestamp: Date.now(),
  })
  session.lastAccess = Date.now()

  trimToMaxTurns(session, config.maxTurns)
}

/**
 * 清除指定会话的历史
 * @param {string} sessionId
 */
export function clearHistory(sessionId) {
  sessions.delete(sessionId)
}

/**
 * 获取对话历史统计信息
 * @returns {object}
 */
export function getConversationStats() {
  const config = getConfig()
  let totalMessages = 0
  for (const session of sessions.values()) {
    totalMessages += session.messages.length
  }
  return {
    enabled: config.enabled,
    activeSessions: sessions.size,
    maxGroups: config.maxGroups,
    maxTurns: config.maxTurns,
    ttlMinutes: config.ttlMs / 60000,
    totalMessages,
  }
}
