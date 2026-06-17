import { remark } from 'remark'
import stripMarkdown from 'strip-markdown'
import { Configuration, OpenAIApi } from 'openai'
import { getRagReply } from '../rag/index.js'
import { withRetry } from '../utils/retry.js'
import dotenv from 'dotenv'
dotenv.config() // 加载环境变量
const env = process.env // 使用 process.env 而不是 dotenv.config().parsed

// OpenAI 配置（动态获取）
function getOpenAIConfig() {
  return new Configuration({
    apiKey: env.OPENAI_API_KEY,
    basePath: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  })
}

// RAG 是否启用（由 wechaty/index.js 统一初始化）
const ragEnabled = env.RAG_ENABLED === 'true'

// 系统提示词（售后客服人设，不暴露机器人身份）
const SYSTEM_PROMPT = `你是一名专业、严谨的售后客服人员。请遵循以下规则：
1. 用专业、规范的口吻回答客户问题，表述准确、条理清晰，避免口语化、随意或轻浮的表达。
2. 始终以客服人员身份自然交流，绝不透露你是 AI、机器人、智能助手或程序，也不要提及任何系统、模型、后台或资料来源。
3. 遇到不确定或无法回答的问题，不要说"报错""无法回答""系统异常"等生硬的话，也禁止使用"哈哈""嘻嘻""哦～""呀""呢"等语气词。
4. 引导客户详细描述复杂问题，例如："请您进一步描述具体问题，以便我为您提供准确的解答。"
5. 如果确实无法帮助客户，礼貌告知："该问题暂时无法处理，建议您联系群内管理员进一步协助。"
6. 回答简洁明了、直击要点，称呼客户为"您"。禁止使用表情符号、网络用语或任何不正式的措辞。`

// Vision 系统提示词
const VISION_SYSTEM_PROMPT = `你是一名专业、严谨的售后客服助手，具备图片理解能力。请遵循以下规则：
1. 仔细分析用户发送的图片内容
2. 用专业、规范的语气回答关于图片的问题，表述准确、条理清晰
3. 如果图片不清晰或无法理解，礼貌地请用户重新发送或提供更多说明
4. 回答简洁明了，避免冗长，禁止使用表情符号和语气词`

// 视频理解系统提示词
const VIDEO_SYSTEM_PROMPT = `你是一名专业、严谨的售后客服助手，具备视频理解能力。用户会发送视频的多个关键帧截图，你需要：
1. 仔细分析这些关键帧，综合理解视频的整体内容
2. 用专业、规范的语气回答关于视频的问题，表述准确、条理清晰
3. 如果视频内容不清晰或无法理解，礼貌地请用户重新发送或提供更多说明
4. 回答简洁明了，避免冗长，禁止使用表情符号和语气词`

// AI意图识别系统提示词
const INTENT_SYSTEM_PROMPT = `你是一个消息意图分类器。判断用户消息是否是真实的提问或求助。

分类规则：
- 是提问/求助：用户在询问问题、寻求帮助、报告故障、请求指导
- 不是提问/求助：闲聊、打招呼、表情包、陈述事实、通知、转发、广告、无意义内容

只回复 JSON：{"is_question": true} 或 {"is_question": false}
不要回复任何其他内容。`

export async function getGptReply(prompt, history = []) {
  console.log('🚀🚀🚀 / prompt', prompt)

  // 如果启用 RAG，使用 RAG 回答
  if (ragEnabled) {
    return await getRagReply(prompt, history)
  }

  // 原有逻辑
  const chosen_model = env.MODEL || 'glm-5'
  let reply = ''

  try {
    // 每次调用时重新创建配置，确保使用最新的环境变量
    const openai = new OpenAIApi(getOpenAIConfig())

    if (chosen_model == 'text-davinci-003') {
      console.log('🚀🚀🚀 / Using model', chosen_model)
      const response = await openai.createCompletion({
        model: chosen_model,
        prompt: prompt,
        temperature: 0.8,
        max_tokens: 4_000,
        top_p: 1,
        frequency_penalty: 0.0,
        presence_penalty: 0.6,
        stop: [' Human:', ' AI:'],
      })

      reply = markdownToText(response.data.choices[0].text)
    } else if (chosen_model == 'glm-5') {
      console.log('🚀🚀🚀 / Using model', chosen_model)
      // 构建消息数组：system + 历史消息 + 当前用户消息
      const messages = [
        { "role": "system", content: SYSTEM_PROMPT },
        ...history,
        { "role": "user", content: prompt }
      ]
      const response = await openai.createChatCompletion({
        model: chosen_model,
        messages,
      })

      reply = markdownToText(response.data.choices[0].message.content)
    }
    console.log('🚀🚀🚀 / reply', reply)
    return reply
  } catch (e) {
    console.error('❌ API 调用失败:', e)
    return '哎呀，处理您的问题时遇到一点小状况，稍后再试试？如果还有问题可以联系群内管理员哦～'
  }
}

/**
 * 图片理解接口
 * @param imageBase64 图片的 base64 编码（不含 data:image/xxx;base64, 前缀）
 * @param mimeType 图片类型，如 'image/jpeg', 'image/png'
 * @param prompt 用户的问题/提示
 * @returns {Promise<string>}
 */
export async function getVisionReply(imageBase64, mimeType, prompt = '请描述这张图片的内容', history = []) {
  // 动态读取配置（支持热更新）
  const visionModel = env.VISION_MODEL || 'qwen3.6-plus'
  const visionMaxTokens = parseInt(env.VISION_MAX_TOKENS) || 1000

  console.log('🚀🚀🚀 / Vision prompt:', prompt)
  console.log('🚀🚀🚀 / Vision model:', visionModel)

  try {
    const openai = new OpenAIApi(getOpenAIConfig())

    // 构建 vision 消息格式
    const messages = [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      ...history,
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`
            }
          }
        ]
      }
    ]

    const response = await openai.createChatCompletion({
      model: visionModel,
      messages,
      max_tokens: visionMaxTokens
    })

    const reply = markdownToText(response.data.choices[0].message.content)
    console.log('🚀🚀🚀 / Vision reply:', reply)
    return reply
  } catch (e) {
    console.error('❌ Vision API 调用失败:', e)
    // 如果 vision 模型不可用，提示用户
    if (e.message?.includes('model') || e.status === 404) {
      return '抱歉，图片理解功能暂时不可用，请检查 VISION_MODEL 配置是否正确。'
    }
    return '抱歉，处理图片时遇到一点问题，请稍后再试。'
  }
}

/**
 * 视频理解接口（多帧）
 * @param {Array<{imageBase64: string, mimeType: string}>} frames 视频关键帧数组
 * @param {string} prompt 用户的问题/提示
 * @param {Array<{role: string, content: string}>} history 对话历史（可选）
 * @returns {Promise<string>}
 */
export async function getVideoReply(frames, prompt = '请描述这个视频的内容', history = []) {
  const visionModel = env.VISION_MODEL || 'qwen3.6-plus'
  const visionMaxTokens = parseInt(env.VISION_MAX_TOKENS) || 1000

  console.log('🎬 Video reply - frames:', frames.length, 'prompt:', prompt)
  console.log('🎬 Video model:', visionModel)

  try {
    const openai = new OpenAIApi(getOpenAIConfig())

    // 构建多帧视频消息格式
    const userContent = [
      { type: 'text', text: prompt }
    ]

    // 添加每一帧作为图片
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]
      userContent.push({
        type: 'text',
        text: `第 ${i + 1} 帧（共 ${frames.length} 帧）：`
      })
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${frame.mimeType};base64,${frame.imageBase64}`
        }
      })
    }

    const messages = [
      { role: 'system', content: VIDEO_SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userContent }
    ]

    const response = await openai.createChatCompletion({
      model: visionModel,
      messages,
      max_tokens: visionMaxTokens
    })

    const reply = markdownToText(response.data.choices[0].message.content)
    console.log('🎬 Video reply:', reply)
    return reply
  } catch (e) {
    console.error('❌ Video API 调用失败:', e)
    if (e.message?.includes('model') || e.status === 404) {
      return '抱歉，视频理解功能暂时不可用，请检查 VISION_MODEL 配置是否正确。'
    }
    return '抱歉，处理视频时遇到一点问题，请稍后再试。'
  }
}

/**
 * AI意图识别（判断消息是否为提问）
 * 使用轻量模型 + 低 max_tokens，控制成本
 * Fail-open策略：任何错误或解析失败默认返回 true（避免遗漏真实提问）
 * @param {string} content 消息内容
 * @returns {Promise<boolean>} 是否为提问
 */
export async function classifyIntent(content) {
  const model = env.INTENT_MODEL || env.MODEL || 'deepseek-v4-flash'
  const intentTimeout = parseInt(env.INTENT_TIMEOUT) || 5000

  try {
    const openai = new OpenAIApi(getOpenAIConfig())

    // openai v3 的 createChatCompletion 第二个参数是 axios config
    // 使用 axios timeout 而非 AbortController（v3 兼容性更好）
    const response = await openai.createChatCompletion(
      {
        model,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: `判断以下消息是否是提问或求助：\n"${content}"\n\n只回复 JSON。` },
        ],
        max_tokens: 20,
        temperature: 0,
      },
      { timeout: intentTimeout }
    )

    const text = response.data.choices[0].message.content.trim()
    console.log('🧠 意图识别原始响应:', text)

    // 尝试解析 JSON
    const match = text.match(/"is_question"\s*:\s*(true|false)/)
    if (match) {
      const result = match[1] === 'true'
      console.log(`🧠 意图识别结果: ${result ? '提问' : '非提问'}`)
      return result
    }

    // 尝试直接 JSON.parse
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.is_question === 'boolean') {
        console.log(`🧠 意图识别结果: ${parsed.is_question ? '提问' : '非提问'}`)
        return parsed.is_question
      }
    } catch (_e) {
      // ignore
    }

    // 解析失败，fail-open
    console.log('⚠️ 意图识别响应无法解析，默认视为提问。响应:', text)
    return true
  } catch (e) {
    // 超时或网络错误，fail-open
    if (e.code === 'ECONNABORTED') {
      console.warn('⚠️ 意图识别超时，默认视为提问')
    } else {
      console.error('❌ 意图识别错误，默认视为提问:', e.message)
    }
    return true
  }
}

function markdownToText(markdown) {
  return remark()
    .use(stripMarkdown)
    .processSync(markdown ?? '')
    .toString()
}


