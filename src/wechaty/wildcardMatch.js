/**
 * 通配符匹配工具
 * 支持群名称白名单的模糊匹配
 *
 * 通配符规则：
 * - * 匹配任意字符序列（包括空序列）
 * - ? 匹配恰好一个字符
 * - 无通配符的字符串走精确匹配（向后兼容）
 */

/**
 * 将通配符模式转换为正则表达式
 * @param {string} pattern 通配符模式（如 "技术*支持"、"客户?群"）
 * @returns {RegExp} 对应的正则表达式
 */
function wildcardToRegex(pattern) {
  // 先转义所有正则特殊字符（除了 * 和 ?）
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // 再将通配符转为正则
  const withWildcards = escaped
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${withWildcards}$`)
}

/**
 * 判断名称是否匹配白名单中的某个模式
 *
 * - 无通配符的条目走精确匹配（向后兼容现有配置）
 * - 含 * 或 ? 的条目走通配符正则匹配
 *
 * @param {string} name 要匹配的名称（如群名称）
 * @param {string[]} patterns 白名单模式数组
 * @returns {boolean} 是否匹配
 *
 * @example
 * matchWhitelist('技术1群支持', ['技术*支持'])  // true
 * matchWhitelist('客户A群', ['客户?群'])        // true
 * matchWhitelist('测试群', ['测试群'])          // true（精确匹配）
 * matchWhitelist('其他群', ['测试群'])          // false
 */
export function matchWhitelist(name, patterns) {
  if (!name) return false
  for (const pattern of patterns) {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      // 纯字符串：精确匹配（向后兼容）
      if (name === pattern) return true
    } else {
      // 通配符模式：正则匹配
      try {
        if (wildcardToRegex(pattern).test(name)) return true
      } catch (e) {
        // 正则构造失败（极端情况），退回精确匹配
        console.warn(`⚠️ 通配符正则构造失败: ${pattern}`, e.message)
        if (name === pattern) return true
      }
    }
  }
  return false
}
