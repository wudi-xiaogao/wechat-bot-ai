/**
 * 消息缓冲模块（debounce 合并）
 *
 * 核心设计：
 * - 同一用户（群+用户维度）在延迟窗口内的多条消息合并为一条
 * - 合并后的内容统一走意图识别，避免连续对话中每条消息都触发回复
 * - 定时器到期后调用 onFlush 回调，将合并内容交给下游处理
 *
 * 环境变量：
 * - MSG_MERGE_DELAY: 合并延迟时间（毫秒），默认 5000（5秒）
 */

// ========== 运行参数 ==========

function getMergeDelay() { return parseInt(process.env.MSG_MERGE_DELAY) || 5000 }

// ========== 缓冲区状态 ==========

/**
 * @type {Map<string, {
 *   messages: string[],
 *   timer: NodeJS.Timeout,
 *   meta: Object,
 *   onFlush: Function
 * }>}
 */
const bufferMap = new Map()

// 单个缓冲区最大消息数（防止恶意连发导致内存泄漏）
const MAX_MESSAGES_PER_BUFFER = 20

// ========== 核心函数 ==========

/**
 * 将消息加入缓冲区（debounce）
 *
 * - key 不存在：创建新条目，启动定时器
 * - key 已存在：追加消息，重置定时器
 * - 定时器到期：调用 onFlush(key, mergedContent, meta)，清空条目
 *
 * @param {string} key 缓冲区 key（建议格式：roomId_userId）
 * @param {string} content 消息内容
 * @param {Object} meta 上下文元数据（room, contact, isRoom 等），取第一条消息时的数据
 * @param {Function} onFlush 定时器到期回调 (key, mergedContent, meta) => void
 */
export function bufferMessage(key, content, meta, onFlush) {
  const delay = getMergeDelay()

  // 已有缓冲条目：追加消息，重置定时器
  if (bufferMap.has(key)) {
    const entry = bufferMap.get(key)
    entry.messages.push(content)
    entry.onFlush = onFlush // 始终更新为最新的 onFlush

    // 达到上限立即刷新，防止内存泄漏
    if (entry.messages.length >= MAX_MESSAGES_PER_BUFFER) {
      console.log(`📬 消息缓冲达上限 [${key}]: ${entry.messages.length} 条，立即刷新`)
      clearTimeout(entry.timer)
      flushEntry(key, entry.onFlush)
      return
    }

    // 重置定时器
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      flushEntry(key, entry.onFlush)
    }, delay)

    console.log(`📬 消息缓冲追加 [${key}]: 已缓冲 ${entry.messages.length} 条, 等待 ${delay}ms`)
    return
  }

  // 新建缓冲条目
  const timer = setTimeout(() => {
    flushEntry(key, onFlush)
  }, delay)

  bufferMap.set(key, {
    messages: [content],
    timer,
    meta,
    onFlush
  })

  console.log(`📬 消息缓冲开始 [${key}]: 等待 ${delay}ms`)
}

/**
 * 立即刷新指定 key（用于紧急场景）
 *
 * @param {string} key 缓冲区 key
 * @param {Function} onFlush 回调函数
 * @returns {boolean} 是否有缓冲数据被刷新
 */
export function flushNow(key, onFlush) {
  if (!bufferMap.has(key)) return false
  flushEntry(key, onFlush)
  return true
}

/**
 * 内部：刷新并清空指定缓冲条目
 */
function flushEntry(key, onFlush) {
  const entry = bufferMap.get(key)
  if (!entry) return

  // 清空条目（先删再回调，防止回调中再次缓冲时冲突）
  bufferMap.delete(key)

  const mergedContent = entry.messages.join('\n')
  const count = entry.messages.length

  if (count > 1) {
    console.log(`📬 消息缓冲合并 [${key}]: ${count} 条消息合并为一条`)
  }

  onFlush(key, mergedContent, entry.meta)
}

/**
 * 获取缓冲区状态（供管理后台查看）
 * @returns {Object} 缓冲区统计信息
 */
export function getBufferStats() {
  const stats = {}
  for (const [key, entry] of bufferMap) {
    stats[key] = {
      messageCount: entry.messages.length,
      messages: entry.messages.map(m => m.substring(0, 30)),
    }
  }
  return {
    totalKeys: bufferMap.size,
    mergeDelay: getMergeDelay(),
    buffers: stats,
  }
}
