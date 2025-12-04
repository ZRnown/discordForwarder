FROM node:20-alpine

WORKDIR /app

# 复制 package.json 和 pnpm-lock.yaml（如果存在）
COPY package.json pnpm-lock.yaml* ./

# 安装 pnpm（如果使用 pnpm）
RUN npm install -g pnpm

# 安装依赖
RUN pnpm install --prod --frozen-lockfile || npm install --production

# 复制编译后的代码
COPY dist/ ./dist/

# 复制配置文件（可选，也可以在运行时挂载）
COPY config.json ./

# 设置环境变量（可选，也可以在运行时通过 -e 传递）
# ENV DISCORD_TOKEN=your-token-here

# 运行应用
CMD ["node", "dist/index.js"]

