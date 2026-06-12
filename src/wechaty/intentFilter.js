/**
 * 关键字 + AI 意图识别过滤器
 *
 * 两层过滤策略：
 * 1. 关键字匹配（免费、同步）—— 命中则直接视为提问，跳过 AI 检查
 * 2. AI 意图识别（异步、低成本）—— 关键字未命中时调用轻量模型判断
 */

import { classifyIntent } from '../openai/index.js'

// ========== 默认问题关键词 ==========

const DEFAULT_QUESTION_KEYWORDS = [
  // 疑问词
  '怎么', '如何', '为什么', '为啥', '吗', '？', '?',
  '能不能', '可不可以', '可以吗', '好不好',
  // 求助
  '帮忙', '帮助', '请问', '什么', '哪个', '哪里',
  '多少', '几点', '什么时候', '怎么办', '怎样', '咋',
  // 能力/意愿
  '能否', '是否', '有没有', '是不是',
  // 否定/困难
  '不行', '无法', '不能', '不会', '不懂', '不明白', '不清楚',
  // 问题/故障
  '失败', '报错', '错误', '问题', '故障', '异常', '出错', '坏了',
  // 具体操作困难
  '登不上', '连不上', '打不开', '找不到', '看不到', '收不到', '发不了', '用不了',
  '怎么弄', '怎么搞', '咋弄', '咋搞',
]

// ========== 关键字正则缓存 ==========

let cachedKeywordsKey = null
let cachedRegex = null

/**
 * 构建关键词正则表达式（带缓存）
 * 使用数组内容拼接的字符串作为缓存 key，支持配置热更新
 * @param {string[]} keywords 关键词列表
 * @returns {RegExp} 匹配任一关键词的正则
 */
function buildKeywordRegex(keywords) {
  const key = keywords.join('|')
  if (cachedKeywordsKey === key && cachedRegex) {
    return cachedRegex
  }
  // 转义每个关键词中的正则特殊字符，再用 | 连接
  const parts = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  cachedKeywordsKey = key
  cachedRegex = new RegExp(`(${parts.join('|')})`, 'i')
  return cachedRegex
}

/**
 * 关键字匹配（同步、免费）
 * @param {string} content 消息内容
 * @param {string[]} keywords 关键词列表
 * @returns {boolean} 是否命中关键词
 */
export function matchKeywords(content, keywords = DEFAULT_QUESTION_KEYWORDS) {
  if (!content || content.trim().length === 0) return false
  const regex = buildKeywordRegex(keywords)
  return regex.test(content)
}

/**
 * 判断消息是否应该触发自动回复
 *
 * 流程：关键字优先 → AI 意图兜底
 * - 关键字命中：直接返回 true，不调用 AI（节省 API 调用）
 * - 关键字未命中：调用 AI 意图识别
 * - 未配置关键词（空数组）：跳过关键字检查，直接走 AI 意图识别
 * - AI 识别失败：fail-open，返回 true（避免遗漏真实提问）
 *
 * @param {string} content 消息内容
 * @param {string[]} keywords 关键词列表（空数组则跳过关键字检查，直接走AI意图识别）
 * @returns {Promise<boolean>} 是否应该回复
 */
export async function shouldReply(content, keywords = DEFAULT_QUESTION_KEYWORDS) {
  // 第一层：关键字匹配（仅在有关键词时执行）
  if (keywords && keywords.length > 0) {
    if (matchKeywords(content, keywords)) {
      console.log('🎯 意图过滤: 关键字命中，直接回复')
      return true
    }
  }

  // 第二层：AI 意图识别（关键字未命中或未配置关键词时执行）
  console.log('🧠 意图过滤: 调用 AI 意图识别...')
  return await classifyIntent(content)
}

/**
 * 获取默认关键词列表（供配置使用）
 * @returns {string[]} 默认关键词列表
 */
export function getDefaultKeywords() {
  return [...DEFAULT_QUESTION_KEYWORDS]
}
