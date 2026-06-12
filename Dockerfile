ARG APT_SOURCE="default"

FROM node:20 as builder-default
ENV NPM_REGISTRY="https://registry.npmjs.org"

FROM node:20 as builder-aliyun

ENV NPM_REGISTRY="https://registry.npmmirror.com"
# Debian 12 使用新格式 sources.list.d
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo 'Asia/Shanghai' >/etc/timezone

FROM builder-${APT_SOURCE} AS builder
# Instal the 'apt-utils' package to solve the error 'debconf: delaying package configuration, since apt-utils is not installed'
# https://peteris.rocks/blog/quiet-and-unattended-installation-with-apt-get/
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apt-utils \
    autoconf \
    automake \
    bash \
    build-essential \
    ca-certificates \
    chromium \
    coreutils \
    curl \
    ffmpeg \
    figlet \
    git \
    gnupg2 \
    jq \
    libtool \
    libvips-dev \
    libxtst6 \
    moreutils \
    python3-dev \
    shellcheck \
    sudo \
    tzdata \
    vim \
    wget \
  && apt-get clean \
  && apt-get autoremove -y \
  && rm -rf /tmp/* /var/lib/apt/lists/*

FROM builder

ENV CHROME_BIN="/usr/bin/chromium" \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true"

RUN mkdir -p /app
WORKDIR /app

COPY package.json ./

# sharp 是 @xenova/transformers 的硬依赖（image.js 中 static import），不能跳过或删除
# 安装 libvips-dev 后 sharp 可本地编译，不再依赖网络下载预编译二进制
# 通过环境变量设置 sharp 二进制镜像 + 强制本地编译，避免从 GitHub 下载超时
RUN npm config set registry ${NPM_REGISTRY} && \
    SHARP_FORCE_BUILD=true \
    npm_config_sharp_binary_host=https://npmmirror.com/mirrors/sharp \
    npm_config_sharp_libvips_binary_host=https://npmmirror.com/mirrors/sharp-libvips \
    npm i --legacy-peer-deps

# 复制应用代码
COPY *.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY config.js.example ./config.js.example

# 创建必要目录
RUN mkdir -p /app/rag /app/data

# 暴露端口（RAG 管理界面）
EXPOSE 3000

# 使用环境变量配置，敏感信息通过 docker run -e 或 docker-compose 传入
CMD ["npm", "run", "dev"]
