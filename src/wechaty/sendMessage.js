import { getGptReply, getVisionReply, getVideoReply } from '../openai/index.js'
import { getKimiReply } from '../kimi/index.js'
import { getRagReply } from '../rag/index.js'
import { getConfig, getBotName, getRoomWhiteList, getAliasWhiteList, getQuestionKeywords } from '../config/hotReload.js'
import { getServe } from './serve.js'
import { matchWhitelist } from './wildcardMatch.js'
import { shouldReply } from './intentFilter.js'
import { enqueue } from './messageQueue.js'
import { bufferMessage } from './messageBuffer.js'
import { withRetry } from '../utils/retry.js'
import { extractFrames, getMaxVideoSize, isVideoEnabled } from '../utils/videoFrameExtractor.js'
import {
  isInConversation,
  getLastQuestion,
  getConversationHistory,
  startConversation,
  recordReply,
  appendUserMessage,
  endConversation
} from './sessionManager.js'
import { logChat } from '../db/logger.js'

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
 * 清理所有过期缓存（定期调用）
 */
function cleanAllExpiredContexts() {
  let cleaned = 0
  for (const [roomId] of contextCache) {
    const messages = contextCache.get(roomId)
    if (!messages) continue

    const now = Date.now()
    const valid = messages.filter(m => now - m.timestamp < CONTEXT_TTL)
    if (valid.length === 0) {
      contextCache.delete(roomId)
      cleaned++
    } else if (valid.length !== messages.length) {
      contextCache.set(roomId, valid)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 清理了 ${cleaned} 个过期上下文缓存`)
  }
}

// 定期清理过期缓存（每分钟）
setInterval(cleanAllExpiredContexts, 60000)

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
 * 添加视频帧上下文（缓存帧 base64，而非原始视频）
 */
function addVideoContext(roomId, userId, frames) {
  if (!contextCache.has(roomId)) {
    contextCache.set(roomId, [])
  }
  const messages = contextCache.get(roomId)
  messages.unshift({ userId, type: 'video', frames, timestamp: Date.now() })

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
 * 获取用户最近的媒体上下文（图片或视频帧）
 * @returns {{ type: 'image'|'video', imageBase64?: string, mimeType?: string, frames?: Array }|null}
 */
function getRecentMediaContext(roomId, userId) {
  cleanExpiredContext(roomId)
  const messages = contextCache.get(roomId)
  if (!messages) return null

  // 找最近的图片或视频
  const media = messages.find(m => m.userId === userId && (m.type === 'image' || m.type === 'video'))
  if (!media) return null

  if (media.type === 'video') {
    return { type: 'video', frames: media.frames }
  }

  return { type: 'image', imageBase64: media.imageBase64, mimeType: media.mimeType }
}

/**
 * 默认消息发送（支持文本、图片和视频）
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
  const isVideo = msg.type() === bot.Message.Type.Video // 消息类型是否为视频

  // 动态读取配置（支持热加载）
  const { botName, roomWhiteList, aliasWhiteList, questionKeywords } = getConfig()

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
    isVideo,
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
            logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'image' }
          })
        } else if (isAlias && !room) {
          enqueue(contact.id, {
            promise: Promise.resolve('图片太大了，请发送小于10MB的图片哦～'),
            target: contact,
            timestamp: Date.now(),
            originalContent: '[图片过大]',
            logInfo: { roomId: contact.id, roomName: '私聊', userId: contact.id, userName: alias, messageType: 'image' }
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

          // 并发生成，入队串行发送（带重试）
          const genPromise = (async () => {
            try {
              // Vision API 调用（带重试）
              const visionResult = await withRetry(
                () => getVisionReply(imageBase64, mimeType, prompt),
                { name: 'Vision API', maxRetries: 2 }
              )
              if (!visionResult.success) {
                console.log('⚠️ Vision API 重试后仍失败，不回复')
                return null
              }
              const visionDescription = visionResult.data
              console.log('🤖 Vision API返回:', visionDescription)

              const ragQuery = `用户提问：${prompt}\n\n图片内容：${visionDescription}`
              console.log('📚 RAG查询:', ragQuery)

              // RAG API 调用（带重试）
              const ragResult = await withRetry(
                () => getRagReply(ragQuery),
                { name: 'RAG API', maxRetries: 2 }
              )
              if (!ragResult.success) {
                console.log('⚠️ RAG API 重试后仍失败，不回复')
                return null
              }
              console.log('📚 RAG回答:', ragResult.data)
              return ragResult.data
            } catch (e) {
              console.error('❌ 图片处理异常:', e)
              return null
            }
          })()

          // 处理结果（带错误捕获）
          genPromise
            .then(reply => {
              if (reply) {
                enqueue(room.id, {
                  promise: Promise.resolve(reply),
                  target: room,
                  timestamp: Date.now(),
                  originalContent: prompt,
                  logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'image' }
                })
                console.log('✅ 群聊图片回复已入队')
              }
            })
            .catch(e => console.error('❌ genPromise 未捕获异常:', e))
          return
        } else {
          // 没有文本上下文，缓存图片等待后续文本
          addImageContext(room.id, contact.id, imageBase64, mimeType)
          console.log('📸 群聊图片已缓存，等待用户提问')
        }
        return
      }

      // 私聊图片：直接处理（带重试）
      if (isAlias && !room) {
        console.log('🤖 私聊图片理解开始')
        const genPromise = (async () => {
          try {
            const result = await withRetry(
              () => getVisionReply(imageBase64, mimeType, '请描述这张图片的内容'),
              { name: 'Vision API', maxRetries: 2 }
            )
            if (!result.success) {
              console.log('⚠️ Vision API 重试后仍失败，不回复')
              return null
            }
            return result.data
          } catch (e) {
            console.error('❌ 私聊图片处理异常:', e)
            return null
          }
        })()

        // 处理结果（带错误捕获）
        genPromise
          .then(reply => {
            if (reply) {
              enqueue(contact.id, {
                promise: Promise.resolve(reply),
                target: contact,
                timestamp: Date.now(),
                originalContent: '[图片]',
                logInfo: { roomId: contact.id, roomName: '私聊', userId: contact.id, userName: alias, messageType: 'image' }
              })
              console.log('✅ 私聊图片回复已入队')
            }
          })
          .catch(e => console.error('❌ genPromise 未捕获异常:', e))
      }
    } catch (e) {
      console.error('❌ 图片处理失败:', e)
      // 图片处理异常时，不回复错误消息
      return
    }
    return
  }

  // ========== 处理视频消息 ==========
  if (isVideo) {
    // 检查视频理解是否启用
    if (!isVideoEnabled()) {
      console.log('⏭️ 视频理解功能未启用，跳过')
      return
    }

    console.log('🎬 收到视频消息，开始处理...')

    try {
      // 检查消息时间
      const msgMaxAge = getMsgMaxAge()
      const msgTime = 1e3 * msg.payload.timestamp
      const timeDiff = Date.now() - msgTime
      console.log('⏰ 消息时间检查:', { msgTime, now: Date.now(), timeDiff, maxAge: msgMaxAge })

      if (timeDiff > msgMaxAge) {
        console.log(`⚠️ 视频消息超过${(msgMaxAge/1000).toFixed(0)}秒(${(timeDiff/1000).toFixed(1)}秒)，忽略`)
        return
      }

      // 获取视频文件
      const fileBox = await msg.toFileBox()
      console.log('📦 视频文件信息:', { name: fileBox.name, type: fileBox.type })

      // 获取视频二进制数据
      const videoBuffer = await fileBox.toBuffer()

      // 视频大小检查
      const videoSize = videoBuffer.length
      const maxVideoSize = getMaxVideoSize()
      if (videoSize > maxVideoSize) {
        console.log(`⚠️ 视频太大(${(videoSize / 1024 / 1024).toFixed(2)}MB)，超过${(maxVideoSize/1024/1024).toFixed(0)}MB限制，忽略`)
        if (room && inRoomWhiteList) {
          enqueue(room.id, {
            promise: Promise.resolve('视频太大了，请发送小于50MB的视频哦～'),
            target: room,
            timestamp: Date.now(),
            originalContent: '[视频过大]',
            logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'video' }
          })
        } else if (isAlias && !room) {
          enqueue(contact.id, {
            promise: Promise.resolve('视频太大了，请发送小于50MB的视频哦～'),
            target: contact,
            timestamp: Date.now(),
            originalContent: '[视频过大]',
            logInfo: { roomId: contact.id, roomName: '私聊', userId: contact.id, userName: alias, messageType: 'video' }
          })
        }
        return
      }

      // 抽取视频关键帧
      console.log('📹 开始抽取视频关键帧...')
      const frames = await extractFrames(videoBuffer)

      if (frames.length === 0) {
        console.log('⚠️ 视频抽帧失败，无法处理')
        return
      }

      console.log(`✅ 成功抽取 ${frames.length} 帧关键画面`)

      // 群聊视频：检查是否有文本上下文
      if (room && inRoomWhiteList) {
        const textHistory = getContextHistory(room.id, contact.id).filter(m => m.type === 'text')

        if (textHistory.length > 0) {
          // 有文本上下文，先做意图检查
          const orderedHistory = [...textHistory].reverse()
          const historyText = orderedHistory.map(m => m.content).join('\n')
          const prompt = historyText

          // 意图过滤
          if (!await shouldReply(prompt, questionKeywords)) {
            console.log('🧠 意图过滤: 视频上下文非提问，跳过')
            return
          }

          console.log('🔗 发现文本上下文，立即处理视频')

          // 并发生成，入队串行发送（带重试）
          const genPromise = (async () => {
            try {
              // Video API 调用（带重试）
              const videoResult = await withRetry(
                () => getVideoReply(frames, prompt),
                { name: 'Video API', maxRetries: 2 }
              )
              if (!videoResult.success) {
                console.log('⚠️ Video API 重试后仍失败，不回复')
                return null
              }
              const videoDescription = videoResult.data
              console.log('🤖 Video API返回:', videoDescription)

              const ragQuery = `用户提问：${prompt}\n\n视频内容：${videoDescription}`
              console.log('📚 RAG查询:', ragQuery)

              // RAG API 调用（带重试）
              const ragResult = await withRetry(
                () => getRagReply(ragQuery),
                { name: 'RAG API', maxRetries: 2 }
              )
              if (!ragResult.success) {
                console.log('⚠️ RAG API 重试后仍失败，不回复')
                return null
              }
              console.log('📚 RAG回答:', ragResult.data)
              return ragResult.data
            } catch (e) {
              console.error('❌ 视频处理异常:', e)
              return null
            }
          })()

          // 处理结果（带错误捕获）
          genPromise
            .then(reply => {
              if (reply) {
                enqueue(room.id, {
                  promise: Promise.resolve(reply),
                  target: room,
                  timestamp: Date.now(),
                  originalContent: prompt,
                  logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'video' }
                })
                console.log('✅ 群聊视频回复已入队')
              }
            })
            .catch(e => console.error('❌ genPromise 未捕获异常:', e))
          return
        } else {
          // 没有文本上下文，缓存视频帧等待后续文本
          addVideoContext(room.id, contact.id, frames)
          console.log('🎬 群聊视频帧已缓存，等待用户提问')
        }
        return
      }

      // 私聊视频：直接处理（带重试）
      if (isAlias && !room) {
        console.log('🤖 私聊视频理解开始')
        const genPromise = (async () => {
          try {
            const result = await withRetry(
              () => getVideoReply(frames, '请描述这个视频的内容'),
              { name: 'Video API', maxRetries: 2 }
            )
            if (!result.success) {
              console.log('⚠️ Video API 重试后仍失败，不回复')
              return null
            }
            return result.data
          } catch (e) {
            console.error('❌ 私聊视频处理异常:', e)
            return null
          }
        })()

        // 处理结果（带错误捕获）
        genPromise
          .then(reply => {
            if (reply) {
              enqueue(contact.id, {
                promise: Promise.resolve(reply),
                target: contact,
                timestamp: Date.now(),
                originalContent: '[视频]',
                logInfo: { roomId: contact.id, roomName: '私聊', userId: contact.id, userName: alias, messageType: 'video' }
              })
              console.log('✅ 私聊视频回复已入队')
            }
          })
          .catch(e => console.error('❌ genPromise 未捕获异常:', e))
      }
    } catch (e) {
      console.error('❌ 视频处理失败:', e)
      return
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

        // 检查是否有缓存的媒体（图片或视频）需要关联处理
        const recentMedia = getRecentMediaContext(room.id, contact.id)
        if (recentMedia) {
          if (recentMedia.type === 'video') {
            console.log('🔗 发现缓存的视频帧，关联处理')

            // 开始对话（视频关联处理）
            if (!isInConversation(room.id, contact.id)) {
              startConversation(room.id, contact.id, actualContent)
            } else {
              appendUserMessage(room.id, contact.id, actualContent)
            }

            // 并发生成，入队串行发送（带重试）
            const genPromise = (async () => {
              try {
                // Video API 调用（带重试）
                const videoResult = await withRetry(
                  () => getVideoReply(recentMedia.frames, actualContent),
                  { name: 'Video API', maxRetries: 2 }
                )
                if (!videoResult.success) {
                  console.log('⚠️ Video API 重试后仍失败，结束会话，不回复')
                  endConversation(room.id, contact.id)
                  return null
                }
                console.log('🤖 Video API返回:', videoResult.data)

                const ragQuery = `用户提问：${actualContent}\n\n视频内容：${videoResult.data}`
                console.log('📚 RAG查询:', ragQuery)

                const history = getConversationHistory(room.id, contact.id)

                // RAG API 调用（带重试）
                const ragResult = await withRetry(
                  () => getRagReply(ragQuery, history),
                  { name: 'RAG API', maxRetries: 2 }
                )
                if (!ragResult.success) {
                  console.log('⚠️ RAG API 重试后仍失败，结束会话，不回复')
                  endConversation(room.id, contact.id)
                  return null
                }
                console.log('📚 RAG回答:', ragResult.data)
                recordReply(room.id, contact.id, ragResult.data)
                return ragResult.data
              } catch (e) {
                console.error('❌ 视频关联处理异常:', e)
                endConversation(room.id, contact.id)
                return null
              }
            })()

            // 处理结果（带错误捕获）
            genPromise
              .then(reply => {
                if (reply) {
                  enqueue(room.id, {
                    promise: Promise.resolve(reply),
                    target: room,
                    timestamp: Date.now(),
                    originalContent: actualContent,
                    logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'video' }
                  })
                  console.log('✅ 群聊视频关联回复已入队')
                }
              })
              .catch(e => console.error('❌ genPromise 未捕获异常:', e))
            return
          }

          // 图片关联处理
          console.log('🔗 发现缓存的图片，关联处理')

          // 开始对话（图片关联处理）
          if (!isInConversation(room.id, contact.id)) {
            startConversation(room.id, contact.id, actualContent)
          } else {
            appendUserMessage(room.id, contact.id, actualContent)
          }

          // 并发生成，入队串行发送（带重试）
          const genPromise = (async () => {
            try {
              // Vision API 调用（带重试）
              const visionResult = await withRetry(
                () => getVisionReply(recentMedia.imageBase64, recentMedia.mimeType, actualContent),
                { name: 'Vision API', maxRetries: 2 }
              )
              if (!visionResult.success) {
                console.log('⚠️ Vision API 重试后仍失败，结束会话，不回复')
                endConversation(room.id, contact.id)
                return null
              }
              console.log('🤖 Vision API返回:', visionResult.data)

              const ragQuery = `用户提问：${actualContent}\n\n图片内容：${visionResult.data}`
              console.log('📚 RAG查询:', ragQuery)

              const history = getConversationHistory(room.id, contact.id)

              // RAG API 调用（带重试）
              const ragResult = await withRetry(
                () => getRagReply(ragQuery, history),
                { name: 'RAG API', maxRetries: 2 }
              )
              if (!ragResult.success) {
                console.log('⚠️ RAG API 重试后仍失败，结束会话，不回复')
                endConversation(room.id, contact.id)
                return null
              }
              console.log('📚 RAG回答:', ragResult.data)
              recordReply(room.id, contact.id, ragResult.data)
              return ragResult.data
            } catch (e) {
              console.error('❌ 图片关联处理异常:', e)
              endConversation(room.id, contact.id)
              return null
            }
          })()

          // 处理结果（带错误捕获）
          genPromise
            .then(reply => {
              if (reply) {
                enqueue(room.id, {
                  promise: Promise.resolve(reply),
                  target: room,
                  timestamp: Date.now(),
                  originalContent: actualContent,
                  logInfo: { roomId: room.id, roomName, userId: contact.id, userName: alias, messageType: 'text' }
                })
                console.log('✅ 群聊图片关联回复已入队')
              }
            })
            .catch(e => console.error('❌ genPromise 未捕获异常:', e))
          return
        }

        // ========== 纯文本消息：走消息缓冲（debounce 合并） ==========
        // 缓存文本消息，供后续图片关联使用
        addTextContext(room.id, contact.id, actualContent)

        const bufferKey = `${room.id}_${contact.id}`
        const bufferMeta = { roomId: room.id, roomName, userId: contact.id, userName: alias, target: room }

        bufferMessage(bufferKey, actualContent, bufferMeta, async (_key, mergedContent, meta) => {
          // 缓冲到期回调：统一走意图识别
          if (!await shouldReply(mergedContent, questionKeywords)) {
            console.log('🧠 意图过滤: 非提问消息，跳过回复')
            return
          }

          // 如果在对话中，追加用户消息；否则开始新对话
          // 注意：先更新会话状态，再获取历史，保证历史包含当前消息
          if (isInConversation(meta.roomId, meta.userId)) {
            appendUserMessage(meta.roomId, meta.userId, mergedContent)
          } else {
            startConversation(meta.roomId, meta.userId, mergedContent)
          }

          // 获取对话历史（在更新会话状态之后，确保包含当前消息）
          const history = getConversationHistory(meta.roomId, meta.userId)

          // 并发生成，入队串行发送（带重试）
          console.log('🤖 群聊回复生成开始, 内容:', mergedContent)
          console.log('📜 对话历史长度:', history.length)
          const genPromise = (async () => {
            try {
              const result = await withRetry(
                () => getReply(mergedContent, history),
                { name: 'RAG API', maxRetries: 2 }
              )
              if (!result.success) {
                console.log('⚠️ API 重试后仍失败，结束会话，不回复')
                endConversation(meta.roomId, meta.userId)
                return null
              }
              recordReply(meta.roomId, meta.userId, result.data)
              return result.data
            } catch (e) {
              console.error('❌ 群聊回复生成异常:', e)
              endConversation(meta.roomId, meta.userId)
              return null
            }
          })()

          // 处理结果（带错误捕获）
          genPromise
            .then(reply => {
              if (reply) {
                enqueue(meta.roomId, {
                  promise: Promise.resolve(reply),
                  target: meta.target,
                  timestamp: Date.now(),
                  originalContent: mergedContent,
                  logInfo: { roomId: meta.roomId, roomName: meta.roomName, userId: meta.userId, userName: meta.userName, messageType: 'text' }
                })
                console.log('✅ 群聊回复已入队')
              }
            })
            .catch(e => console.error('❌ genPromise 未捕获异常:', e))
        })
      }

      // ========== 私聊处理（私聊全部回复，不走意图过滤） ==========
      if (isAlias && !room) {
        if (content.length < 1) return

        console.log('🤖 私聊回复生成开始, 内容:', content)
        const genPromise = (async () => {
          try {
            const result = await withRetry(
              () => getReply(content),
              { name: 'RAG API', maxRetries: 2 }
            )
            if (!result.success) {
              console.log('⚠️ API 重试后仍失败，不回复')
              return null
            }
            return result.data
          } catch (e) {
            console.error('❌ 私聊回复生成异常:', e)
            return null
          }
        })()

        // 处理结果（带错误捕获）
        genPromise
          .then(reply => {
            if (reply) {
              enqueue(contact.id, {
                promise: Promise.resolve(reply),
                target: contact,
                timestamp: Date.now(),
                originalContent: content,
                logInfo: { roomId: contact.id, roomName: '私聊', userId: contact.id, userName: alias, messageType: 'text' }
              })
              console.log('✅ 私聊回复已入队')
            }
          })
          .catch(e => console.error('❌ genPromise 未捕获异常:', e))
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
