import { WechatyBuilder, ScanStatus, log } from 'wechaty'
import qrTerminal from 'qrcode-terminal'
import { defaultMessage } from './sendMessage.js'
import { startAdminServer, setRAGSystem, setScanFunctions } from '../rag/admin.js'
import { initRAG } from '../rag/index.js'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
const env = dotenv.config().parsed // 环境参数

// ========== 日志时间戳处理 ==========

const originalConsoleLog = console.log
const originalConsoleError = console.error

// 重写 console.log 添加时间戳
console.log = function(...args) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19)
  originalConsoleLog.apply(console, [`[${timestamp}]`, ...args])
}

// 重写 console.error 添加时间戳
console.error = function(...args) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19)
  originalConsoleError.apply(console, [`[${timestamp}]`, ...args])
}

// ========== 变量声明区（放在最前面） ==========

const CHROME_BIN = process.env.CHROME_BIN ? { endpoint: process.env.CHROME_BIN } : {}
let serviceType = ''

// 重连计数器
let restartCount = 0
const MAX_RESTART_COUNT = 3
const BASE_RESTART_INTERVAL = 60000 // 60秒基础间隔
let currentRestartInterval = BASE_RESTART_INTERVAL
let isReconnecting = false // 防止重复重连
let isIntentionalStop = false // 标记是否为主动停止（避免 onLogout 删除凭证）
let isWaitingForScan = false // 标记是否在等待扫码（避免心跳误触发重启）

// 扫码状态管理（供 web 控制台使用）
let currentQrcode = ''
let currentScanStatus = ''

// bot 实例管理
let bot = null

// 消息健康检查
let lastMessageTime = Date.now() // 上次收到消息的时间
let lastHeartbeatLogTime = 0 // 上次心跳日志打印时间（避免日志过多）
const MESSAGE_HEALTH_THRESHOLD = 5 * 60 * 1000 // 5分钟没收到消息认为可能有问题
const HEARTBEAT_LOG_INTERVAL = 5 * 60 * 1000 // 心跳日志间隔（5分钟）

// 超时错误计数器（避免单次超时就重启）
let timeoutErrorCount = 0
const TIMEOUT_THRESHOLD = 3 // 连续3次超时才触发重启

// 登录就绪标志 & 积压消息队列
let isLoginReady = false // 登录稳定后才处理消息，避免过渡期系统消息
const pendingMessages = [] // 登录未就绪时暂存的消息
const LOGIN_STABILIZE_DELAY = 3000 // 登录后3秒稳定期，等 puppet 完成同步
const PENDING_MSG_MAX_AGE = 5 * 60 * 1000 // 积压消息最大容忍5分钟（断开期间的消息）

// ========== 函数定义区 ==========

// 创建 bot 实例
function createBot() {
  return WechatyBuilder.build({
    name: 'WechatEveryDay',
    puppet: 'wechaty-puppet-wechat4u',
    puppetOptions: {
      uos: true,
      ...CHROME_BIN
    },
  })
}

// 绑定事件（统一管理）
function bindBotEvents(botInstance) {
  // 移除旧监听器（防止重复绑定）
  botInstance.removeAllListeners()

  botInstance.on('scan', onScan)
  botInstance.on('login', onLogin)
  botInstance.on('logout', onLogout)
  botInstance.on('message', onMessage)
  botInstance.on('friendship', onFriendShip)

  // 监听 puppet 断开事件
  botInstance.on('error', (error) => {
    console.error('❌ Bot error:', error)
    const errorMsg = error.message || error.details || ''

    // 如果正在重连中，忽略所有错误（避免重连锁）
    if (isReconnecting) {
      console.log('⚠️ 正在重连中，忽略此错误')
      return
    }

    // 超时错误处理（累积后才触发重启，避免网络波动误判）
    if (errorMsg.includes('timeout')) {
      timeoutErrorCount++
      console.log(`⏱️ 超时错误计数: ${timeoutErrorCount}/${TIMEOUT_THRESHOLD}`)

      if (timeoutErrorCount >= TIMEOUT_THRESHOLD) {
        console.log('🔄 连续超时次数过多，触发重连...')
        timeoutErrorCount = 0
        attemptRestart()
      }
      return
    }

    // 其他严重错误（断开连接、网络问题）
    if (errorMsg.includes('disconnect') || errorMsg.includes('network')) {
      console.log('🔄 检测到严重连接错误，触发重连...')
      attemptRestart()
    }
  })

  // 监听心跳事件（如果 puppet 支持）
  botInstance.on('heartbeat', (data) => {
    console.log('💓 心跳:', data)
  })

  console.log('✅ 事件监听器已绑定')
}

// 扫码
function onScan(qrcode, status) {
  currentQrcode = qrcode
  currentScanStatus = ScanStatus[status]

  // 进入扫码等待状态（防止心跳误触发重启）
  if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
    isWaitingForScan = true
    qrTerminal.generate(qrcode, { small: true })
    const qrcodeImageUrl = ['https://api.qrserver.com/v1/create-qr-code/?data=', encodeURIComponent(qrcode)].join('')
    console.log('onScan:', qrcodeImageUrl, ScanStatus[status], status)
  } else if (status === ScanStatus.Scanned) {
    // 已扫码待确认，仍在等待中
    console.log('📱 已扫码，等待确认...')
  } else {
    log.info('onScan: %s(%s)', ScanStatus[status], status)
  }
}

// 登录
function onLogin(user) {
  currentQrcode = ''
  currentScanStatus = ''
  isWaitingForScan = false // 扫码完成，清除等待标志
  console.log(`${user} has logged in`)
  const date = new Date()
  console.log(`Current time:${date}`)
  console.log(`Automatic robot chat mode has been activated`)

  // 登录成功，重置重连计数器
  restartCount = 0
  currentRestartInterval = BASE_RESTART_INTERVAL
  isReconnecting = false

  // 等待稳定期后再开始处理消息（避免登录同步期的系统消息干扰）
  setTimeout(() => {
    isLoginReady = true
    console.log('✅ 登录稳定期结束，开始正常处理消息')

    // 处理断开期间积压的消息
    if (pendingMessages.length > 0) {
      console.log(`📦 发现 ${pendingMessages.length} 条积压消息，开始批量处理...`)
      const now = Date.now()
      // 过滤掉超过最大容忍时间的过期积压消息
      const validPending = pendingMessages.filter(msg => {
        const msgTime = 1e3 * msg.payload.timestamp
        const age = now - msgTime
        return age < PENDING_MSG_MAX_AGE
      })
      const expiredCount = pendingMessages.length - validPending.length
      if (expiredCount > 0) {
        console.log(`⏭️ 跳过 ${expiredCount} 条过期积压消息（超过5分钟）`)
      }
      pendingMessages.length = 0 // 清空队列

      // 并发处理积压消息（队列系统保证同群串行发送）
      validPending.forEach(msg => {
        defaultMessage(msg, bot, serviceType).catch(e => {
          console.error('❌ 积压消息处理错误:', e)
        })
      })
      console.log(`✅ 已提交 ${validPending.length} 条积压消息处理`)
    }
  }, LOGIN_STABILIZE_DELAY)
}

// 登出
function onLogout(user) {
  isLoginReady = false // 重置登录就绪标志
  pendingMessages.length = 0 // 清空积压消息队列
  isWaitingForScan = false
  console.log(`${user} has logged out`)

  // 如果是主动停止（重连流程中），不要重复触发重启
  if (isIntentionalStop) {
    console.log('🔄 主动停止触发的登出，由重连流程处理...')
    return
  }

  console.log('🔄 检测到异常登出，清除登录凭证并触发重连...')

  // 清除 memory 文件，避免用过期凭证尝试恢复导致反复失败
  const memoryPath = path.join(process.cwd(), 'WechatEveryDay.memory-card.json')
  try {
    if (fs.existsSync(memoryPath)) {
      fs.unlinkSync(memoryPath)
      console.log('🗑️ 已清除登录凭证文件，下次将需要扫码登录')
    }
  } catch (e) {
    console.log('⚠️ 清除凭证文件失败:', e.message)
  }

  attemptRestart()
}

// 收到好友请求
async function onFriendShip(friendship) {
  const frienddShipRe = /chatgpt|chat/
  if (friendship.type() === 2) {
    if (frienddShipRe.test(friendship.hello())) {
      await friendship.accept()
    }
  }
}

// 消息发送
async function onMessage(msg) {
  // 更新消息健康检查时间
  lastMessageTime = Date.now()

  // 登录未就绪时，暂存消息而非丢弃
  if (!isLoginReady) {
    console.log('⏳ 登录尚未就绪，暂存消息等待稳定期后处理')
    pendingMessages.push(msg)
    return
  }

  // 不 await，让消息处理并发进行，队列系统保证同群串行发送
  defaultMessage(msg, bot, serviceType).catch(e => {
    console.error('❌ 消息处理错误:', e)
  })
}

// 导出扫码状态获取函数（供 admin.js 使用）
export function getScanStatus() {
  if (!bot) {
    return { qrcode: '', status: '', isLoggedIn: false }
  }
  return {
    qrcode: currentQrcode,
    status: currentScanStatus,
    isLoggedIn: bot.isLoggedIn
  }
}

// 导出重新登录函数（供 admin.js 使用）
export function triggerRelogin() {
  console.log('🔄 Web 控制台触发重新登录...')
  restartCount = 0
  currentRestartInterval = BASE_RESTART_INTERVAL
  return { success: true, message: '已触发重新登录，请稍后刷新状态' }
}

// 执行重新登录（由心跳检测调用）
async function executeRelogin() {
  if (isReconnecting) {
    console.log('⚠️ 正在重连中，跳过重新登录请求')
    return
  }

  console.log('🔄 执行重新登录...')
  isReconnecting = true
  isLoginReady = false // 重置登录就绪标志
  restartCount = 0
  currentRestartInterval = BASE_RESTART_INTERVAL

  try {
    console.log('⏹️ 正在停止机器人...')
    isIntentionalStop = true // 标记主动停止，防止 onLogout 重复处理
    await bot.stop()
    isIntentionalStop = false
    console.log('⏹️ 机器人已停止，等待5秒后重启...')

    await new Promise(resolve => setTimeout(resolve, 5000))

    // 检查是否需要清除 memory（保留登录数据尝试恢复）
    const memoryPath = path.join(process.cwd(), 'WechatEveryDay.memory-card.json')
    let shouldCleanMemory = false
    try {
      if (fs.existsSync(memoryPath)) {
        const memoryData = JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
        const puppetData = memoryData['\rpuppet\nPUPPET-WECHAT4U']
        // 如果登录数据过期（通常 sid 会过期），清除 memory
        if (!puppetData?.PROP?.sid || puppetData.PROP.sid.length < 10) {
          shouldCleanMemory = true
          console.log('⚠️ 登录数据可能已过期，清除 memory...')
          fs.unlinkSync(memoryPath)
        }
      }
    } catch (e) {
      console.log('⚠️ 检查 memory 失败，保留文件:', e.message)
    }

    // 重新构建 bot 实例并绑定事件
    console.log('🔄 重新构建机器人实例...')
    bot = createBot()
    bindBotEvents(bot)

    console.log('🔄 正在启动机器人...')
    await bot.start()

    if (!shouldCleanMemory) {
      console.log('✅ 机器人已重新启动，尝试恢复登录状态...')
    } else {
      console.log('✅ 机器人已重新启动，等待扫码...')
    }

    isReconnecting = false
  } catch (e) {
    console.error('❌ 重新登录失败:', e)
    isReconnecting = false
    setTimeout(() => attemptRestart(), 10000)
  }
}

// 启动微信机器人
function botStart() {
  bot
    .start()
    .then(() => {
      console.log('Start to log in wechat...')
      restartCount = 0
      currentRestartInterval = BASE_RESTART_INTERVAL
    })
    .catch((e) => {
      console.error('❌ 启动失败:', e)
      attemptRestart()
    })
}

// 尝试重启（渐进式延迟 + 尝试恢复登录状态）
async function attemptRestart() {
  // 防止重复重连
  if (isReconnecting) {
    console.log('⚠️ 正在重连中，跳过本次重启请求')
    return
  }
  isReconnecting = true
  isLoginReady = false // 重置登录就绪标志

  if (restartCount >= MAX_RESTART_COUNT) {
    console.error(`❌ 重启次数已达上限(${MAX_RESTART_COUNT}次)，请手动扫码重新登录`)
    isReconnecting = false
    return
  }

  restartCount++
  currentRestartInterval = Math.min(BASE_RESTART_INTERVAL * Math.pow(2, restartCount - 1), 300000)
  console.log(`🔄 尝试重启 (${restartCount}/${MAX_RESTART_COUNT})，等待${currentRestartInterval/1000}秒...`)

  await new Promise(resolve => setTimeout(resolve, currentRestartInterval))

  try {
    console.log('🔄 尝试恢复连接...')

    // 检查 memory 文件是否存在登录数据
    const memoryPath = path.join(process.cwd(), 'WechatEveryDay.memory-card.json')
    let hasLoginData = false
    let memoryAge = 0
    try {
      if (fs.existsSync(memoryPath)) {
        const stats = fs.statSync(memoryPath)
        memoryAge = Date.now() - stats.mtimeMs
        const memoryData = JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
        // 检查是否存在有效的登录凭证
        const puppetData = memoryData['\rpuppet\nPUPPET-WECHAT4U']
        if (puppetData?.PROP?.uin && puppetData?.COOKIE?.wxuin) {
          // 额外检查：凭证是否太旧（超过 120 分钟很可能是过期的）
          if (memoryAge > 120 * 60 * 1000) {
            console.log(`⚠️ 登录凭证已过期（更新于 ${(memoryAge/60000).toFixed(1)} 分钟前），清除凭证文件`)
            fs.unlinkSync(memoryPath)
          } else {
            hasLoginData = true
            console.log(`✅ 发现有效登录凭证（文件更新于 ${(memoryAge/60000).toFixed(1)} 分钟前）`)
          }
        }
      }
    } catch (e) {
      console.log('⚠️ 无法读取 memory 文件:', e.message)
    }

    // 先停止当前实例
    console.log('⏹️ 正在停止机器人...')
    isIntentionalStop = true // 标记主动停止，防止 onLogout 重复触发重启
    try {
      await bot.stop()
    } catch (e) {
      console.log('⚠️ 停止时出现错误（可忽略）:', e.message)
    }
    isIntentionalStop = false
    console.log('⏹️ 机器人已停止，等待5秒...')
    await new Promise(resolve => setTimeout(resolve, 5000))

    // 关键：总是重建 bot 实例，确保 memory 被正确加载
    // puppet-wechat4u 在 onStart() 时会自动加载 memory 并调用 wechat4u.restart() 恢复登录
    console.log('🔄 重新构建机器人实例...')
    bot = createBot()
    bindBotEvents(bot)

    console.log('🔄 正在启动机器人...')
    await bot.start()

    if (hasLoginData) {
      console.log('✅ 机器人已启动，使用 memory 数据尝试恢复登录...')
    } else {
      console.log('✅ 机器人已启动，无登录数据，等待扫码...')
      isWaitingForScan = true // 无凭证时进入扫码等待
    }

    // 不立刻重置计数器，等确认登录成功后再重置
    // restartCount 和 currentRestartInterval 在 onLogin 中重置

    // 先释放重连锁，让心跳检测和事件能正常工作
    isReconnecting = false

    // 检查登录状态（给予更长时间让 puppet 恢复）
    setTimeout(async () => {
      if (bot.isLoggedIn) {
        console.log('✅ 恢复后登录状态正常')
        restartCount = 0
        currentRestartInterval = BASE_RESTART_INTERVAL
      } else {
        console.log('⚠️ 恢复后未登录，可能需要重新扫码（session 可能已过期）')
        // 如果用旧凭证恢复失败，清除凭证文件，下次走扫码流程
        if (hasLoginData) {
          console.log('🗑️ 凭证恢复失败，清除凭证文件，下次将走扫码流程')
          try {
            if (fs.existsSync(memoryPath)) {
              fs.unlinkSync(memoryPath)
            }
          } catch (e) { /* ignore */ }
        }
      }
    }, 20000)

  } catch (e) {
    console.error('❌ 恢复失败:', e)
    isReconnecting = false
    attemptRestart()
  }
}

// 控制启动
function handleStart(type) {
  serviceType = type
  console.log('🌸🌸🌸 / type: ', type)
  switch (type) {
    case 'ChatGPT':
      if (env.OPENAI_API_KEY) return botStart()
      console.log('❌ 请先配置.env文件中的 OPENAI_API_KEY')
      break
    case 'Kimi':
      if (env.KIMI_API_KEY) return botStart()
      console.log('❌ 请先配置.env文件中的 KIMI_API_KEY')
      break
    default:
      console.log('🚀服务类型错误')
  }
}

// ========== 初始化区 ==========

function init() {
  // 初始化 bot
  bot = createBot()
  bindBotEvents(bot)

  // 启动管理后台
  startAdminServer()
  if (env.RAG_ENABLED === 'true') {
    initRAG().then(system => setRAGSystem(system))
  }

  // 设置扫码状态获取函数
  setScanFunctions(getScanStatus, triggerRelogin)

  // 全局错误处理
  process.on('uncaughtException', (err) => {
    console.error('❌ 未捕获异常:', err.message)

    // puppet-wechat4u 内部错误：bot.stop() 后底层对象被销毁，但内部定时器仍尝试访问
    // 这是停止过程中的正常竞态，不需要重启
    if (err.message && err.message.includes("Cannot read properties of undefined (reading 'start')")) {
      console.log('⚠️ puppet-wechat4u 内部竞态错误（停止后触发），已忽略')
      return
    }

    if (
      err.message.includes('timeout') ||
      err.message.includes('状态同步') ||
      err.message.includes('网络') ||
      err.message.includes('断开') ||
      err.code === 2
    ) {
      console.log('🔄 微信连接异常，尝试重启...')
      attemptRestart()
      return
    }

    console.error('❌ 严重错误:', err)
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未处理的 Promise 拒绝:', reason)
    const reasonStr = reason?.message || String(reason)

    // puppet-wechat4u 内部竞态错误，忽略
    if (reasonStr.includes("Cannot read properties of undefined (reading 'start')")) {
      console.log('⚠️ puppet-wechat4u 内部竞态错误（停止后触发），已忽略')
      return
    }

    // 超时错误累积计数，不立即重启
    if (reasonStr.includes('timeout') || reason?.code === 2) {
      timeoutErrorCount++
      console.log(`⏱️ Promise 超时计数: ${timeoutErrorCount}/${TIMEOUT_THRESHOLD}`)
      if (timeoutErrorCount >= TIMEOUT_THRESHOLD) {
        console.log('🔄 连续超时过多，尝试重启微信连接...')
        timeoutErrorCount = 0
        attemptRestart()
      }
    }
  })

  // 增强的心跳检测（检查登录状态 + 消息健康）
  setInterval(async () => {
    try {
      if (!bot) return
      const isLoggedIn = bot.isLoggedIn

      // 检查登录状态
      if (!isLoggedIn) {
        // 如果正在等待扫码，不要触发重启（扫码需要时间）
        if (isWaitingForScan) {
          console.log('⏳ 正在等待扫码登录，跳过重启...')
          return
        }
        // 如果正在重连中，不要重复触发
        if (isReconnecting) {
          return
        }
        console.log('⚠️ 检测到未登录状态，尝试重启...')
        attemptRestart()
        return
      }

      // 清零超时计数（连接正常说明之前的超时是暂时的）
      if (timeoutErrorCount > 0) {
        timeoutErrorCount = 0
        console.log('✅ 连接恢复正常，超时计数已清零')
      }

      // 消息健康状态仅记录日志，不触发重启（没收到消息不代表连接异常）
      const timeSinceLastMessage = Date.now() - lastMessageTime
      const timeSinceLastLog = Date.now() - lastHeartbeatLogTime

      // 只在以下情况打印日志：
      // 1. 超过 HEARTBEAT_LOG_INTERVAL（5分钟）没打印日志
      // 2. 刚收到消息（状态变化）
      const shouldLog = timeSinceLastLog >= HEARTBEAT_LOG_INTERVAL || timeSinceLastMessage < 60000

      if (shouldLog) {
        lastHeartbeatLogTime = Date.now()
        if (timeSinceLastMessage > MESSAGE_HEALTH_THRESHOLD) {
          console.log(`ℹ️ 已 ${(timeSinceLastMessage/60000).toFixed(1)} 分钟未收到新消息（正常，等待用户发送）`)
        } else {
          console.log(`✅ 心跳检测正常，已登录，最近 ${(timeSinceLastMessage/1000).toFixed(0)} 秒收到消息`)
        }
      }
    } catch (e) {
      console.error('❌ 心跳检测失败:', e)
      // 仅在严重错误时才重启
      if (e.message && e.message.includes('logout')) {
        attemptRestart()
      }
    }
  }, 60000)

  // 检查重新登录标志文件（每5秒）
  setInterval(async () => {
    try {
      const flagPath = path.join(process.cwd(), '.relogin-flag')
      if (fs.existsSync(flagPath)) {
        console.log('🔄 发现重新登录标志文件，执行重新登录...')
        fs.unlinkSync(flagPath)
        await executeRelogin()
      }
    } catch (e) {
      console.error('❌ 重新登录标志检测失败:', e)
    }
  }, 5000)

  // 默认使用 ChatGPT
  if (env.OPENAI_API_KEY) {
    handleStart('ChatGPT')
  } else {
    console.log('❌ 请先配置.env文件中的 OPENAI_API_KEY')
  }
}

init()