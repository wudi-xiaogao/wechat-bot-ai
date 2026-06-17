/**
 * 配置热加载模块
 * 支持 config.js 配置实时生效，无需重启
 */
import fs from 'fs'
import path from 'path'

// 配置文件路径
const configPath = path.join(process.cwd(), 'config.js')

// 配置缓存（带时间戳）
let configCache = null
let cacheTime = 0
const CACHE_TTL = 1000 // 缓存1秒，避免频繁读取文件

/**
 * 解析配置文件内容
 * @param {string} content 配置文件内容
 * @returns {object} 解析后的配置对象
 */
function parseConfig(content) {
  const parseArray = (str) => {
    if (!str) return []
    return str.split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(s => s)
  }

  const botNameMatch = content.match(/export const botName = ['"](.+?)['"]/)
  const roomWhiteListMatch = content.match(/export const roomWhiteList = \[(.+?)\]/s)
  const aliasWhiteListMatch = content.match(/export const aliasWhiteList = \[(.+?)\]/s)
  const questionKeywordsMatch = content.match(/export const questionKeywords = \[(.+?)\]/s)
  const intentModelMatch = content.match(/export const intentModel = ['"](.+?)['"]/)

  return {
    botName: botNameMatch ? botNameMatch[1] : '',
    roomWhiteList: roomWhiteListMatch ? parseArray(roomWhiteListMatch[1]) : [],
    aliasWhiteList: aliasWhiteListMatch ? parseArray(aliasWhiteListMatch[1]) : [],
    questionKeywords: questionKeywordsMatch ? parseArray(questionKeywordsMatch[1]) : [],
    intentModel: intentModelMatch ? intentModelMatch[1] : 'deepseek-v4-flash',
  }
}

/**
 * 获取当前配置（支持热加载）
 * @returns {object} 配置对象
 */
export function getConfig() {
  const now = Date.now()

  // 缓存有效期内直接返回
  if (configCache && (now - cacheTime) < CACHE_TTL) {
    return configCache
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    configCache = parseConfig(content)
    cacheTime = now
    return configCache
  } catch (e) {
    console.error('❌ 读取配置文件失败:', e.message)
    // 返回缓存或空配置
    return configCache || {
      botName: '',
      roomWhiteList: [],
      aliasWhiteList: [],
      questionKeywords: [],
      intentModel: 'deepseek-v4-flash',
    }
  }
}

/**
 * 清除配置缓存（配置更新后调用）
 */
export function clearConfigCache() {
  configCache = null
  cacheTime = 0
  console.log('🔄 配置缓存已清除，下次读取将重新加载')
}

/**
 * 获取机器人名称
 */
export function getBotName() {
  return getConfig().botName
}

/**
 * 获取群聊白名单
 */
export function getRoomWhiteList() {
  return getConfig().roomWhiteList
}

/**
 * 获取联系人白名单
 */
export function getAliasWhiteList() {
  return getConfig().aliasWhiteList
}

/**
 * 获取问题关键词
 */
export function getQuestionKeywords() {
  return getConfig().questionKeywords
}

/**
 * 获取意图识别模型
 */
export function getIntentModel() {
  return getConfig().intentModel
}
