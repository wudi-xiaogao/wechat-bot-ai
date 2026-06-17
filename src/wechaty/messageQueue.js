/**
 * 按群串行发送队列
 *
 * 核心设计：
 * - 生成并发：多个 AI 回复可以同时生成（API 调用立即发起）
 * - 发送串行：同一个群/联系人的回复按入队顺序依次发送，保证对话顺序
 * - 跨群并发：不同群的队列独立运行，互不阻塞
 *
 * 运行参数均从 process.env 动态读取，支持热加载：
 * - TASK_EXPIRE_THRESHOLD: 队列任务过期时间（毫秒），默认 120000
 * - QUEUE_MAX_LENGTH: 单群最大队列长度，默认 10
 * - SEND_COOLDOWN: 两条消息间最小发送间隔（毫秒），默认 0
 * - RATE_LIMIT_WINDOW: 频率限制窗口（毫秒），默认 60000
 * - RATE_LIMIT_MAX: 窗口内最大回复数，默认 20
 */

import { logChat } from '../db/logger.js'

// ========== 运行参数（动态读取） ==========

function getExpireThreshold() { return parseInt(process.env.TASK_EXPIRE_THRESHOLD) || 120_000 }
function getQueueMaxLength() { return parseInt(process.env.QUEUE_MAX_LENGTH) || 10 }
function getSendCooldown() { return parseInt(process.env.SEND_COOLDOWN) || 0 }
function getRateLimitWindow() { return parseInt(process.env.RATE_LIMIT_WINDOW) || 60_000 }
function getRateLimitMax() { return parseInt(process.env.RATE_LIMIT_MAX) || 20 }

// ========== 队列状态 ==========

/**
 * @type {Map<string, {
 *   queue: Array<{
 *     promise: Promise<string>,
 *     target: Object,
 *     timestamp: number,
 *     originalContent: string
 *   }>,
 *   processing: boolean
 * }>}
 */
const groupQueues = new Map()

// 频率限制：记录每个 queueId 最近的发送时间戳
const rateLimitMap = new Map() // Map<queueId, Array<number>>

// ========== 核心函数 ==========

/**
 * 检查频率限制：在窗口内是否超过最大回复数
 * @param {string} queueId
 * @returns {boolean} true 表示允许发送，false 表示超限
 */
function checkRateLimit(queueId) {
  const window = getRateLimitWindow()
  const max = getRateLimitMax()
  const now = Date.now()

  if (!rateLimitMap.has(queueId)) {
    rateLimitMap.set(queueId, [])
  }

  const timestamps = rateLimitMap.get(queueId)
  // 清理窗口外的时间戳
  const validTimestamps = timestamps.filter(t => now - t < window)
  rateLimitMap.set(queueId, validTimestamps)

  if (validTimestamps.length >= max) {
    return false // 超限
  }
  return true
}

/**
 * 记录一次发送（用于频率限制计数）
 * @param {string} queueId
 */
function recordSend(queueId) {
  if (!rateLimitMap.has(queueId)) {
    rateLimitMap.set(queueId, [])
  }
  rateLimitMap.get(queueId).push(Date.now())
}

/**
 * 将发送任务入队
 *
 * 调用方应先发起 AI 生成（获取 Promise），再将 Promise 入队。
 * 队列会按顺序 await 每个 promise 并串行调用 target.say()。
 *
 * @param {string} queueId 队列标识（群ID或联系人ID）
 * @param {{
 *   promise: Promise<string>,
 *   target: Object,
 *   timestamp?: number,
 *   originalContent?: string,
 *   logInfo?: { roomId?: string, roomName?: string, userId?: string, userName?: string, messageType?: string }
 * }} task 发送任务
 */
export function enqueue(queueId, task) {
  if (!groupQueues.has(queueId)) {
    groupQueues.set(queueId, { queue: [], processing: false })
  }

  const state = groupQueues.get(queueId)
  const wasProcessing = state.processing
  const maxLen = getQueueMaxLength()

  // 队列长度限制：超出时丢弃最旧的任务
  if (state.queue.length >= maxLen) {
    const dropped = state.queue.shift()
    console.warn(`⚠️ 队列已满 [${queueId}]，丢弃最旧任务: "${dropped.originalContent.substring(0, 30)}"`)
  }

  state.queue.push({
    promise: task.promise,
    target: task.target,
    timestamp: task.timestamp || Date.now(),
    originalContent: task.originalContent || '',
    logInfo: task.logInfo, // 聊天记录信息
  })

  console.log(`📥 队列入队 [${queueId}]: 当前队列长度 ${state.queue.length}/${maxLen}`)

  // 只有该队列之前未在处理时，才启动处理循环
  // 如果正在处理中，while 循环自然会取到新加入的任务
  if (!wasProcessing) {
    state.processing = true
    processQueue(queueId).catch(e => console.error('❌ 队列处理异常:', e))
  }
}

/**
 * 串行处理某个队列
 *
 * 依次等待每个任务的 promise（生成结果），然后调用 target.say() 发送。
 * 单条失败不影响后续任务。
 *
 * @param {string} queueId 队列标识
 */
async function processQueue(queueId) {
  const state = groupQueues.get(queueId)
  if (!state) return

  while (state.queue.length > 0) {
    const task = state.queue.shift()

    try {
      // 检查任务是否过期
      const age = Date.now() - task.timestamp
      const expireThreshold = getExpireThreshold()
      if (age > expireThreshold) {
        console.warn(`⏭️ 队列跳过过期任务 [${queueId}]: 已等待 ${(age / 1000).toFixed(1)}秒, 内容: "${task.originalContent.substring(0, 50)}"`)
        continue
      }

      // 频率限制检查
      if (!checkRateLimit(queueId)) {
        console.warn(`🚫 频率限制 [${queueId}]: 窗口内回复数已达上限，丢弃: "${task.originalContent.substring(0, 30)}"`)
        continue
      }

      // 等待生成结果
      const reply = await task.promise

      if (reply) {
        // 串行发送
        await task.target.say(reply)
        recordSend(queueId)
        console.log(`📤 队列发送成功 [${queueId}]: "${task.originalContent.substring(0, 30)}..."`)

        // 记录聊天日志
        if (task.logInfo) {
          logChat({
            roomId: task.logInfo.roomId || queueId,
            roomName: task.logInfo.roomName || '',
            userId: task.logInfo.userId || '',
            userName: task.logInfo.userName || '',
            messageType: task.logInfo.messageType || 'text',
            content: task.originalContent,
            reply
          })
        }
      } else {
        console.warn(`⚠️ 队列跳过空回复 [${queueId}]: 内容: "${task.originalContent.substring(0, 30)}"`)
      }

      // 发送冷却
      const cooldown = getSendCooldown()
      if (cooldown > 0 && state.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, cooldown))
      }
    } catch (e) {
      console.error(`❌ 队列发送失败 [${queueId}]:`, e.message || e)
      // 继续处理下一条，不阻塞队列
    }
  }

  // 循环结束，标记为不在处理
  state.processing = false

  // 清理空队列，防止内存泄漏
  // 但需再次检查：在 await 期间可能有新任务入队
  if (state.queue.length === 0) {
    groupQueues.delete(queueId)
    rateLimitMap.delete(queueId) // 清理频率限制记录
  } else {
    // 有新任务入队，重新启动处理
    state.processing = true
    processQueue(queueId).catch(e => console.error('❌ 队列处理异常:', e))
  }
}

/**
 * 获取所有队列的状态（供管理后台查看）
 * @returns {Object} 队列统计信息
 */
export function getQueueStats() {
  const stats = {}
  const now = Date.now()
  const window = getRateLimitWindow()

  for (const [queueId, state] of groupQueues) {
    const timestamps = rateLimitMap.get(queueId) || []
    const recentSends = timestamps.filter(t => now - t < window).length

    stats[queueId] = {
      queueLength: state.queue.length,
      processing: state.processing,
      recentSends,
      rateLimitMax: getRateLimitMax(),
    }
  }
  return {
    totalQueues: groupQueues.size,
    queues: stats,
    config: {
      taskExpireThreshold: getExpireThreshold(),
      queueMaxLength: getQueueMaxLength(),
      sendCooldown: getSendCooldown(),
      rateLimitWindow: getRateLimitWindow(),
      rateLimitMax: getRateLimitMax(),
    }
  }
}
