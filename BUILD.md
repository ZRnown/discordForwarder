# 二进制文件打包指南

## 快速开始

### 1. 安装依赖并编译

```bash
# 安装所有依赖（包括开发依赖）
pnpm install

# 编译 TypeScript 代码
pnpm build
```

### 2. 打包二进制文件

根据目标服务器系统选择：

```bash
# Linux 服务器（最常见）
pnpm pkg:linux

# macOS 服务器
pnpm pkg:macos

# Windows 服务器
pnpm pkg:win

# 打包所有平台
pnpm pkg:all
```

打包完成后，二进制文件会在 `bin/` 目录中：

- `bin/forwarding-discord-telegram-linux` (Linux)
- `bin/forwarding-discord-telegram-macos` (macOS)
- `bin/forwarding-discord-telegram-win.exe` (Windows)

### 3. 部署到服务器

只需要上传以下文件到服务器：

```
服务器目录/
├── forwarding-discord-telegram-linux  # 二进制文件
├── config.json                         # 配置文件
└── .env                                # 环境变量（可选）
```

### 4. 在服务器上运行

```bash
# 添加执行权限（Linux/macOS）
chmod +x forwarding-discord-telegram-linux

# 运行
./forwarding-discord-telegram-linux
```

## 配置文件说明

### config.json

这是主要的配置文件，包含：
- `channelWebhooks`: 频道到 webhook 的映射
- `activeBlocks`: active blocks 配置
- `activePersonas`: persona 配置
- 其他配置项

### .env

环境变量文件（可选，也可以使用系统环境变量）：

```env
DISCORD_TOKEN=你的Discord令牌
TRANSLATION_ENABLED=true
DEEPSEEK_API_KEY=你的DeepSeek API密钥（可选）
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions（可选）
```

如果不使用 `.env` 文件，可以设置系统环境变量：

```bash
export DISCORD_TOKEN=你的Discord令牌
```

## 使用进程管理器

### 使用 PM2（需要 Node.js）

```bash
pm2 start ./forwarding-discord-telegram-linux --name discord-forwarder
pm2 save
pm2 startup
```

### 使用 systemd（Linux，推荐）

创建服务文件 `/etc/systemd/system/discord-forwarder.service`：

```ini
[Unit]
Description=Discord Forwarder Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/bot
ExecStart=/path/to/bot/forwarding-discord-telegram-linux
Restart=always
RestartSec=10
Environment="DISCORD_TOKEN=your-token-here"

[Install]
WantedBy=multi-user.target
```

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable discord-forwarder
sudo systemctl start discord-forwarder
sudo systemctl status discord-forwarder
```

查看日志：

```bash
sudo journalctl -u discord-forwarder -f
```

## 故障排除

### 问题：二进制文件无法执行

**解决方案**：
```bash
chmod +x forwarding-discord-telegram-linux
```

### 问题：找不到 config.json

**解决方案**：确保 `config.json` 文件与二进制文件在同一目录

### 问题：找不到 .env 文件

**解决方案**：
- 确保 `.env` 文件与二进制文件在同一目录
- 或者使用系统环境变量：`export DISCORD_TOKEN=your-token`

### 问题：权限错误

**解决方案**：
- 确保二进制文件有执行权限
- 确保 `logs/` 目录有写入权限（会自动创建）

### 问题：二进制文件在服务器上无法运行

**可能原因**：
1. 系统架构不匹配（例如：在 ARM 服务器上运行 x64 二进制文件）
2. 缺少系统依赖库

**解决方案**：
- 确保打包时选择正确的目标平台
- 如果服务器是 ARM 架构，需要打包 ARM 版本：
  ```bash
  pkg . --targets node20-linux-arm64
  ```

## 支持的平台

- Linux x64
- Linux ARM64
- macOS x64
- macOS ARM64 (Apple Silicon)
- Windows x64

如果需要其他平台，可以查看 `pkg` 支持的所有目标：
```bash
pkg --help
```

## 文件大小

打包后的二进制文件大小约为 50-100 MB（包含所有依赖和 Node.js 运行时）。

## 注意事项

1. **配置文件位置**：`config.json` 和 `.env` 必须与二进制文件在同一目录
2. **日志文件**：`logs/` 目录会自动创建，确保有写入权限
3. **系统兼容性**：确保打包的二进制文件与服务器系统匹配
4. **首次运行**：首次运行可能需要几秒钟来初始化

