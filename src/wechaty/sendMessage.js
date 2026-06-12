import { getGptReply, getVisionReply } from '../openai/index.js'
import { getKimiReply } from '../kimi/index.js'
import { getRagReply } from '../rag/index.js'
import { botName, roomWhiteList, aliasWhiteList, questionKeywords } from '../../config.js'
import { getServe } from './serve.js'
import { matchWhitelist } from './wildcardMatch.js'
import { shouldReply } from './intentFilter.js'
import { enqueue } from './messageQueue.js'

// 启动时打印配置，便于调试
console.log('🔧 当前配置:', { botName, roomWhiteList, aliasWhiteList, questionKeywords })

// ========== 运行参数（动态读取，支持热加载） ==========

function getMsgMaxAge() { return (parseInt(process.env.MSG_MAX_AGE) || 60) * 1000 }

// ========== 上下文缓存 ==========
// 存储群聊中的消息和图片，用于关联理解
// 结构: Map<roomId, Array<{userId, type: 'text'|'image', content, imageBase64?, mimeType?, timestamp}>>
const contextCache = new Map()
const CONTEXT_TTL = 60000 // 60秒时间窗口
const MAX_CONTEXT_PER_ROOM = 10 // 每个房间最多保留10条消息

/**
 * 清理过期缓存
 */
function cleanExpiredContext(roomId) {
  const messages = contextCache.get(roomId)
  if (!messages) return

  const now = Date.now()
  const valid = messages.filter(m => now - m.timestamp < CONTEXT_TTL)
  if (valid.length === 0) {
    contextCache.delete(roomId)
  } else {
    contextCache.set(roomId, valid)
  }
}

/**
 * 添加文本上下文
 */
function addTextContext(roomId, userId, content) {
  if (!contextCache.has(roomId)) {
    contextCache.set(roomId, [])
  }
  const messages = contextCache.get(roomId)
  messages.unshift({ userId, type: 'text', content, timestamp: Date.now() })

  // 保留最新10条
  if (messages.length > MAX_CONTEXT_PER_ROOM) {
    messages.pop()
  }
}

/**
 * 添加图片上下文
 */
function addImageContext(roomId, userId, imageBase64, mimeType) {
  if (!contextCache.has(roomId)) {
    contextCache.set(roomId, [])
  }
  const messages = contextCache.get(roomId)
  messages.unshift({ userId, type: 'image', imageBase64, mimeType, timestamp: Date.now() })

  // 保留最新10条
  if (messages.length > MAX_CONTEXT_PER_ROOM) {
    messages.pop()
  }
}

/**
 * 获取用户的完整会话上下文（60秒内的所有消息）
 * @returns {Array>} 消息数组，按时间倒序
 */
function getContextHistory(roomId, userId) {
  cleanExpiredContext(roomId)
  const messages = contextCache.get(roomId)
  if (!messages) return []

  // 过滤该用户的所有消息，按时间倒序（最新的在前）
  const userMessages = messages
    .filter(m => m.userId === userId)
    .sort((a, b) => b.timestamp - a.timestamp)

  return userMessages
}

/**
 * 获取用户最近的图片上下文
 */
function getRecentImageContext(roomId, userId) {
  cleanExpiredContext(roomId)
  const messages = contextCache.get(roomId)
  if (!messages) return null

  // 找最近的一张图片
  return messages.find(m => m.userId === userId && m.type === 'image') || null
}

/**
 * 默认消息发送（支持文本和图片）
 *
 * 新流程：白名单匹配（通配符）→ 意图过滤（关键字+AI）→ 并发生成 → 串行发送队列
 *
 * @param msg
 * @param bot
 * @param ServiceType 服务类型 'GPT' | 'Kimi'
 * @returns {Promise<void>}
 */
export async function defaultMessage(msg, bot, ServiceType = 'GPT') {
  const getReply = getServe(ServiceType)
  const contact = msg.talker() // 发消息人
  const content = msg.text() // 消息内容
  const room = msg.room() // 是否是群消息
  const roomName = (await room?.topic()) || null // 群名称
  const alias = (await contact.alias()) || (await contact.name()) // 发消息人昵称
  const remarkName = await contact.alias() // 备注名称
  const name = await contact.name() // 微信名称
  const isText = msg.type() === bot.Message.Type.Text // 消息类型是否为文本
  const isImage = msg.type() === bot.Message.Type.Image // 消息类型是否为图片
  const inRoomWhiteList = matchWhitelist(roomName, roomWhiteList) // 通配符白名单匹配
  const isRoom = inRoomWhiteList // 群聊触发条件（不再需要@机器人）
  const isAlias = aliasWhiteList.includes(remarkName) || aliasWhiteList.includes(name) // 发消息的人是否在联系人白名单内
  const isBotSelf = botName === remarkName || botName === name // 是否是机器人自己

  // 调试日志（精简版，减少刷屏）
  console.log('📩 收到消息:', {
    content: content.substring(0, 80),
    name,
    isText,
    isImage,
    inRoomWhiteList,
    roomName,
  })

  // 尝试处理 Unknown 类型（企业微信消息）
  if (msg.type() === 0 || msg.type() === bot.Message.Type.Unknown) {
    console.log('⚠️ 收到 Unknown 类型消息，尝试解析...')
    console.log('📦 消息完整对象:', JSON.stringify(msg.payload, null, 2))
    // 登录过渡期的系统消息（内容为空、talkerId=listenerId），直接跳过
    if (!content || content.trim() === '') {
      console.log('⏭️ 跳过空内容的 Unknown 消息（可能是登录过渡期系统推送）')
      return
    }
  }

  // 跳过机器人自己的消息
  if (isBotSelf) {
    console.log('⏭️ 跳过机器人自己的消息')
    return
  }

  // 不在任何触发范围内，跳过
  if (!isRoom && !(isAlias && !room)) {
    return
  }

  // ========== 处理图片消息 ==========
  if (isImage) {
    console.log('🖼️ 收到图片消息，开始处理...')

    try {
      // 检查消息时间
      const msgMaxAge = getMsgMaxAge()
      const msgTime = 1e3 * msg.payload.timestamp
      const timeDiff = Date.now() - msgTime
      console.log('⏰ 消息时间检查:', { msgTime, now: Date.now(), timeDiff, maxAge: msgMaxAge })

      if (timeDiff > msgMaxAge) {
        console.log(`⚠️ 图片消息超过${(msgMaxAge/1000).toFixed(0)}秒(${(timeDiff/1000).toFixed(1)}秒)，忽略`)
        return
      }

      // 获取图片文件
      const fileBox = await msg.toFileBox()
      console.log('📦 图片文件信息:', { name: fileBox.name, type: fileBox.type })

      // 获取 base64 编码
      const imageBuffer = await fileBox.toBuffer()
      const imageBase64 = imageBuffer.toString('base64')

      // 获取图片 MIME 类型
      const mimeType = getMimeType(fileBox.name)

      // 图片大小检查（避免处理超大图片）
      const imageSize = imageBuffer.length
      const maxImageSize = 10 * 1024 * 1024 // 10MB
      if (imageSize > maxImageSize) {
        console.log(`⚠️ 图片太大(${(imageSize / 1024 / 1024).toFixed(2)}MB)，超过10MB限制，忽略`)
        if (room && inRoomWhiteList) {
          enqueue(room.id, {
            promise: Promise.resolve('图片太大了，请发送小于10MB的图片哦～'),
            target: room,
            timestamp: Date.now(),
            originalContent: '[图片过大]',
          })
        } else if (isAlias && !room) {
          enqueue(contact.id, {
            promise: Promise.resolve('图片太大了，请发送小于10MB的图片哦～'),
            target: contact,
            timestamp: Date.now(),
            originalContent: '[图片过大]',
          })
        }
        return
      }

      // 群聊图片：检查是否有文本上下文
      if (room && inRoomWhiteList) {
        const textHistory = getContextHistory(room.id, contact.id).filter(m => m.type === 'text')

        if (textHistory.length > 0) {
          // 有文本上下文，先做意图检查
          const orderedHistory = [...textHistory].reverse()
          const historyText = orderedHistory.map(m => m.content).join('\n')
          const prompt = historyText

          // 意图过滤
          if (!await shouldReply(prompt, questionKeywords)) {
            console.log('🧠 意图过滤: 图片上下文非提问，跳过')
            return
          }

          console.log('🔗 发现文本上下文，立即处理图片')

          // 并发生成，入队串行发送
          const genPromise = (async () => {
            const visionDescription = await getVisionReply(imageBase64, mimeType, prompt)
            console.log('🤖 Vision API返回:', visionDescription)
            const ragQuery = `用户提问：${prompt}\n\n图片内容：${visionDescription}`
            console.log('📚 RAG查询:', ragQuery)
            const reply = await getRagReply(ragQuery)
            console.log('📚 RAG回答:', reply)
            return reply
          })()

          enqueue(room.id, {
            promise: genPromise,
            target: room,
            timestamp: Date.now(),
            originalContent: prompt,
          })
          console.log('✅ 群聊图片回复已入队')
        } else {
          // 没有文本上下文，缓存图片等待后续文本
          addImageContext(room.id, contact.id, imageBase64, mimeType)
          console.log('📸 群聊图片已缓存，等待用户提问')
        }
        return
      }

      // 私聊图片：直接处理
      if (isAlias && !room) {
        console.log('🤖 私聊图片理解开始')
        const genPromise = getVisionReply(imageBase64, mimeType, '请描述这张图片的内容')

        enqueue(contact.id, {
          promise: genPromise,
          target: contact,
          timestamp: Date.now(),
          originalContent: '[图片]',
        })
        console.log('✅ 私聊图片回复已入队')
      }
    } catch (e) {
      console.error('❌ 图片处理失败:', e)
      const errorMsg = '抱歉，处理这张图片时遇到问题，请稍后再试。'
      if (room && inRoomWhiteList) {
        enqueue(room.id, {
          promise: Promise.resolve(errorMsg),
          target: room,
          timestamp: Date.now(),
          originalContent: '[图片处理错误]',
        })
      } else if (isAlias && !room) {
        enqueue(contact.id, {
          promise: Promise.resolve(errorMsg),
          target: contact,
          timestamp: Date.now(),
          originalContent: '[图片处理错误]',
        })
      }
    }
    return
  }

  // ========== 处理文本消息 ==========
  if (isText) {
    console.log('💬 收到文本消息，开始处理...')

    try {
      // 检查消息时间
      const msgMaxAge = getMsgMaxAge()
      const msgTime = 1e3 * msg.payload.timestamp
      const timeDiff = Date.now() - msgTime
      console.log('⏰ 消息时间检查:', { msgTime, now: Date.now(), timeDiff, maxAge: msgMaxAge })

      if (timeDiff > msgMaxAge) {
        console.log(`⚠️ 消息超过${(msgMaxAge/1000).toFixed(0)}秒(${(timeDiff/1000).toFixed(1)}秒)，忽略`)
        return
      }

      // 提取实际消息内容（去掉@机器人部分，如果存在的话）
      let actualContent = content.replace(botName, '').trim()

      // ========== 群聊处理 ==========
      if (isRoom && room) {
        if (actualContent.length < 1) return

        // 意图过滤：关键字 + AI 意图识别
        if (!await shouldReply(actualContent, questionKeywords)) {
          console.log('🧠 意图过滤: 非提问消息，跳过回复')
          // 仍然缓存文本，供后续图片关联使用
          addTextContext(room.id, contact.id, actualContent)
          return
        }

        // 检查是否有缓存的图片需要关联处理
        const recentImage = getRecentImageContext(room.id, contact.id)
        if (recentImage) {
          console.log('🔗 发现缓存的图片，关联处理')

          // 并发生成，入队串行发送
          const genPromise = (async () => {
            const visionDescription = await getVisionReply(recentImage.imageBase64, recentImage.mimeType, actualContent)
            console.log('🤖 Vision API返回:', visionDescription)
            const ragQuery = `用户提问：${actualContent}\n\n图片内容：${visionDescription}`
            console.log('📚 RAG查询:', ragQuery)
            const reply = await getRagReply(ragQuery)
            console.log('📚 RAG回答:', reply)
            return reply
          })()

          enqueue(room.id, {
            promise: genPromise,
            target: room,
            timestamp: Date.now(),
            originalContent: actualContent,
          })
          console.log('✅ 群聊图片关联回复已入队')
          return
        }

        // 缓存文本消息，供后续图片关联使用
        addTextContext(room.id, contact.id, actualContent)
        console.log('📝 缓存群聊提问:', { roomId: room.id, userId: contact.id, content: actualContent })

        // 并发生成，入队串行发送
        console.log('🤖 群聊回复生成开始, 内容:', actualContent)
        const genPromise = getReply(actualContent)

        enqueue(room.id, {
          promise: genPromise,
          target: room,
          timestamp: Date.now(),
          originalContent: actualContent,
        })
        console.log('✅ 群聊回复已入队')
        return
      }

      // ========== 私聊处理（私聊全部回复，不走意图过滤） ==========
      if (isAlias && !room) {
        if (content.length < 1) return

        console.log('🤖 私聊回复生成开始, 内容:', content)
        const genPromise = getReply(content)

        enqueue(contact.id, {
          promise: genPromise,
          target: contact,
          timestamp: Date.now(),
          originalContent: content,
        })
        console.log('✅ 私聊回复已入队')
      }
    } catch (e) {
      console.error('❌ 回复失败:', e)
    }
  }
}

/**
 * 根据文件名获取 MIME 类型
 * @param fileName 文件名
 * @returns {string} MIME 类型
 * @throws {Error} 如果格式不支持
 */
function getMimeType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase() || 'jpg'
  const mimeMap = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
  }
  const mimeType = mimeMap[ext]
  if (!mimeType) {
    throw new Error(`不支持的图片格式: .${ext}，仅支持 jpg/jpeg/png/gif/webp/bmp`)
  }
  return mimeType
}
