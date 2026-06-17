/**
 * 认证 API 路由
 */

import express from 'express'
import {
  authenticateUser,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserById
} from '../db/user.js'

const router = express.Router()

/**
 * POST /api/auth/login
 * 登录
 */
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.json({ success: false, error: '请输入用户名和密码' })
    }

    const user = authenticateUser(username, password)
    if (!user) {
      return res.json({ success: false, error: '用户名或密码错误' })
    }

    // 存入 session
    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name
    }

    res.json({ success: true, user: req.session.user })
  } catch (e) {
    console.error('登录失败:', e)
    res.json({ success: false, error: '登录失败' })
  }
})

/**
 * POST /api/auth/logout
 * 登出
 */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true })
  })
})

/**
 * GET /api/auth/me
 * 获取当前登录用户信息
 */
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ success: true, user: req.session.user })
  } else {
    res.status(401).json({ success: false, error: '未登录' })
  }
})

// ========== 以下路由需要登录 ==========

/**
 * 认证检查中间件
 */
router.use((req, res, next) => {
  if (req.session && req.session.user) return next()
  res.status(401).json({ success: false, error: '未登录' })
})

/**
 * GET /api/auth/users
 * 获取用户列表
 */
router.get('/users', (req, res) => {
  try {
    const users = listUsers()
    res.json({ success: true, users })
  } catch (e) {
    console.error('获取用户列表失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * POST /api/auth/users
 * 创建新用户
 */
router.post('/users', (req, res) => {
  try {
    const { username, password, displayName } = req.body
    const result = createUser(username, password, displayName)
    if (result.success) {
      res.json({ success: true, user: result.user })
    } else {
      res.json({ success: false, error: result.error })
    }
  } catch (e) {
    console.error('创建用户失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * PUT /api/auth/users/:id
 * 更新用户信息
 */
router.put('/users/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { password, displayName } = req.body
    const result = updateUser(id, { password, displayName })
    if (result.success) {
      // 如果修改的是自己，更新 session
      if (req.session.user.id === id && displayName) {
        req.session.user.displayName = displayName
      }
      res.json({ success: true })
    } else {
      res.json({ success: false, error: result.error })
    }
  } catch (e) {
    console.error('更新用户失败:', e)
    res.json({ success: false, error: e.message })
  }
})

/**
 * DELETE /api/auth/users/:id
 * 删除用户
 */
router.delete('/users/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id)

    // 不能删自己
    if (req.session.user.id === id) {
      return res.json({ success: false, error: '不能删除当前登录的账号' })
    }

    const result = deleteUser(id)
    if (result.success) {
      res.json({ success: true })
    } else {
      res.json({ success: false, error: result.error })
    }
  } catch (e) {
    console.error('删除用户失败:', e)
    res.json({ success: false, error: e.message })
  }
})

export default router
