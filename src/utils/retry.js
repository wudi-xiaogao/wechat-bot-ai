/**
 * API 调用重试工具
 *
 * 特性：
 * - 支持配置最大重试次数
 * - 支持配置重试延迟（指数退避）
 * - 区分可重试错误（超时、网络错误）和不可重试错误（认证、参数错误）
 * - 重试全部失败后返回 null（调用方决定是否回复）
 */

import dotenv from 'dotenv'
dotenv.config({ override: false })

const env = process.env

// 默认配置
const DEFAULT_MAX_RETRIES = parseInt(env.API_MAX_RETRIES) || 2
const DEFAULT_RETRY_DELAY = parseInt(env.API_RETRY_DELAY) || 1000  // 基础延迟 ms
const DEFAULT_RETRY_MULTIPLIER = parseFloat(env.API_RETRY_MULTIPLIER) || 2  // 指数退避倍数

/**
 * 判断错误是否可重试
 * @param {Error} error 错误对象
 * @returns {boolean} 是否可重试
 */
function isRetryableError(error) {
  // 超时错误
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return true
  }

  // 网络错误
  if (error.code === 'ECONNRESET' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN' ||
      error.code === 'EHOSTUNREACH') {
    return true
  }

  // Socket 错误
  if (error.message?.includes('socket hang up') ||
      error.message?.includes('ECONNRESET') ||
      error.message?.includes('network')) {
    return true
  }

  // HTTP 状态码判断
  if (error.response?.status) {
    const status = error.response.status
    // 5xx 服务器错误可重试
    if (status >= 500 && status < 600) {
      return true
    }
    // 429 限流可重试
    if (status === 429) {
      return true
    }
    // 401/403 认证错误不重试
    if (status === 401 || status === 403) {
      return false
    }
    // 400/404 等客户端错误不重试
    if (status >= 400 && status < 500) {
      return false
    }
  }

  // 默认：未知错误可重试
  return true
}

/**
 * 计算重试延迟（指数退避）
 * @param {number} attempt 当前尝试次数（从 0 开始）
 * @param {number} baseDelay 基础延迟 ms
 * @param {number} multiplier 倍数
 * @returns {number} 延迟时间 ms
 */
function calculateDelay(attempt, baseDelay, multiplier) {
  // 基础延迟 * 倍数^尝试次数，加随机抖动（0-20%）
  const delay = baseDelay * Math.pow(multiplier, attempt)
  const jitter = delay * (Math.random() * 0.2)
  return Math.floor(delay + jitter)
}

/**
 * 延迟函数
 * @param {number} ms 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带重试的 API 调用包装器
 *
 * @param {Function} fn 要执行的异步函数
 * @param {Object} options 配置选项
 * @param {number} options.maxRetries 最大重试次数（默认从环境变量读取，或 2）
 * @param {number} options.retryDelay 基础重试延迟 ms（默认从环境变量读取，或 1000）
 * @param {number} options.retryMultiplier 指数退避倍数（默认从环境变量读取，或 2）
 * @param {string} options.name 调用名称（用于日志）
 * @returns {Promise<{success: boolean, data: any, error: Error|null, attempts: number}>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
    retryMultiplier = DEFAULT_RETRY_MULTIPLIER,
    name = 'API',
  } = options

  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()

      if (attempt > 0) {
        console.log(`✅ ${name} 重试成功 (第 ${attempt} 次重试)`)
      }

      return {
        success: true,
        data: result,
        error: null,
        attempts: attempt + 1,
      }
    } catch (error) {
      lastError = error

      // 判断是否可重试
      const retryable = isRetryableError(error)

      if (!retryable) {
        console.error(`❌ ${name} 遇到不可重试错误:`, error.message)
        return {
          success: false,
          data: null,
          error,
          attempts: attempt + 1,
        }
      }

      // 还有重试机会
      if (attempt < maxRetries) {
        const delay = calculateDelay(attempt, retryDelay, retryMultiplier)
        console.warn(`⚠️ ${name} 调用失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error.message}`)
        console.log(`🔄 将在 ${delay}ms 后重试...`)
        await sleep(delay)
      } else {
        // 所有重试都失败
        console.error(`❌ ${name} 重试 ${maxRetries} 次后仍然失败:`, error.message)
      }
    }
  }

  return {
    success: false,
    data: null,
    error: lastError,
    attempts: maxRetries + 1,
  }
}

/**
 * 简化版：带重试的 API 调用，失败返回 null
 *
 * @param {Function} fn 要执行的异步函数
 * @param {Object} options 配置选项（同 withRetry）
 * @returns {Promise<any|null>} 成功返回数据，失败返回 null
 */
export async function retryOrNull(fn, options = {}) {
  const result = await withRetry(fn, options)
  return result.success ? result.data : null
}
