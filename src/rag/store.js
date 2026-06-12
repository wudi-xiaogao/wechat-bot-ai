import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { pipeline, env } from '@xenova/transformers'

// dotenv 配置：不覆盖已存在的环境变量
dotenv.config({ override: false })

// 设置 Hugging Face 镜像源（国内加速）
env.allowLocalModels = false
env.remoteHost = process.env.HF_MIRROR || 'https://hf-mirror.com'
env.remotePathTemplate = '{model}/resolve/{revision}/'

const envVars = process.env

/**
 * 本地向量存储
 * 使用 @xenova/transformers 在本地生成 embedding
 * 无需外部依赖，真正的向量语义检索
 */
export class VectorStore {
  constructor() {
    this.documents = []
    this.embeddings = []
    this.metadata = []
    this.topK = parseInt(envVars.RAG_TOP_K) || 5

    // 模型单例
    this.model = null
    this.modelName = envVars.EMBEDDING_MODEL || 'Xenova/multilingual-e5-small'
    this.useEmbedding = false

    // 向量持久化路径
    this.vectorPath = envVars.VECTOR_PATH || './data/vectors.json'

    // TF-IDF 降级方案
    this.useTFIDF = false
    this.docWordFreq = []
    this.wordFreq = new Map()
  }

  /**
   * 加载 embedding 模型（单例）
   */
  async loadModel() {
    if (this.model) return this.model

    console.log(`📦 加载 embedding 模型: ${this.modelName}`)
    console.log(`⏳ 首次运行需要下载模型（约 120MB），请耐心等待...`)

    try {
      this.model = await pipeline('feature-extraction', this.modelName, {
        quantized: true,  // 使用量化模型，减小体积
        progress_callback: (progress) => {
          if (progress.status === 'downloading') {
            const percent = Math.round((progress.loaded / progress.total) * 100)
            if (percent % 10 === 0) {
              console.log(`📥 下载进度: ${percent}%`)
            }
          }
        }
      })

      console.log(`✅ 模型加载完成`)
      this.useEmbedding = true
      return this.model

    } catch (e) {
      console.error(`❌ 模型加载失败: ${e.message}`)
      console.log(`⚠️ 将使用 TF-IDF 关键词检索作为降级方案`)
      this.useTFIDF = true
      this.useEmbedding = false
      return null
    }
  }

  /**
   * 生成文本的 embedding 向量
   * @param {string|string[]} texts - 单个文本或文本数组
   * @returns {Promise<number[][]>}
   */
  async generateEmbeddings(texts) {
    if (!this.useEmbedding || !this.model) {
      return texts.map(() => [])
    }

    const results = []
    const inputTexts = Array.isArray(texts) ? texts : [texts]

    for (const text of inputTexts) {
      try {
        const output = await this.model(text, {
          pooling: 'mean',
          normalize: true
        })
        results.push(Array.from(output.data))
      } catch (e) {
        console.error(`生成 embedding 失败: ${e.message}`)
        results.push([])
      }
    }

    return results
  }

  /**
   * 计算两个向量的余弦相似度
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  /**
   * 初始化向量存储
   * @param {Array<{content: string, source: string, metadata: object}>} documents
   */
  async init(documents) {
    console.log('🔄 正在初始化向量存储...')

    this.documents = documents.map(d => d.content)
    this.metadata = documents.map(d => ({
      source: d.source,
      ...d.metadata
    }))

    // 尝试加载模型
    await this.loadModel()

    // 尝试加载已保存的向量
    const loaded = await this.loadVectors()

    if (loaded && this.embeddings.length === documents.length) {
      console.log(`✅ 加载已保存的向量: ${this.embeddings.length} 个文档`)
    } else if (this.useEmbedding) {
      // 生成新的向量
      console.log(`⏳ 正在生成向量: ${documents.length} 个文档片段...`)

      this.embeddings = await this.generateEmbeddings(this.documents)

      // 过滤失败的向量
      let successCount = 0
      for (let i = 0; i < this.embeddings.length; i++) {
        if (this.embeddings[i].length > 0) {
          successCount++
        }
      }

      console.log(`✅ 向量生成完成: ${successCount}/${documents.length} 个成功`)

      // 保存向量
      await this.saveVectors()
    }

    // 如果 embedding 不可用，使用 TF-IDF
    if (!this.useEmbedding || this.embeddings.every(e => e.length === 0)) {
      this.useTFIDF = true
      this.initTFIDF()
    }

    console.log(`✅ 向量存储初始化完成`)
    console.log(`📊 检索模式: ${this.useTFIDF ? 'TF-IDF 关键词' : 'Embedding 向量'}`)
  }

  /**
   * 初始化 TF-IDF（降级方案）
   */
  initTFIDF() {
    console.log('🔄 初始化 TF-IDF 关键词检索...')

    this.docWordFreq = []
    const allWords = []

    for (const doc of this.documents) {
      const words = this.tokenize(doc)
      allWords.push(...words)
      this.docWordFreq.push(this.computeWordFreq(words))
    }

    this.wordFreq = this.computeWordFreq(allWords)
    console.log(`✅ TF-IDF 初始化完成，${this.wordFreq.size} 个关键词`)
  }

  /**
   * 检索相关文档
   * @param {string} query - 查询文本
   * @param {number} topK - 返回文档数量
   * @returns {Promise<Array<{content: string, source: string, score: number}>>}
   */
  async search(query, topK = null) {
    if (this.documents.length === 0) {
      return []
    }

    // 动态读取配置（支持 Web 端实时修改）
    const k = topK || parseInt(envVars.RAG_TOP_K) || this.topK || 5

    // 使用 Embedding 检索
    if (this.useEmbedding && this.embeddings.length > 0) {
      const queryEmbeddings = await this.generateEmbeddings([query])
      const queryVector = queryEmbeddings[0]

      if (queryVector && queryVector.length > 0) {
        const scores = this.embeddings.map((embedding, i) => ({
          index: i,
          score: this.cosineSimilarity(queryVector, embedding)
        }))

        scores.sort((a, b) => b.score - a.score)
        const topResults = scores.slice(0, k)
        const filtered = topResults.filter(r => r.score > 0.3)

        if (filtered.length > 0) {
          return filtered.map(r => ({
            content: this.documents[r.index],
            source: this.metadata[r.index]?.source || '',
            score: r.score
          }))
        }
      }
    }

    // 降级：TF-IDF 检索
    return this.tfidfSearch(query, k)
  }

  /**
   * TF-IDF 检索
   */
  tfidfSearch(query, topK) {
    const queryWords = this.tokenize(query)
    const queryFreq = this.computeWordFreq(queryWords)

    const scores = this.docWordFreq.map((docFreq, i) => {
      let score = 0
      for (const [word, qFreq] of queryFreq) {
        const dFreq = docFreq.get(word) || 0
        if (dFreq === 0) continue

        const tf = dFreq / docFreq.size
        const globalFreq = this.wordFreq.get(word) || 1
        const idf = Math.log(this.documents.length / globalFreq)

        score += tf * idf * qFreq
      }
      return { index: i, score }
    })

    scores.sort((a, b) => b.score - a.score)
    const topResults = scores.slice(0, topK)

    return topResults.map(r => ({
      content: this.documents[r.index],
      source: this.metadata[r.index]?.source || '',
      score: r.score
    }))
  }

  /**
   * 简单分词
   */
  tokenize(text) {
    const words = []
    const tokens = text.toLowerCase().split(/[\s\n\r\t,.;:!?，。；：！？、""''（）【】《》\-—…]+/)

    for (const token of tokens) {
      if (token.length < 2) continue

      // 中文按字符拆分（2-4字组合）
      if (/[一-龥]/.test(token)) {
        for (let i = 0; i < token.length; i++) {
          if (i + 2 <= token.length) words.push(token.slice(i, i + 2))
          if (i + 3 <= token.length) words.push(token.slice(i, i + 3))
          if (i + 4 <= token.length) words.push(token.slice(i, i + 4))
        }
      } else {
        words.push(token)
      }
    }

    return words
  }

  /**
   * 计算词频
   */
  computeWordFreq(words) {
    const freq = new Map()
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1)
    }
    return freq
  }

  /**
   * 保存向量到文件（二进制格式）
   * 元数据存 .json，向量数据存 .bin
   */
  async saveVectors() {
    try {
      const dir = path.dirname(this.vectorPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 1. 保存元数据到 JSON
      const metaPath = this.vectorPath.replace('.json', '_meta.json')
      const metaData = {
        model: this.modelName,
        timestamp: Date.now(),
        count: this.documents.length,
        documents: this.documents,
        metadata: this.metadata
      }
      fs.writeFileSync(metaPath, JSON.stringify(metaData))

      // 2. 保存向量到二进制文件
      const binPath = this.vectorPath.replace('.json', '.bin')
      const totalFloats = this.embeddings.reduce((sum, e) => sum + (e?.length || 0), 0)
      const buffer = Buffer.alloc(totalFloats * 4) // float32 = 4 bytes

      let offset = 0
      for (const embedding of this.embeddings) {
        if (embedding && embedding.length > 0) {
          for (const val of embedding) {
            buffer.writeFloatLE(val, offset)
            offset += 4
          }
        }
      }

      fs.writeFileSync(binPath, buffer)

      // 3. 保存向量索引（每个向量的起始位置和长度）
      const indexPath = this.vectorPath.replace('.json', '_index.json')
      let pos = 0
      const indexData = this.embeddings.map(e => {
        const len = e?.length || 0
        const info = { offset: pos, length: len }
        pos += len
        return info
      })
      fs.writeFileSync(indexPath, JSON.stringify(indexData))

      console.log(`✅ 向量已保存（二进制格式）: ${this.embeddings.length} 个文档`)
    } catch (e) {
      console.error(`❌ 保存向量失败: ${e.message}`)
    }
  }

  /**
   * 从文件加载向量（二进制格式）
   */
  async loadVectors() {
    try {
      const metaPath = this.vectorPath.replace('.json', '_meta.json')
      const binPath = this.vectorPath.replace('.json', '.bin')
      const indexPath = this.vectorPath.replace('.json', '_index.json')

      // 检查文件是否存在
      if (!fs.existsSync(metaPath) || !fs.existsSync(binPath) || !fs.existsSync(indexPath)) {
        return false
      }

      // 1. 加载元数据
      const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

      // 检查模型是否匹配
      if (metaData.model !== this.modelName) {
        console.log(`⚠️ 模型不匹配，将重新生成向量`)
        return false
      }

      // 检查文档数量是否匹配
      if (metaData.count !== this.documents.length) {
        console.log(`⚠️ 文档数量不匹配，将重新生成向量`)
        return false
      }

      // 2. 加载向量索引
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      // 3. 加载二进制向量数据
      const buffer = fs.readFileSync(binPath)

      this.embeddings = []
      for (const info of indexData) {
        if (info.length === 0) {
          this.embeddings.push([])
          continue
        }

        const embedding = []
        for (let i = 0; i < info.length; i++) {
          embedding.push(buffer.readFloatLE((info.offset + i) * 4))
        }
        this.embeddings.push(embedding)
      }

      console.log(`📂 加载向量文件（二进制格式）: ${this.embeddings.length} 个文档`)
      return true
    } catch (e) {
      console.error(`❌ 加载向量失败: ${e.message}`)
      return false
    }
  }

  /**
   * 更新单个文档
   */
  async updateDocument(filePath, chunks) {
    // 删除旧文档
    const indicesToRemove = []
    for (let i = 0; i < this.metadata.length; i++) {
      if (this.metadata[i]?.filePath === filePath) {
        indicesToRemove.push(i)
      }
    }

    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      const idx = indicesToRemove[i]
      this.documents.splice(idx, 1)
      this.embeddings.splice(idx, 1)
      this.metadata.splice(idx, 1)
      if (this.docWordFreq.length > 0) {
        this.docWordFreq.splice(idx, 1)
      }
    }

    // 添加新文档
    for (const chunk of chunks) {
      this.documents.push(chunk.content)
      this.metadata.push({
        source: chunk.source,
        ...chunk.metadata
      })

      if (this.useEmbedding && this.model) {
        const embedding = await this.generateEmbeddings([chunk.content])
        this.embeddings.push(embedding[0] || [])
      } else {
        this.embeddings.push([])
      }

      if (this.useTFIDF) {
        const words = this.tokenize(chunk.content)
        this.docWordFreq.push(this.computeWordFreq(words))
      }
    }

    // 保存更新后的向量
    if (this.useEmbedding) {
      await this.saveVectors()
    }

    console.log(`✅ 文档更新完成: ${filePath}`)
  }

  /**
   * 删除文档
   */
  async deleteDocument(filePath) {
    const indicesToRemove = []
    for (let i = 0; i < this.metadata.length; i++) {
      if (this.metadata[i]?.filePath === filePath) {
        indicesToRemove.push(i)
      }
    }

    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      const idx = indicesToRemove[i]
      this.documents.splice(idx, 1)
      this.embeddings.splice(idx, 1)
      this.metadata.splice(idx, 1)
      if (this.docWordFreq.length > 0) {
        this.docWordFreq.splice(idx, 1)
      }
    }

    // 保存更新后的向量
    if (this.useEmbedding) {
      await this.saveVectors()
    }

    console.log(`✅ 文档删除完成: ${filePath}`)
  }

  /**
   * 获取统计信息
   */
  async stats() {
    return {
      count: this.documents.length,
      mode: this.useTFIDF ? 'tfidf' : 'embedding',
      model: this.modelName
    }
  }
}