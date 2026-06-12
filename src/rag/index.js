import chokidar from 'chokidar'
import { DocumentLoader } from './loader.js'
import { VectorStore } from './store.js'
import { Configuration, OpenAIApi } from 'openai'
import dotenv from 'dotenv'

// dotenv 配置：不覆盖已存在的环境变量（Docker 传入的）
dotenv.config({ override: false })

const env = process.env

// OpenAI 配置（动态获取）
function getOpenAIConfig() {
  return new Configuration({
    apiKey: env.OPENAI_API_KEY,
    basePath: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  })
}

// RAG 系统提示词
const SYSTEM_PROMPT = `你是一个知识库问答助手。请严格遵循以下规则：
1. 只根据提供的知识库内容回答问题
2. 如果知识库中没有相关信息，请用友好、人性化的语气回复，不要说"报错"、"无法回答"等生硬的话
3. 当遇到不确定或复杂的问题时，轻量引导用户详细描述，比如："这个问题有点复杂，您能再详细说说具体是哪方面吗？"
4. 如果确实无法帮助用户，友善地提醒："这个问题我暂时帮不了您，您可以联系群内管理员进一步处理哦～"
5. 不要编造或推测答案
6. 用自然、友好的语气直接回答问题，不要提及"引用原文"、"根据知识库"等话术
7. 禁止暴露任何文档名称、文件路径、知识库名称等来源信息，不要说"在xxx文档中"、"参考xxx教程"等
8. 直接给出解决方案，不要引导用户去查找其他文档

知识库内容：
{CONTEXT}

请用亲切自然的语气回答用户的问题。`

/**
 * RAG 主模块
 */
export class RAGSystem {
  constructor() {
    this.loader = new DocumentLoader()
    this.store = new VectorStore()
    this.watcher = null
    this.initialized = false
  }

  /**
   * 初始化 RAG 系统
   */
  async init() {
    console.log('🚀 初始化 RAG 系统...')

    // 加载文档
    const documents = await this.loader.loadAll()

    // 初始化向量存储
    await this.store.init(documents)

    // 启动文件监听
    this.startWatcher()

    this.initialized = true
    console.log('✅ RAG 系统初始化完成')
  }

  /**
   * 启动文件监听器
   */
  startWatcher() {
    const ragDir = env.RAG_DIR || './rag'

    this.watcher = chokidar.watch(ragDir, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
    })

    this.watcher
      .on('add', async (filePath) => {
        console.log(`📄 新增文档: ${filePath}`)
        await this.handleFileAdd(filePath)
      })
      .on('change', async (filePath) => {
        console.log(`📝 文档修改: ${filePath}`)
        await this.handleFileChange(filePath)
      })
      .on('unlink', async (filePath) => {
        console.log(`🗑️ 文档删除: ${filePath}`)
        await this.handleFileDelete(filePath)
      })

    console.log(`👀 开始监听目录: ${ragDir}`)
  }

  /**
   * 处理文件新增
   */
  async handleFileAdd(filePath) {
    try {
      const chunks = await this.loader.loadFile(filePath)
      await this.store.updateDocument(filePath, chunks)
    } catch (e) {
      console.error('处理新增文件失败:', e)
    }
  }

  /**
   * 处理文件修改
   */
  async handleFileChange(filePath) {
    try {
      const chunks = await this.loader.loadFile(filePath)
      await this.store.updateDocument(filePath, chunks)
    } catch (e) {
      console.error('处理文件修改失败:', e)
    }
  }

  /**
   * 处理文件删除
   */
  async handleFileDelete(filePath) {
    try {
      await this.store.deleteDocument(filePath)
    } catch (e) {
      console.error('处理文件删除失败:', e)
    }
  }

  /**
   * 检索并生成回答
   * @param {string} question 用户问题
   * @param {Array<{role: string, content: string}>} history 对话历史（可选）
   * @returns {Promise<string>}
   */
  async getReply(question, history = []) {
    if (!this.initialized) {
      return 'RAG 系统尚未初始化，请稍后再试'
    }

    console.log('🔍 开始检索:', question)

    try {
      // 检索相关文档
      const docs = await this.store.search(question)
      console.log(`📚 检索到 ${docs.length} 个相关片段`)

      if (docs.length === 0) {
        return '这个问题我暂时不太了解，您能详细说说具体是哪方面的问题吗？或者您可以联系群内管理员进一步处理哦～'
      }

      // 构建上下文（带长度限制，动态读取配置）
      const maxContextLength = parseInt(env.RAG_MAX_CONTEXT) || 4000 // 默认最大4000字
      let context = ''
      let currentLength = 0

      for (const doc of docs) {
        const chunk = doc.content + '\n\n---\n\n'
        if (currentLength + chunk.length > maxContextLength) {
          // 截断到最大长度
          const remaining = maxContextLength - currentLength
          if (remaining > 100) { // 至少保留100字
            context += chunk.slice(0, remaining)
          }
          break
        }
        context += chunk
        currentLength += chunk.length
      }

      console.log(`📏 上下文长度: ${context.length} 字符 (最大: ${maxContextLength})`)

      // 构建 system prompt
      const systemPrompt = SYSTEM_PROMPT.replace('{CONTEXT}', context)

      // 调用 OpenAI（动态读取模型配置）
      const model = env.RAG_MODEL || 'glm-5'
      const openai = new OpenAIApi(getOpenAIConfig()) // 使用最新配置

      console.log('📤 发送请求到 API, 模型:', model)
      console.log('📤 API URL:', env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
      console.log('📤 Top K:', env.RAG_TOP_K || 5)

      let response
      try {
        // 构建消息数组：system(含知识库上下文) + 历史消息 + 当前用户消息
        const messages = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: question },
        ]
        response = await openai.createChatCompletion({
          model,
          messages,
        })
      } catch (apiError) {
        console.error('❌ API 请求失败:', apiError.message)
        if (apiError.response) {
          console.error('❌ 响应状态:', apiError.response.status)
          console.error('❌ 响应数据:', JSON.stringify(apiError.response.data, null, 2))
        }
        throw apiError
      }

      // 调试：打印响应结构
      console.log('📦 API响应状态:', response?.status)
      console.log('📦 API响应数据:', JSON.stringify(response?.data, null, 2))

      // 兼容多种 API 响应格式
      let reply
      const data = response?.data

      if (!data) {
        console.error('❌ API 响应没有 data 字段, response:', JSON.stringify(response, null, 2))
        throw new Error('API 响应格式错误: 缺少 data 字段')
      }

      // 标准 OpenAI 格式
      if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
        const choice = data.choices[0]
        if (choice?.message?.content) {
          reply = choice.message.content
        } else if (choice?.text) {
          // 某些 API 可能用 text 字段
          reply = choice.text
        } else {
          console.error('❌ choices[0] 格式:', JSON.stringify(choice, null, 2))
          throw new Error('API 返回的 choices 格式无法识别')
        }
      } else if (data.response) {
        // 某些第三方 API 格式
        reply = data.response
      } else if (data.result) {
        // 其他格式
        reply = data.result
      } else if (data.text) {
        reply = data.text
      } else if (data.content) {
        reply = data.content
      } else if (data.message) {
        // 某些 API 直接返回 message 字段
        reply = data.message
      } else {
        console.error('❌ 未知的 API 响应格式:', JSON.stringify(data, null, 2))
        throw new Error('API 返回格式无法识别')
      }

      console.log('💬 回答:', reply)

      return reply
    } catch (e) {
      console.error('RAG 回答生成失败:', e)
      return '哎呀，处理您的问题时遇到一点小状况，稍后再试试？如果还有问题可以联系群内管理员哦～'
    }
  }

  /**
   * 停止监听
   */
  stop() {
    if (this.watcher) {
      this.watcher.close()
    }
  }
}

// 导出单例
let ragSystem = null

export async function initRAG() {
  if (!ragSystem) {
    ragSystem = new RAGSystem()
    await ragSystem.init()
  }
  return ragSystem
}

export async function getRagReply(question, history = []) {
  if (!ragSystem) {
    await initRAG()
  }
  return ragSystem.getReply(question, history)
}