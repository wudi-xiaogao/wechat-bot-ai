/**
 * 聊天记录记录模块
 * 在消息处理完成后记录聊天内容
 */

import { insertChatLog } from './chatLog.js'

/**
 * 记录聊天日志
 * @param {Object} params
 * @param {string} params.roomId 群ID
 * @param {string} params.roomName 群名称
 * @param {string} params.userId 用户ID
 * @param {string} params.userName 用户昵称
 * @param {string} params.messageType 消息类型
 * @param {string} params.content 消息内容
 * @param {string} params.reply 机器人回复
 */
export function logChat(params) {
  try {
    const { roomId, roomName, userId, userName, messageType, content, reply } = params
    insertChatLog({
      room_id: roomId,
      room_name: roomName,
      user_id: userId,
      user_name: userName,
      message_type: messageType || 'text',
      content,
      reply
    })
  } catch (e) {
    console.error('❌ 记录聊天日志失败:', e)
  }
}
