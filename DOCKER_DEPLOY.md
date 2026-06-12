# Docker 部署指南

## 一、准备工作

### 1. 配置文件准备

**创建 config.js（首次运行）**
```bash
cp config.js.example config.js
```

编辑 `config.js`，修改机器人名称和白名单：
```javascript
export const botName = '@小鱼儿'
export const roomWhiteList = ['测试群', '高先生的小店', '测试01']
export const aliasWhiteList = ['全迅云客服', '今天休息一天']
```

**准备 .env 文件**
确保 `.env` 文件包含必要的 API Key：
```env
OPENAI_API_KEY='your-api-key'
OPENAI_BASE_URL='https://api.ipsunion.com/v1'
RAG_ENABLED='true'
RAG_TOP_K='3'
RAG_MODEL='glm-5'
```

### 2. 知识库文件准备

将文档放入 `rag` 目录：
```
rag/
├── 售后知识库/
│   ├── xxx常见问题.docx
│   └── xxx-FAQ/
│       └── 常见问题 FAQ.md
└── 其他文档.md
```

### 3. 检查依赖

确保本地有 Docker 和 Docker Compose：
```bash
docker --version
docker-compose --version
```

---

## 二、构建镜像

### 方式 1：使用 Docker Compose（推荐）

```bash
# 构建并启动
docker-compose up -d --build

# 查看日志（扫码登录）
docker-compose logs -f wechat-bot

# 停止
docker-compose down
```

### 方式 2：手动构建

```bash
# 构建镜像（使用阿里云镜像加速）
docker build --build-arg APT_SOURCE=aliyun -t wechat-bot:latest .

# 运行容器
docker run -d \
  --name wechat-bot \
  -p 3000:3000 \
  -v ./rag:/app/rag \
  -v ./data:/app/data \
  -v ./config.js:/app/config.js \
  -e OPENAI_API_KEY='your-key' \
  -e OPENAI_BASE_URL='https://api.ipsunion.com/v1' \
  -e RAG_ENABLED=true \
  -e TZ=Asia/Shanghai \
  -it \
  wechat-bot:latest

# 查看日志
docker logs -f wechat-bot
```

---

## 三、登录微信

启动后查看日志，终端会显示二维码：
```bash
docker-compose logs -f wechat-bot
```

或直接进入容器交互：
```bash
docker-compose exec wechat-bot npm run dev
```

用微信扫描二维码登录。登录成功后，登录数据会保存在 `./data` 目录。

---

## 四、使用 RAG 管理界面

访问 http://localhost:3000 使用管理界面：
- 上传/删除/下载文档
- 配置机器人白名单
- 配置模型参数

---

## 五、常用命令

```bash
# 重启服务
docker-compose restart

# 重新构建（更新代码后）
docker-compose up -d --build

# 进入容器调试
docker-compose exec wechat-bot bash

# 查看实时日志
docker-compose logs -f wechat-bot

# 清理并重新部署
docker-compose down && docker-compose up -d --build
```

---

## 六、注意事项

1. **微信登录持久化**：登录数据保存在 `./data` 目录，重启容器后自动恢复登录状态

2. **敏感信息**：API Key 等敏感信息通过环境变量传入，不要硬编码到镜像中

3. **文件同步**：`rag` 和 `config.js` 通过卷挂载，修改本地文件立即生效

4. **端口冲突**：如果 3000 端口被占用，修改 docker-compose.yml 的端口映射：
   ```yaml
   ports:
     - "3001:3000"
   ```

5. **生产部署**：建议使用 `.env.production` 文件，避免提交敏感配置

---

## 七、故障排查

**问题：npm install 失败**
- 使用阿里云镜像：`APT_SOURCE=aliyun`

**问题：微信登录失效**
- 删除 `./data` 目录重新登录

**问题：RAG 累加不生效**
- 检查 `RAG_ENABLED=true`
- 访问管理界面点击"重建索引"