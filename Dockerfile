FROM node:20-slim

WORKDIR /app

# 安装 build 工具和 Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip build-essential && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 安装依赖
COPY package*.json ./
RUN npm install --production

# 拷贝应用
COPY . .

# 创建 resources 目录
RUN mkdir -p /app/resources

# 暴露端口
EXPOSE 3000

# 启动时确保 resources 目录存在
CMD ["sh", "-c", "mkdir -p /app/resources && node src/app.js"]