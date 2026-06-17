/**
 * 聊天记录 API 路由
 */

import express from 'express'
import { queryChatLogs, getRoomList, deleteChatLog, cleanOldLogs, getStats } from '../db/chatLog.js'

const router = express.Router()

/**
 * GET /api/logs
 * 查询聊天记录
 * Query params:
 * - startDate: 开始日期 YYYY-MM-DD
 * - endDate: 结束日期 YYYY-MM-DD
 * - roomId: 群ID
 * - roomName: 群名称
 * - keyword: 关键字
 * - page: 页码（默认1）
 * - pageSize: 每页条数（默认50）
 */
router.get('/logs', (req, res) => {
  try {
    const { startDate, endDate, roomId, roomName, keyword, page, pageSize } = req.query

    // 默认查询最近7天
    let start = startDate
    let end = endDate

    if (!start && !end) {
      const today = new Date()
      const weekAgo = new Date(today)
      weekAgo.setDate(weekAgo.getDate() - 7)
      start = weekAgo.toISOString().substring(0, 10)
      end = today.toISOString().substring(0, 10)
    }

    // 限制查询范围（最多31天）
    if (start && end) {
      const startMs = new Date(start).getTime()
      const endMs = new Date(end).getTime()
      const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24)
      if (diffDays > 31) {
        return res.json({
          success: false,
          error: '查询范围不能超过31天'
        })
      }
    }

    const result = queryChatLogs({
      startDate: start,
      endDate: end,
      roomId,
      roomName,
      keyword,
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50
    })

    res.json({
      success: true,
      ...result
    })
  } catch (e) {
    console.error('查询聊天记录失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * GET /api/rooms
 * 获取群列表
 */
router.get('/rooms', (req, res) => {
  try {
    const rooms = getRoomList()
    res.json({ success: true, rooms })
  } catch (e) {
    console.error('获取群列表失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * DELETE /api/logs/:id
 * 删除单条记录
 */
router.delete('/logs/:id', (req, res) => {
  try {
    const { id } = req.params
    const success = deleteChatLog(parseInt(id))

    if (success) {
      res.json({ success: true, message: '删除成功' })
    } else {
      res.json({ success: false, error: '记录不存在' })
    }
  } catch (e) {
    console.error('删除聊天记录失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * POST /api/logs/clean
 * 清理旧记录
 * Body: { days: number } 保留最近多少天
 */
router.post('/logs/clean', (req, res) => {
  try {
    const { days = 30 } = req.body
    const count = cleanOldLogs(days)
    res.json({ success: true, message: `已清理 ${count} 条记录` })
  } catch (e) {
    console.error('清理聊天记录失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * GET /api/stats
 * 获取统计数据
 */
router.get('/stats', (req, res) => {
  try {
    const stats = getStats()
    res.json({ success: true, ...stats })
  } catch (e) {
    console.error('获取统计数据失败:', e)
    res.json({ success: false, error: e.message })
  }
})

export default router
