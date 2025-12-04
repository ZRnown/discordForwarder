# 服务器部署指南

## 🐳 方式一：使用 Docker（最推荐）

这是最简单、最可靠的部署方式，不需要在服务器上安装 Node.js，所有依赖都包含在容器中。

### 1. 构建 Docker 镜像

在开发机器上：

```bash
# 先编译 TypeScript
pnpm build

# 构建 Docker 镜像
pnpm docker:build
# 或
docker build -t discord-forwarder .
```

### 2. 上传到服务器

上传以下文件到服务器：

- `Dockerfile`
- `docker-compose.yml`
- `dist/` 文件夹
- `package.json`
- `pnpm-lock.yaml`（如果使用 pnpm）
- `config.json`
- `.env` 文件

### 3. 在服务器上运行

```bash
# 使用 docker-compose（推荐）
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

### 4. 或者直接使用 docker 命令

```bash
# 构建镜像
docker build -t discord-forwarder .

# 运行容器
docker run -d \
  --name discord-forwarder \
  --restart unless-stopped \
  -v $(pwd)/config.json:/app/config.json:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  discord-forwarder

# 查看日志
docker logs -f discord-forwarder
```

### Docker 部署的优势

✅ **无需 Node.js**：容器包含所有依赖  
✅ **环境隔离**：不会影响服务器其他应用  
✅ **易于管理**：使用 docker-compose 一键启动/停止  
✅ **自动重启**：容器崩溃后自动重启  
✅ **跨平台**：在任何支持 Docker 的系统上运行

---

## 📦 方式二：使用二进制文件（推荐）

这是最简单的方式，只需要一个可执行文件 + 配置文件即可运行，**不需要安装 Node.js**。

### 解决方案

通过使用 `--no-native-build` 选项，我们成功绕过了 `pkg` 对 `node:sqlite` 的处理问题。

这是最简单的方式，只需要一个可执行文件 + 配置文件即可运行，**不需要安装 Node.js**。

### 1. 本地打包二进制文件

在开发机器上运行：

```bash
# 先编译 TypeScript
pnpm build

# 打包为二进制文件（根据你的服务器系统选择）
# Linux 服务器
pnpm pkg:linux

# macOS 服务器
pnpm pkg:macos

# Windows 服务器
pnpm pkg:win

# 或者打包所有平台
pnpm pkg:all
```

**关键配置**：我们使用了 `--no-native-build` 选项来绕过 `pkg` 对 Node.js 20+ 新 API（如 `node:sqlite`）的处理问题。虽然会有一个 Babel 解析警告，但这不影响最终的可执行文件功能。

打包完成后，二进制文件会在 `bin/` 文件夹中：

- Linux: `bin/forwarding-discord-telegram-linux`
- macOS: `bin/forwarding-discord-telegram-macos`
- Windows: `bin/forwarding-discord-telegram-win.exe`

### 2. 上传到服务器

只需要上传以下文件：

```
服务器目录/
├── forwarding-discord-telegram-linux  # 二进制文件（根据服务器系统选择）
├── config.json                        # 配置文件
└── .env                               # 环境变量文件（可选）
```

### 3. 设置权限并运行

```bash
# 给二进制文件添加执行权限（Linux/macOS）
chmod +x forwarding-discord-telegram-linux

# 运行
./forwarding-discord-telegram-linux
```

### 4. 使用进程管理器（推荐）

```bash
# 使用 PM2（需要先安装 Node.js 和 PM2）
pm2 start ./forwarding-discord-telegram-linux --name discord-forwarder
pm2 save
pm2 startup

# 或者使用 systemd（Linux）
# 创建服务文件 /etc/systemd/system/discord-forwarder.service
```

**systemd 服务文件示例**：

```ini
[Unit]
Description=Discord Forwarder Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/bot
ExecStart=/path/to/bot/forwarding-discord-telegram-linux
Restart=always
RestartSec=10
Environment="DISCORD_TOKEN=your-token"

[Install]
WantedBy=multi-user.target
```

然后启用服务：

```bash
sudo systemctl enable discord-forwarder
sudo systemctl start discord-forwarder
sudo systemctl status discord-forwarder
```

### 二进制文件部署的优势

✅ **无需 Node.js**：二进制文件包含所有依赖，不需要在服务器上安装 Node.js  
✅ **简单部署**：只需要 3 个文件（二进制 + config.json + .env）  
✅ **快速启动**：直接运行，无需安装依赖  
✅ **跨平台**：可以为不同系统打包不同的二进制文件

---

## 💻 方式三：传统部署（需要 Node.js）

如果服务器上已经安装了 Node.js，这是最简单的部署方式。

## 需要上传的文件

在服务器上运行此项目，你需要上传以下文件：

### 必需文件

1. **`dist/` 文件夹** - 编译后的 JavaScript 代码
2. **`config.json`** - 配置文件（包含频道 webhook 和 persona 配置）
3. **`package.json`** - 用于安装依赖和启动脚本
4. **`.env` 文件**（可选，如果使用环境变量）或设置系统环境变量

### 可选文件

- `logs/` 文件夹（如果不存在会自动创建）

## 部署步骤

### 1. 上传文件到服务器

将以下文件/文件夹上传到服务器：

```
discordForwarder/
├── dist/              # 必需：编译后的代码
├── config.json        # 必需：配置文件
├── package.json       # 必需：依赖和脚本配置
└── .env              # 可选：环境变量（或使用系统环境变量）
```

### 2. 在服务器上安装依赖

```bash
# 如果使用 pnpm（推荐）
pnpm install --prod

# 或者使用 npm
npm install --production

# 或者使用 yarn
yarn install --production
```

**注意**：只需要安装生产依赖（`--production` 或 `--prod`），不需要开发依赖。

### 3. 设置环境变量

创建 `.env` 文件或设置系统环境变量：

```bash
# .env 文件内容
DISCORD_TOKEN=你的Discord令牌
TRANSLATION_ENABLED=true  # 可选，默认为 true
DEEPSEEK_API_KEY=你的DeepSeek API密钥  # 可选
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions  # 可选
```

或者使用系统环境变量：

```bash
export DISCORD_TOKEN=你的Discord令牌
export TRANSLATION_ENABLED=true
```

### 4. 运行项目

```bash
# 使用 npm
npm start

# 或直接使用 node
node dist/index.js
```

### 5. 使用进程管理器（推荐）

使用 PM2 或其他进程管理器来保持 bot 运行：

```bash
# 安装 PM2
npm install -g pm2

# 启动 bot
pm2 start dist/index.js --name discord-forwarder

# 查看状态
pm2 status

# 查看日志
pm2 logs discord-forwarder

# 设置开机自启
pm2 startup
pm2 save
```

## 最小部署文件清单

如果你只想上传最少的文件，需要：

1. ✅ `dist/` 文件夹（所有编译后的 .js 文件）
2. ✅ `config.json`
3. ✅ `package.json`
4. ✅ `.env` 文件（或设置系统环境变量）

然后在服务器上运行：

```bash
npm install --production
npm start
```

## 注意事项

### 二进制文件部署

1. **系统兼容性**：确保打包的二进制文件与服务器系统匹配（Linux/macOS/Windows）
2. **执行权限**：Linux/macOS 需要给二进制文件添加执行权限：`chmod +x`
3. **配置文件位置**：确保 `config.json` 和 `.env` 文件与二进制文件在同一目录
4. **日志文件**：`logs/` 文件夹会自动创建，确保有写入权限

### 传统部署

1. **Node.js 版本**：确保服务器上安装的 Node.js 版本 >= 20.0.0

   ```bash
   node --version  # 应该显示 v20.x.x 或更高
   ```

2. **日志文件**：`logs/` 文件夹会自动创建，确保有写入权限

3. **配置文件**：确保 `config.json` 格式正确，特别是 webhook URL 和 channel ID

4. **Discord Token**：确保 `DISCORD_TOKEN` 环境变量已正确设置

5. **防火墙**：确保服务器可以访问 Discord API 和 Telegram（如果使用）

## 快速检查清单

- [ ] `dist/` 文件夹已上传
- [ ] `config.json` 已上传并配置正确
- [ ] `package.json` 已上传
- [ ] 已在服务器上运行 `npm install --production`
- [ ] 已设置 `DISCORD_TOKEN` 环境变量
- [ ] Node.js 版本 >= 20.0.0
- [ ] 已测试运行 `npm start`

## 故障排除

如果遇到问题：

1. **检查日志**：查看 `logs/` 文件夹中的日志文件
2. **检查环境变量**：确保 `DISCORD_TOKEN` 已正确设置
3. **检查依赖**：确保所有依赖已正确安装
4. **检查 Node.js 版本**：确保版本 >= 20.0.0
5. **检查配置文件**：确保 `config.json` 格式正确
