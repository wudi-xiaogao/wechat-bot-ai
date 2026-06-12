import { getGptReply } from '../openai/index.js'
import { getKimiReply } from '../kimi/index.js'


/**
 * 获取ai服务
 * @param serviceType 服务类型 'GPT' | 'Kimi'
 * @returns {Function} 对应的服务函数
 */
export function getServe(serviceType) {
  switch (serviceType) {
    case 'GPT':
    case 'ChatGPT':
      return getGptReply
    case 'Kimi':
      return getKimiReply
    default:
      return getGptReply
  }
}