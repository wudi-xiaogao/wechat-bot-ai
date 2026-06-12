# 微信智能客服机器人

基于 Wechaty + OpenAI API + 本地向量检索的微信智能客服机器人，支持 RAG 知识库、图片理解、AI 意图识别、对话历史记忆、Web 管理界面。

## ✨ 功能特性

- 🤖 **智能对话** - 接入 OpenAI/第三方 AI API，智能回复用户消息
- 🖼️ **图片理解** - 支持 Vision 多模态模型，群聊/私聊图片自动识别回复
- 📚 **RAG 知识库** - 基于 Embedding 向量检索的智能问答，知识库驱动回复
- 🧠 **AI 意图识别** - 关键词匹配 + AI 意图双重过滤，精准识别提问消息
- 💬 **对话历史记忆** - LRU + TTL 策略的会话历史管理，支持上下文连续对话
- 🎯 **白名单控制** - 群聊白名单（支持通配符）+ 联系人白名单，精准控制回复范围
- 📨 **消息队列** - 按群串行发送、跨群并发、频率限制，保证消息有序不丢失
- 🌐 **Web 管理界面** - 在线管理知识库文档、配置参数、查看微信登录状态
- 🔄 **热加载配置** - 运行参数支持 Web 端实时修改，无需重启即时生效
- 🛡️ **自动重连** - 断线自动重连、登录恢复、心跳检测、渐进式重试
- 📦 **Docker 部署** - 支持 Docker Compose 一键部署，国内镜像加速

## 📋 目录

- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [项目结构](#项目结构)
- [功能详解](#功能详解)
- [Docker 部署](#docker-部署)
- [第三方 API 接入](#第三方-api-接入)
- [常见问题](#常见问题)

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/your-repo/wechat-bot.git
cd wechat-bot
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制示例文件并配置：

```bash
cp .env.example .env   # 如无 .env.example，直接创建 .env
```

编辑 `.env` 文件：

```env
# OpenAI API 配置
OPENAI_API_KEY='your-api-key'
OPENAI_BASE_URL='https://api.openai.com/v1'

# 文本对话模型
MODEL='deepseek-v4-flash'

# 图片理解模型（需支持多模态）
VISION_MODEL='qwen3.6-plus'
VISION_MAX_TOKENS='1000'

# RAG 知识库配置
RAG_ENABLED='true'
RAG_DIR='./rag'
RAG_TOP_K='3'
RAG_MODEL='deepseek-v4-flash'
RAG_MAX_CONTEXT='4000'

# AI 意图识别
INTENT_MODEL='deepseek-v4-flash'
INTENT_TIMEOUT='5000'
```

### 4. 配置机器人参数

复制配置示例文件：

```bash
cp config.js.example config.js
```

编辑 `config.js` 文件：

```js
// 机器人名称（群聊中用于从消息中去除@部分）
export const botName = '@客服小助手'

// 群聊白名单（支持通配符：* 匹配任意字符，? 匹配单个字符）
export const roomWhiteList = ['测试群', '技术*支持', '客户?群']

// 联系人白名单（备注名或微信名）
export const aliasWhiteList = ['张三', '李四']

// 问题关键词（命中则直接回复，跳过AI意图识别）
export const questionKeywords = [
  '怎么', '如何', '为什么', '吗', '？', '?',
  '帮忙', '请问', '什么', '失败', '报错',
  // ... 更多关键词见 config.js.example
]

// AI意图识别模型（建议用快速廉价模型）
export const intentModel = 'deepseek-v4-flash'
```

### 5. 启动运行

```bash
npm run dev
```

启动后会显示二维码，用手机微信扫码登录。

---

## ⚙️ 配置说明

### 环境变量 (.env)

#### API 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `OPENAI_API_KEY` | OpenAI/第三方 API Key | 必填 |
| `OPENAI_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `MODEL` | 文本对话模型 | `glm-5` |
| `VISION_MODEL` | 图片理解模型（需支持多模态） | `qwen3.6-plus` |
| `VISION_MAX_TOKENS` | 图片理解最大输出 Token | `1000` |

#### RAG 知识库配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `RAG_ENABLED` | 是否启用 RAG 知识库 | `true` |
| `RAG_DIR` | 知识库目录 | `./rag` |
| `RAG_TOP_K` | 检索返回的文档数量 | `5` |
| `RAG_MODEL` | RAG 使用的模型 | `glm-5` |
| `RAG_MAX_CONTEXT` | 最大上下文长度（字符数） | `4000` |
| `EMBEDDING_MODEL` | 本地 Embedding 模型（HuggingFace 模型名） | `Xenova/multilingual-e5-small` |
| `VECTOR_PATH` | 向量数据持久化路径 | `./data/vectors.json` |
| `HF_MIRROR` | HuggingFace 镜像源（国内加速） | `https://hf-mirror.com` |

#### 意图识别配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `INTENT_MODEL` | 意图识别模型 | 使用 `MODEL` 配置 |
| `INTENT_TIMEOUT` | 意图识别超时（毫秒） | `5000` |

#### 运行配置（支持热加载）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `TASK_EXPIRE_THRESHOLD` | 队列任务过期时间（毫秒） | `120000` |
| `QUEUE_MAX_LENGTH` | 单群最大队列长度 | `10` |
| `SEND_COOLDOWN` | 两条消息间最小间隔（毫秒） | `0` |
| `RATE_LIMIT_WINDOW` | 频率限制窗口（毫秒） | `60000` |
| `RATE_LIMIT_MAX` | 窗口内最大回复数 | `20` |
| `MSG_MAX_AGE` | 消息最大容忍时间（秒） | `60` |

#### 对话历史配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CONVERSATION_ENABLED` | 是否启用对话历史 | `false` |
| `CONVERSATION_MAX_GROUPS` | 最大会话数 | `500` |
| `CONVERSATION_MAX_TURNS` | 每会话最大轮数 | `10` |
| `CONVERSATION_TTL` | 会话过期时间（分钟） | `30` |

### 机器人配置 (config.js)

```js
// 机器人名称（群聊中用于去除@部分，不再要求必须@才回复）
export const botName = '@客服小助手'

// 群聊白名单（支持通配符：* 匹配任意字符序列，? 匹配单个字符）
export const roomWhiteList = ['测试群', '迅力*群', '客户?群']

// 联系人白名单
export const aliasWhiteList = ['张三', '李四']

// 问题关键词（命中则直接回复，跳过AI意图识别，节省API调用）
// 留空则全部走AI意图识别
export const questionKeywords = ['怎么', '如何', '为什么', ...]

// AI意图识别模型
export const intentModel = 'deepseek-v4-flash'
```

---

## 📁 项目结构

```
wechat-bot-v2/
├── index.js                  # 入口文件
├── config.js                 # 机器人配置（白名单、关键词等）
├── config.js.example         # 配置示例文件
├── .env                      # 环境变量配置
├── package.json              # 项目依赖
├── Dockerfile                # Docker 构建文件
├── docker-compose.yml        # Docker Compose 编排
├── public/
│   └── index.html            # Web 管理界面（单页应用）
├── src/
│   ├── openai/
│   │   └── index.js          # OpenAI API 对话 + 图片理解 + 意图识别
│   ├── kimi/
│   │   └── index.js          # Kimi API 对话（可选）
│   ├── chatgpt/
│   │   └── index.js          # ChatGPT API 对话（可选）
│   ├── rag/
│   │   ├── index.js          # RAG 系统（检索 + 生成回答）
│   │   ├── loader.js         # 文档加载器（MD/Word/PDF/TXT）
│   │   ├── store.js          # 向量存储（Embedding + TF-IDF 降级）
│   │   └── admin.js          # Web 管理后台 API 服务
│   └── wechaty/
│       ├── index.js          # 微信机器人主逻辑（登录/重连/心跳）
│       ├── sendMessage.js    # 消息处理（文本/图片/意图过滤/队列发送）
│       ├── messageQueue.js   # 按群串行发送队列
│       ├── intentFilter.js   # 关键词 + AI 意图识别过滤器
│       ├── wildcardMatch.js  # 通配符白名单匹配
│       ├── conversationHistory.js  # 对话历史管理（LRU+TTL）
│       └── serve.js          # AI 服务路由（GPT/Kimi）
├── rag/                      # 知识库文档目录
│   └── 知识库/
│       └── 常见问题.md
└── data/                     # 运行时数据
    └── vectors.json          # 向量索引持久化
```

---

## 📚 功能详解

### 消息处理流程

```
收到消息 → 白名单匹配 → 消息类型判断 → 意图过滤 → AI生成 → 队列发送
              ↓                              ↓           ↓          ↓
         通配符匹配群名              关键词优先     RAG/对话API  按群串行
         联系人白名单               AI意图兜底    图片理解     频率限制
```

### 消息回复规则

#### 群聊回复

- 必须在白名单群内（支持通配符匹配）
- **无需 @ 机器人**，自动识别提问消息
- 意图过滤：关键词命中直接回复，否则走 AI 意图识别
- 示例：在白名单群中发送「怎么使用？」即可获得回复

#### 群聊图片理解

- 群聊中发送图片无法 @ 机器人，采用上下文关联机制
- **流程一**：用户先发文字提问 → 机器人回复 → 用户发图片 → 机器人用之前的提问理解图片
- **流程二**：用户先发图片 → 系统缓存 → 用户紧接着发文字提问 → 机器人关联图片理解
- 时间窗口：60 秒内关联有效
- 图片大小限制：10MB

#### 私聊回复

- 发送者必须在联系人白名单
- 直接发消息即可，无需 @
- **不走意图过滤**，所有消息直接回复
- 发送图片会自动理解并回复

### AI 意图识别

两层过滤策略，精准识别提问消息，避免对闲聊、打招呼等消息做无意义回复：

1. **关键词匹配**（同步、免费）- 命中则直接视为提问，跳过 AI 检查
2. **AI 意图识别**（异步、低成本）- 关键字未命中时调用轻量模型判断

Fail-open 策略：AI 识别失败或超时时默认视为提问，避免遗漏真实提问。

### 本地 Embedding 向量检索

#### 为什么使用本地 Embedding？

| 特性 | TF-IDF（降级方案） | Embedding 向量（主方案） |
|:---|:---|:---|
| **语义理解** | ❌ 仅关键词匹配 | ✅ 语义向量检索 |
| **中文效果** | ⭐⭐ 中等（字符 n-gram） | ⭐⭐⭐⭐ 好 |
| **外部依赖** | ✅ 无 | ✅ 无（本地推理） |
| **持久化** | ❌ 无 | ✅ 向量缓存到文件（二进制格式） |
| **检索准确** | ⭐⭐ | ⭐⭐⭐⭐ |

#### 本地 Embedding 模型

默认使用 `Xenova/multilingual-e5-small` 模型（基于 ONNX 量化，约 120MB）：
- 多语言支持（包括中文）
- 通过 `@xenova/transformers` 本地运行
- 自动 pooling + normalize，输出 384 维向量
- TF-IDF 作为自动降级方案（模型加载失败时切换）
- 向量数据持久化（二进制格式 + 元数据 JSON），避免重复计算

### RAG 知识库

#### 支持的文档格式

- Markdown (.md)
- Word (.docx, .doc)
- PDF (.pdf)
- 纯文本 (.txt)

#### 文档管理

1. **Web 界面管理** - 访问 `http://localhost:3000` 上传/编辑/下载文档
2. **文件夹管理** - 支持创建文件夹分类存储
3. **文件监听** - chokidar 自动监听文件变更，实时更新向量索引
4. **重建索引** - 可手动触发全量重建

#### 知识库目录结构

```
rag/
├── 产品FAQ/
│   ├── 常见问题.md
│   └── 使用教程.docx
├── 售后知识/
│   ├── 故障排查.md
│   └── 维修指南.pdf
└── README.md
```

### 消息队列系统

- **并发生成**：多个 AI 回复可以同时生成（API 调用立即发起）
- **串行发送**：同一个群/联系人的回复按入队顺序依次发送，保证对话顺序
- **跨群并发**：不同群的队列独立运行，互不阻塞
- **频率限制**：滑动窗口内限制最大回复数，防止刷屏
- **过期丢弃**：超过容忍时间的消息自动丢弃
- **队列长度限制**：单群队列过长时丢弃最旧任务

### 对话历史记忆

- **LRU 淘汰**：会话数超限时淘汰最久未访问的会话
- **TTL 过期**：超过设定时间未活跃的会话自动清理
- **轮数截断**：从最旧消息开始删除，保持 user+assistant 成对
- **会话隔离**：按群ID/联系人ID隔离，互不干扰
- **清除指令**：发送「清除对话」「重新开始」等关键词可手动清除历史

### 自动重连机制

- **心跳检测**：每 60 秒检查登录状态
- **渐进式重试**：重连间隔指数增长（60s → 120s → 240s），最多 3 次
- **登录恢复**：优先尝试使用 memory 数据恢复登录，失败后自动清除凭证走扫码流程
- **超时累积**：连续超时 3 次才触发重连，避免网络波动误判
- **登录稳定期**：登录后 3 秒稳定期，过滤过渡期系统消息
- **积压消息**：断线期间消息暂存，重连后批量处理（5 分钟内有效）

### Web 管理界面

访问 `http://localhost:3000`，提供以下管理功能：

| 标签页 | 功能 | 是否支持热加载 |
|--------|------|---------------|
| **微信登录** | 查看登录状态、扫码、触发重新登录 | - |
| **文档管理** | 上传、编辑、下载、删除文档；创建文件夹；重建索引 | - |
| **机器人配置** | 修改名称、白名单、关键词、意图识别模型 | 重启后生效 |
| **运行配置** | 队列参数、频率限制、意图识别超时等 | ✅ 实时生效 |
| **模型配置** | API Key、Base URL、对话模型、Vision 模型、RAG 模型 | 部分实时生效 |

#### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/documents` | 获取文档列表 |
| POST | `/api/upload` | 上传文档 |
| DELETE | `/api/delete` | 删除文档/文件夹 |
| GET | `/api/content` | 获取文档内容 |
| GET | `/api/download` | 下载文档 |
| POST | `/api/update` | 更新文档内容 |
| POST | `/api/folder` | 创建文件夹 |
| POST | `/api/rebuild` | 重建向量索引 |
| GET | `/api/config/bot` | 获取机器人配置 |
| POST | `/api/config/bot` | 更新机器人配置 |
| GET | `/api/config/model` | 获取模型配置 |
| POST | `/api/config/model` | 更新模型配置 |
| GET | `/api/config/runtime` | 获取运行配置 |
| POST | `/api/config/runtime` | 更新运行配置（实时生效） |
| GET | `/api/wechat/status` | 获取微信登录状态 |
| POST | `/api/wechat/relogin` | 触发重新登录 |
| GET | `/api/queue/stats` | 获取消息队列状态 |

---

## 📦 Docker 部署

### 使用 Docker Compose（推荐）

### 1. 配置 Docker 镜像加速（国内服务器）

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.m.daocloud.io"
  ]
}
EOF

sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl enable docker
```

### 2. 准备配置文件

```bash
# 创建 .env 和 config.js（参考上面的配置说明）
cp config.js.example config.js
# 编辑 .env 和 config.js 填入实际配置
```

### 3. 构建并启动

```bash
docker compose up -d --build
```

Docker Compose 支持阿里云镜像加速（已默认配置 `APT_SOURCE: aliyun`）。

### 4. 查看日志获取二维码

```bash
docker compose logs -f wechat-bot
```

扫码登录后，机器人开始运行。也可通过 Web 界面 `http://localhost:3000` 查看二维码。

### 5. 常用命令

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f

# 查看单个服务日志
docker compose logs -f wechat-bot

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 重新构建（无缓存）
docker compose build --no-cache
docker compose up -d
```

### 开机自启

Docker Compose 已配置 `restart: unless-stopped`，服务器重启后自动恢复。

确保 Docker 服务开机自启：

```bash
systemctl is-enabled docker
```

### 数据持久化

以下目录通过 Volume 挂载持久化：

| 宿主机路径 | 容器路径 | 说明 |
|-----------|---------|------|
| `./rag` | `/app/rag` | 知识库文档 |
| `./data` | `/app/data` | 微信登录数据 + 向量索引 |
| `./config.js` | `/app/config.js` | 机器人配置 |
| `./.env` | `/app/.env` | 环境变量 |

---

## 🔌 第三方 API 接入

本项目支持任意兼容 OpenAI API 格式的第三方服务。

### 国内常用 API 服务

| 服务商 | API 地址 | 说明 |
|--------|----------|------|
| 全迅云 | `https://api.ipsunion.com/v1` | 国内稳定，支持多模型 |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | GLM 系列模型 |
| 月之暗面 | `https://api.moonshot.cn/v1` | Kimi 模型 |
| 阿里云 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 通义千问 |
| DeepSeek | `https://api.deepseek.com/v1` | DeepSeek 模型 |

### 配置方法

修改 `.env` 文件：

```env
# 使用全迅云 API
OPENAI_API_KEY='sk-xxxxxxxx'
OPENAI_BASE_URL='https://api.ipsunion.com/v1'
MODEL='deepseek-v4-flash'
RAG_MODEL='deepseek-v4-flash'
```

### 推荐模型搭配

| 用途 | 推荐模型 | 说明 |
|------|---------|------|
| 文本对话 | `deepseek-v4-flash` | 快速、便宜 |
| RAG 知识库 | `deepseek-v4-flash` | 同上 |
| 图片理解 | `qwen3.6-plus` | 多模态支持好 |
| 意图识别 | `deepseek-v4-flash` | 低成本即可 |

---

## ❓ 常见问题

### 1. 消息不回复？

检查以下几点：

- 群名是否在 `roomWhiteList`（支持通配符匹配）
- 群聊消息是否被意图过滤判定为非提问（查看日志中的「意图过滤」信息）
- 私聊发送者是否在 `aliasWhiteList`
- 查看日志是否有 API 错误

### 2. 群聊不回复但私聊可以？

群聊走意图过滤，可能消息被判定为非提问：
- 检查关键词列表是否包含相关词
- 检查意图识别模型是否正常
- 临时将 `questionKeywords` 设为空数组 `[]`，所有消息都走 AI 意图识别

### 3. Docker 构建失败？

国内服务器需要配置 Docker 镜像加速：

```bash
sudo tee /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["https://docker.1ms.run"]
}
EOF
sudo systemctl restart docker
```

Dockerfile 已内置阿里云 APT 源和 NPM 镜像，通过 `APT_SOURCE: aliyun` 参数启用。

### 4. 企业微信消息不支持？

当前基于 Web 微信协议，不支持企业微信消息格式。

解决方案：
- 用个人微信发送消息
- 或单独接入企业微信 Webhook API

### 5. PDF 解析失败？

需要安装 pdf-parse（已在 `package.json` 中包含）。Docker 部署时重新构建即可：

```bash
docker compose build --no-cache
```

### 6. API 调用超时？

检查：
- API 地址是否正确
- API Key 是否有效
- 网络是否通畅
- 模型名称是否正确
- 意图识别超时可调整 `INTENT_TIMEOUT`（默认 5000ms）

### 7. Embedding 模型加载失败？

- 检查网络连接（首次运行需从 HuggingFace 下载约 120MB 模型）
- 国内环境可设置 `HF_MIRROR='https://hf-mirror.com'`（Docker 部署已默认配置）
- 系统会自动降级到 TF-IDF 检索模式
- 也可手动设置 `EMBEDDING_MODEL` 为其他 `Xenova` 支持的模型

### 8. 如何清除对话历史？

在聊天中发送以下任一指令：
- 「清除对话」
- 「清空对话」
- 「重新开始」
- 「重置对话」

需开启对话历史功能：设置 `CONVERSATION_ENABLED='true'`

### 9. 微信掉线如何恢复？

- 自动重连机制会在检测到掉线后尝试恢复（最多3次）
- 可通过 Web 管理界面点击「重新登录」按钮
- 重连失败后需重新扫码登录

---

## 🛠️ 开发 & 测试

```bash
# 启动机器人
npm run dev

# 测试消息处理
npm test

# 测试 OpenAI API
npm run test-openai

# 测试 Kimi API
npm run test-kimi

# 测试 RAG 检索
npm run test-rag
```

---

## 📄 License

ISC

---

## 🙏 致谢

- [Wechaty](https://github.com/wechaty/wechaty) - 微信机器人框架
- [OpenAI](https://openai.com/) - AI API
- [Xenova Transformers](https://github.com/xenova/transformers.js) - 本地 Embedding 推理
- [Mammoth](https://github.com/mwilliamson/mammoth.js) - Word 文档解析
