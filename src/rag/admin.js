import express from 'express'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { DocumentLoader } from './loader.js'
import { VectorStore } from './store.js'
import { getQueueStats } from '../wechaty/messageQueue.js'
import dotenv from 'dotenv'
// 延迟导入避免循环依赖
let getScanStatus = null
let triggerRelogin = null

const env = dotenv.config().parsed

const app = express()
const port = env.RAG_ADMIN_PORT || 3000

// RAG 目录
const ragDir = env.RAG_DIR || './rag'

/**
 * 路径安全验证（防止路径遍历攻击）
 * @param filePath 相对路径
 * @returns {string} 安全的完整路径
 * @throws {Error} 如果路径非法
 */
function validatePath(filePath) {
  const fullPath = path.join(ragDir, filePath)
  const relativePath = path.relative(ragDir, fullPath)
  if (relativePath.startsWith('..') || relativePath.includes('..')) {
    throw new Error('非法路径')
  }
  return fullPath
}

// 确保目录存在
if (!fs.existsSync(ragDir)) {
  fs.mkdirSync(ragDir, { recursive: true })
}

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 支持子目录 - 使用 req.body.folder 或 query 参数
    let targetDir = ragDir
    // 从 query 或 body 获取 folder（query 更可靠）
    const folder = req.query.folder || req.body.folder
    if (folder) {
      targetDir = path.join(ragDir, folder)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }
    }
    cb(null, targetDir)
  },
  filename: (req, file, cb) => {
    // 处理中文文件名编码问题
    let originalname = file.originalname
    // 如果文件名是乱码，尝试从 latin1 转换为 utf8
    if (/[^\x00-\x7F]/.test(originalname) && originalname.includes('')) {
      try {
        // multer 可能用 latin1 解码，需要转换回 utf8
        originalname = Buffer.from(originalname, 'latin1').toString('utf8')
      } catch (e) {
        console.warn('文件名编码转换失败:', e.message)
      }
    }
    cb(null, originalname)
  }
})

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ext === '.md' || ext === '.docx' || ext === '.doc' || ext === '.pdf' || ext === '.txt') {
      cb(null, true)
    } else {
      cb(new Error('只支持 .md, .docx, .doc, .pdf, .txt 格式'))
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
})

// RAG 系统（全局引用）
let ragSystem = null

/**
 * 设置 RAG 系统引用
 */
export function setRAGSystem(system) {
  ragSystem = system
}

/**
 * 设置扫码函数引用（避免循环依赖）
 */
export function setScanFunctions(getStatusFn, reloginFn) {
  getScanStatus = getStatusFn
  triggerRelogin = reloginFn
}

// 静态文件服务
app.use(express.static(path.join(process.cwd(), 'public')))

// 解析 JSON
app.use(express.json())

// API: 获取文档列表
app.get('/api/documents', async (req, res) => {
  try {
    const documents = listDocuments(ragDir)
    res.json({ success: true, documents })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 上传文档
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path

    // 如果 RAG 系统已初始化，更新向量库
    if (ragSystem) {
      const chunks = await ragSystem.loader.loadFile(filePath)
      await ragSystem.store.updateDocument(filePath, chunks)
    }

    res.json({
      success: true,
      message: '文档上传成功',
      file: req.file.originalname,
      path: filePath
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 删除文档或文件夹
app.delete('/api/delete', async (req, res) => {
  try {
    const { path: filePath, type } = req.body

    if (!filePath) {
      return res.json({ success: false, error: '缺少文件路径' })
    }

    // 安全检查：只能删除 rag 目录下的文件
    const fullPath = validatePath(filePath)

    // 删除文件或文件夹
    if (fs.existsSync(fullPath)) {
      if (type === 'folder') {
        // 删除文件夹及其所有内容
        fs.rmSync(fullPath, { recursive: true, force: true })
        res.json({ success: true, message: '文件夹删除成功' })
      } else {
        // 删除文件
        fs.unlinkSync(fullPath)

        // 如果 RAG 系统已初始化，更新向量库
        if (ragSystem) {
          await ragSystem.store.deleteDocument(fullPath)
        }

        res.json({ success: true, message: '文档删除成功' })
      }
    } else {
      res.json({ success: false, error: '文件或文件夹不存在' })
    }
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 获取文档内容（仅文本文件）
app.get('/api/content', async (req, res) => {
  try {
    const { path: filePath } = req.query

    if (!filePath) {
      return res.json({ success: false, error: '缺少文件路径' })
    }

    const fullPath = validatePath(filePath)

    const ext = path.extname(fullPath).toLowerCase()

    if (ext === '.md' || ext === '.txt') {
      const content = fs.readFileSync(fullPath, 'utf-8')
      res.json({ success: true, content })
    } else {
      res.json({ success: false, error: '只能查看 .md 和 .txt 文件' })
    }
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 下载文档
app.get('/api/download', async (req, res) => {
  try {
    const { path: filePath } = req.query

    if (!filePath) {
      return res.json({ success: false, error: '缺少文件路径' })
    }

    const fullPath = validatePath(filePath)

    if (!fs.existsSync(fullPath)) {
      return res.json({ success: false, error: '文件不存在' })
    }

    // 获取文件名
    const fileName = path.basename(fullPath)

    // 设置响应头，触发浏览器下载
    res.download(fullPath, fileName, (err) => {
      if (err) {
        console.error('下载失败:', err.message)
      }
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 更新文档内容（仅文本文件）
app.post('/api/update', async (req, res) => {
  try {
    const { path: filePath, content } = req.body

    if (!filePath || !content) {
      return res.json({ success: false, error: '缺少文件路径或内容' })
    }

    const fullPath = validatePath(filePath)

    const ext = path.extname(fullPath).toLowerCase()

    if (ext === '.md' || ext === '.txt') {
      fs.writeFileSync(fullPath, content, 'utf-8')

      // 如果 RAG 系统已初始化，更新向量库
      if (ragSystem) {
        const chunks = await ragSystem.loader.loadFile(fullPath)
        await ragSystem.store.updateDocument(fullPath, chunks)
      }

      res.json({ success: true, message: '文档更新成功' })
    } else {
      res.json({ success: false, error: '只能修改 .md 和 .txt 文件' })
    }
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 创建文件夹
app.post('/api/folder', async (req, res) => {
  try {
    const { name } = req.body

    if (!name) {
      return res.json({ success: false, error: '缺少文件夹名称' })
    }

    const fullPath = path.join(ragDir, name)

    if (fs.existsSync(fullPath)) {
      return res.json({ success: false, error: '文件夹已存在' })
    }

    fs.mkdirSync(fullPath, { recursive: true })
    res.json({ success: true, message: '文件夹创建成功' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 重建索引
app.post('/api/rebuild', async (req, res) => {
  try {
    if (!ragSystem) {
      return res.json({ success: false, error: 'RAG 系统未初始化' })
    }

    // 重新加载所有文档
    const documents = await ragSystem.loader.loadAll()
    await ragSystem.store.init(documents)

    res.json({ success: true, message: '索引重建成功', count: documents.length })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

/**
 * 递归列出所有文档文件
 */
function listDocuments(dir) {
  const result = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(ragDir, fullPath)

    const normalizedPath = relativePath.replace(/\\/g, '/')

    if (entry.isDirectory()) {
      result.push({
        type: 'folder',
        name: entry.name,
        path: normalizedPath,
        children: listDocuments(fullPath)
      })
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      const stat = fs.statSync(fullPath)

      result.push({
        type: 'file',
        name: entry.name,
        path: normalizedPath,
        ext,
        size: stat.size,
        modified: stat.mtime
      })
    }
  }

  // 排序：文件夹在前，文件在后
  result.sort((a, b) => {
    if (a.type === 'folder' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'folder') return 1
    return a.name.localeCompare(b.name)
  })

  return result
}

/**
 * 启动服务器
 */
export function startAdminServer() {
  app.listen(port, () => {
    console.log(`✅ RAG 管理界面已启动: http://localhost:${port}`)
  })
}

// API: 获取机器人配置
app.get('/api/config/bot', async (req, res) => {
  try {
    const configPath = path.join(process.cwd(), 'config.js')
    const content = fs.readFileSync(configPath, 'utf-8')

    // 解析配置
    const botNameMatch = content.match(/export const botName = ['"](.+?)['"]/)
    const roomWhiteListMatch = content.match(/export const roomWhiteList = \[(.+?)\]/s)
    const aliasWhiteListMatch = content.match(/export const aliasWhiteList = \[(.+?)\]/s)
    const questionKeywordsMatch = content.match(/export const questionKeywords = \[(.+?)\]/s)
    const intentModelMatch = content.match(/export const intentModel = ['"](.+?)['"]/)

    // 解析数组
    const parseArray = (str) => {
      if (!str) return []
      return str.split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(s => s)
    }

    res.json({
      success: true,
      config: {
        botName: botNameMatch ? botNameMatch[1] : '',
        roomWhiteList: roomWhiteListMatch ? parseArray(roomWhiteListMatch[1]) : [],
        aliasWhiteList: aliasWhiteListMatch ? parseArray(aliasWhiteListMatch[1]) : [],
        questionKeywords: questionKeywordsMatch ? parseArray(questionKeywordsMatch[1]) : [],
        intentModel: intentModelMatch ? intentModelMatch[1] : 'deepseek-v4-flash',
      }
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 更新机器人配置
app.post('/api/config/bot', async (req, res) => {
  try {
    const { botName, roomWhiteList, aliasWhiteList, questionKeywords, intentModel } = req.body

    if (!botName) {
      return res.json({ success: false, error: '机器人名称不能为空' })
    }

    const configPath = path.join(process.cwd(), 'config.js')

    // 生成新的配置文件内容
    const content = `// 真实微信名
export const botWechatName = 'arXiv'

// 定义机器人的名称，用于从消息中去除@部分（不再要求必须@才回复）
export const botName = '${botName}'

// 群聊白名单，白名单内的群聊才会自动回复
// 支持通配符：* 匹配任意字符序列（包括空），? 匹配单个字符
// 例如：['测试群', '迅力*群', '客户?群']
export const roomWhiteList = [${roomWhiteList.map(s => `'${s}'`).join(', ')}]

// 联系人白名单，白名单内的联系人才会自动回复
export const aliasWhiteList = [${aliasWhiteList.map(s => `'${s}'`).join(', ')}]

// 问题关键词列表（命中任一关键词则直接回复，跳过AI意图识别，节省API调用）
export const questionKeywords = [${(questionKeywords || []).map(s => `'${s}'`).join(', ')}]

// AI意图识别模型（用于判断消息是否为提问，建议用快速廉价模型）
export const intentModel = '${intentModel || 'deepseek-v4-flash'}'
`

    fs.writeFileSync(configPath, content, 'utf-8')
    res.json({ success: true, message: '机器人配置更新成功，重启后生效' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 获取模型配置
app.get('/api/config/model', async (req, res) => {
  try {
    const envPath = path.join(process.cwd(), '.env')
    const content = fs.readFileSync(envPath, 'utf-8')

    // 解析配置
    const getValue = (key) => {
      const match = content.match(new RegExp(`^${key}=['"]?(.+?)['"]?$`, 'm'))
      return match ? match[1] : ''
    }

    res.json({
      success: true,
      config: {
        OPENAI_API_KEY: getValue('OPENAI_API_KEY'),
        OPENAI_BASE_URL: getValue('OPENAI_BASE_URL'),
        MODEL: getValue('MODEL'),
        VISION_MODEL: getValue('VISION_MODEL'),
        VISION_MAX_TOKENS: getValue('VISION_MAX_TOKENS'),
        RAG_MODEL: getValue('RAG_MODEL'),
        RAG_ENABLED: getValue('RAG_ENABLED'),
        RAG_TOP_K: getValue('RAG_TOP_K')
      }
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 更新模型配置
app.post('/api/config/model', async (req, res) => {
  try {
    const { OPENAI_API_KEY, OPENAI_BASE_URL, MODEL, VISION_MODEL, VISION_MAX_TOKENS, RAG_MODEL, RAG_ENABLED, RAG_TOP_K } = req.body

    const envPath = path.join(process.cwd(), '.env')
    let content = fs.readFileSync(envPath, 'utf-8')

    // 更新配置
    const updateValue = (key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm')
      const newLine = `${key}='${value}'`
      if (regex.test(content)) {
        content = content.replace(regex, newLine)
      } else {
        content += `\n${newLine}`
      }
      // 同步更新 process.env（实时生效）
      process.env[key] = value
    }

    if (OPENAI_API_KEY !== undefined) updateValue('OPENAI_API_KEY', OPENAI_API_KEY)
    if (OPENAI_BASE_URL !== undefined) updateValue('OPENAI_BASE_URL', OPENAI_BASE_URL)
    if (MODEL !== undefined) updateValue('MODEL', MODEL)
    if (VISION_MODEL !== undefined) updateValue('VISION_MODEL', VISION_MODEL)
    if (VISION_MAX_TOKENS !== undefined) updateValue('VISION_MAX_TOKENS', VISION_MAX_TOKENS)
    if (RAG_MODEL !== undefined) updateValue('RAG_MODEL', RAG_MODEL)
    if (RAG_ENABLED !== undefined) updateValue('RAG_ENABLED', RAG_ENABLED)
    if (RAG_TOP_K !== undefined) updateValue('RAG_TOP_K', RAG_TOP_K)

    fs.writeFileSync(envPath, content, 'utf-8')
    res.json({ success: true, message: '模型配置更新成功，已实时生效' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 获取微信登录状态
app.get('/api/wechat/status', async (req, res) => {
  try {
    if (!getScanStatus) {
      return res.json({ success: false, error: '微信机器人未初始化' })
    }

    const status = getScanStatus()
    res.json({
      success: true,
      isLoggedIn: status.isLoggedIn,
      scanStatus: status.status,
      qrcode: status.qrcode ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(status.qrcode)}` : null
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 重新登录微信（写入标志文件，由心跳检测执行）
app.post('/api/wechat/relogin', async (req, res) => {
  try {
    const flagPath = path.join(process.cwd(), '.relogin-flag')

    // 写入标志文件
    fs.writeFileSync(flagPath, Date.now().toString(), 'utf-8')

    res.json({ success: true, message: '已触发重新登录，5秒后生效，请刷新状态查看二维码' })
    console.log('🔄 已写入重新登录标志，等待心跳检测执行...')
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 获取消息队列状态
app.get('/api/queue/stats', (req, res) => {
  try {
    const stats = getQueueStats()
    res.json({ success: true, ...stats })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 获取运行配置（支持热加载）
app.get('/api/config/runtime', (req, res) => {
  try {
    res.json({
      success: true,
      config: {
        TASK_EXPIRE_THRESHOLD: process.env.TASK_EXPIRE_THRESHOLD || '120000',
        QUEUE_MAX_LENGTH: process.env.QUEUE_MAX_LENGTH || '10',
        SEND_COOLDOWN: process.env.SEND_COOLDOWN || '0',
        RATE_LIMIT_WINDOW: process.env.RATE_LIMIT_WINDOW || '60000',
        RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX || '20',
        MSG_MAX_AGE: process.env.MSG_MAX_AGE || '60',
        INTENT_MODEL: process.env.INTENT_MODEL || process.env.MODEL || 'deepseek-v4-flash',
        INTENT_TIMEOUT: process.env.INTENT_TIMEOUT || '5000',
      }
    })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})

// API: 更新运行配置（热加载，实时生效）
app.post('/api/config/runtime', (req, res) => {
  try {
    const envPath = path.join(process.cwd(), '.env')
    let content = fs.readFileSync(envPath, 'utf-8')

    const runtimeKeys = [
      'TASK_EXPIRE_THRESHOLD', 'QUEUE_MAX_LENGTH', 'SEND_COOLDOWN',
      'RATE_LIMIT_WINDOW', 'RATE_LIMIT_MAX', 'MSG_MAX_AGE',
      'INTENT_MODEL', 'INTENT_TIMEOUT',
    ]

    const updateValue = (key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm')
      const newLine = `${key}='${value}'`
      if (regex.test(content)) {
        content = content.replace(regex, newLine)
      } else {
        content += `\n${newLine}`
      }
      // 同步更新 process.env（实时生效，无需重启）
      process.env[key] = value
    }

    for (const key of runtimeKeys) {
      if (req.body[key] !== undefined) {
        updateValue(key, req.body[key])
      }
    }

    fs.writeFileSync(envPath, content, 'utf-8')
    res.json({ success: true, message: '运行配置已更新，实时生效' })
  } catch (e) {
    res.json({ success: false, error: e.message })
  }
})