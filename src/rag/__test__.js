import { initRAG, getRagReply } from './index.js'

async function test() {
  console.log('🧪 开始测试 RAG 系统...')

  try {
    // 初始化 RAG
    await initRAG()

    // 测试问答
    const questions = [
      '你好',
      '这是什么系统？',
      '如何使用这个机器人？',
    ]

    for (const q of questions) {
      console.log('\n❓ 问题:', q)
      const reply = await getRagReply(q)
      console.log('💬 回答:', reply)
    }
  } catch (e) {
    console.error('测试失败:', e)
  }

  process.exit(0)
}

test()