import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import dotenv from 'dotenv'

// dotenv 配置：不覆盖已存在的环境变量（Docker 传入的）
dotenv.config({ override: false })

const env = process.env

// 动态导入 pdf-parse (CommonJS 模块)
async function loadPdf(filePath) {
  try {
    const module = await import('pdf-parse')
    // 处理不同的模块导出方式
    const pdfParse = module.default || module.pdfParse || module
    if (typeof pdfParse !== 'function') {
      throw new Error('无法加载 pdf-parse 模块')
    }
    const dataBuffer = fs.readFileSync(filePath)
    const data = await pdfParse(dataBuffer)
    return data.text
  } catch (e) {
    console.error('PDF 解析错误:', e.message)
    throw new Error(`PDF 解析失败: ${e.message}`)
  }
}

/**
 * 简单文本分割器
 */
class SimpleTextSplitter {
  constructor({ chunkSize = 1000, chunkOverlap = 200 }) {
    this.chunkSize = chunkSize
    this.chunkOverlap = chunkOverlap
  }

  splitText(text) {
    const chunks = []
    let start = 0

    while (start < text.length) {
      let end = start + this.chunkSize

      // 尝试在段落或句子边界分割
      if (end < text.length) {
        // 寻找最近的段落结束
        const paragraphEnd = text.lastIndexOf('\n\n', end)
        const lineEnd = text.lastIndexOf('\n', end)
        const sentenceEnd = Math.max(
          text.lastIndexOf('.', end),
          text.lastIndexOf('。', end),
          text.lastIndexOf('!', end),
          text.lastIndexOf('！', end),
          text.lastIndexOf('?', end),
          text.lastIndexOf('？', end)
        )

        if (paragraphEnd > start) {
          end = paragraphEnd + 2
        } else if (lineEnd > start) {
          end = lineEnd + 1
        } else if (sentenceEnd > start) {
          end = sentenceEnd + 1
        }
      }

      chunks.push(text.slice(start, end).trim())
      start = end - this.chunkOverlap
    }

    return chunks.filter(chunk => chunk.length > 0)
  }
}

/**
 * 文档加载器
 * 加载 rag 目录下的 Markdown、Word 和 PDF 文档
 */
export class DocumentLoader {
  constructor(ragDir = env.RAG_DIR || './rag') {
    this.ragDir = ragDir
    this.splitter = new SimpleTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    })
  }

  /**
   * 加载所有文档
   * @returns {Promise<Array<{content: string, source: string, metadata: object}>}
   */
  async loadAll() {
    const documents = []
    const files = this.listDocuments()

    for (const file of files) {
      try {
        const docs = await this.loadFile(file)
        documents.push(...docs)
      } catch (e) {
        console.error(`加载文档失败: ${file}`, e.message)
      }
    }

    console.log(`✅ 加载文档完成，共 ${documents.length} 个片段`)
    return documents
  }

  /**
   * 递归列出所有文档文件
   * @returns {string[]}
   */
  listDocuments(dir = this.ragDir) {
    if (!fs.existsSync(dir)) {
      console.warn(`⚠️ RAG 目录不存在: ${dir}`)
      return []
    }

    const files = []
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // 递归扫描子目录
        const subFiles = this.listDocuments(fullPath)
        files.push(...subFiles)
      } else if (entry.isFile()) {
        // 跳过临时文件（以 ~$ 开头）
        if (entry.name.startsWith('~$')) continue

        const ext = path.extname(entry.name).toLowerCase()
        if (ext === '.md' || ext === '.txt' || ext === '.docx' || ext === '.doc' || ext === '.pdf') {
          files.push(fullPath)
        }
      }
    }

    if (dir === this.ragDir) {
      console.log(`📄 发现 ${files.length} 个文档文件`)
    }
    return files
  }

  /**
   * 加载单个文件
   * @param {string} filePath
   * @returns {Promise<Array<{content: string, source: string, metadata: object}>}
   */
  async loadFile(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    let content = ''
    // 使用相对路径作为 source，显示文件夹结构
    const source = path.relative(this.ragDir, filePath)

    if (ext === '.md' || ext === '.txt') {
      content = fs.readFileSync(filePath, 'utf-8')
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath })
      content = result.value
    } else if (ext === '.pdf') {
      content = await loadPdf(filePath)
    } else {
      throw new Error(`不支持的文件格式: ${ext}`)
    }

    // 分割文档
    const chunks = await this.splitter.splitText(content)

    return chunks.map((chunk, index) => ({
      content: chunk,
      source,
      metadata: {
        source,
        chunkIndex: index,
        filePath,
      },
    }))
  }

  /**
   * 监听目录变化，返回变更的文件列表
   * @returns {Promise<Array<{type: string, path: string}>>}
   */
  getChangedFiles(eventType, filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.md' || ext === '.txt' || ext === '.docx' || ext === '.doc' || ext === '.pdf') {
      return {
        type: eventType,
        path: filePath,
      }
    }
    return null
  }
}