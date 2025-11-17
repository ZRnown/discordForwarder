# 使用说明（Discord → Discord Webhook 转发）

本项目已重构为仅支持将 Discord 消息转发到 Discord 服务器中的 Webhook 频道。

- 输入：Discord（支持 selfbot 或常规 bot，默认 selfbot）
- 输出：Discord Webhook（文本 + 链接信息）
- 代理：可选，通过 `PROXY_URL` 配置

> 注意：selfbot 违反 Discord 服务条款，使用需自行承担风险。

---

## 一、快速开始

1. 创建 Webhook
   - 在目标服务器的目标频道设置中创建一个 Webhook，复制其完整 URL。

2. 准备 `.env`
   - 在项目根目录创建 `.env` 文件（参考 `.env.sample`）并填写：
     ```env
     DISCORD_BOT_BACKEND=selfbot
     DISCORD_TOKEN=<你的 Discord 令牌>
     DISCORD_WEBHOOK_URL=<你的 Webhook URL>
     # 可选：PROXY_URL="http://username:password@proxy.example.com:8080"
     # 可选：NODE_ENV=production
     ```
   - 说明：
     - `DISCORD_BOT_BACKEND` 默认 `selfbot`。若使用常规机器人（在开发者门户创建应用、添加到服务器），可改为 `bot` 并使用 Bot Token。
     - `PROXY_URL` 不配置也可以运行。

3. 准备 `config.json`
   - 在项目根目录创建 `config.json`（可直接拷贝 `config.sample.json` 并按需修改）：
     ```json
     {
       "outputChannels": [],
       "allowedGuildsIds": [],
       "mutedGuildsIds": [],
       "allowedChannelsIds": [],
       "mutedChannelsIds": [],
       "allowedUsersIds": [],
       "mutedUsersIds": [],
       "channelConfigs": {},
       "disableLinkPreview": false,
       "imagesAsMedia": true,
       "showDate": true,
       "showChat": true,
       "stackMessages": true,
       "showMessageUpdates": true,
       "showMessageDeletions": true,
       "replacementsDictionary": {}
     }
     ```

4. 运行（Docker Compose）
   - 在项目根目录执行：
     ```bash
     docker compose build
     docker compose up -d
     ```
   - 首次启动将自动安装依赖、构建并运行。

---

## 二、配置项详解（config.json）

- 通用说明：所有 ID 建议使用字符串形式（例如 "1234567890"），否则启动时会在控制台给出警告。
- 字段：
  - `outputChannels`：对本方案（Webhook 输出）无作用，保持为空即可。
  - `allowedGuildsIds` / `mutedGuildsIds`：允许/屏蔽的服务器（Guild）ID 列表。
  - `allowedChannelsIds` / `mutedChannelsIds`：允许/屏蔽的频道（Channel）ID 列表。
  - `allowedUsersIds` / `mutedUsersIds`：允许/屏蔽的用户（User）ID 列表。
  - `channelConfigs`：按单个频道细化的 `allowed`/`muted` 用户 ID 配置，形如：
    ```json
    {
      "<channelId>": { "allowed": ["<userId>"], "muted": ["<userId>"] }
    }
    ```
  - `disableLinkPreview`：对 Telegram 有意义，对 Discord Webhook 无明显影响，建议保持 `false`。
  - `imagesAsMedia`：已取消 Telegram 媒体推送逻辑，但保留该开关以兼容配置；当前仅影响文本描述，不影响功能。
  - `showDate`：是否在文本前添加日期时间。
  - `showChat`：是否在文本前添加来源上下文（服务器/频道/作者）。
  - `stackMessages`：是否堆叠消息，默认每 5 秒批量发送一次。
  - `showMessageUpdates`：是否转发消息编辑更新。
  - `showMessageDeletions`：是否转发消息删除事件。
  - `replacementsDictionary`：发送前进行字符串替换的字典，如 `{":joy:": "😂"}`。

> 如果你不需要任何过滤规则，保持上述允许/屏蔽列表为空即可（即不做限制）。

---

## 三、运行行为说明

- 消息转发内容：
  - 展示：日期、来源上下文（Guild / Channel / Author）、消息文本。
  - 引用：若某消息是对另一条消息的回复，会额外包含“引用消息”的文本与一个可点击的跳转链接。
  - 跳转：每条消息均带有可点击的 Discord 永久链接，点击可跳转到源服务器的原始位置。
  - 附件与 Embed：当前以文本形式描述（名称、大小、URL；Embed 的基础字段）。

- 循环保护：
  - 程序会自动从 `DISCORD_WEBHOOK_URL` 中解析 webhook id，并加入静默名单，避免 Webhook 自己的消息被再次转发形成回环。

- 代理：
  - 设置了 `PROXY_URL` 时，Selfbot 的 WebSocket/HTTP 连接会通过代理发起；不设置也可以正常运行。

---

## 四、故障排查

- 无法登录 Discord：
  - 检查 `DISCORD_TOKEN` 是否正确、是否与 `DISCORD_BOT_BACKEND` 类型匹配。
  - 使用 selfbot 有封禁风险，若异常可尝试 `bot` 模式（需创建 Bot 应用并使用 Bot Token）。

- Webhook 未收到消息：
  - 检查 `DISCORD_WEBHOOK_URL` 是否为有效 URL，且目标频道 Webhook 仍然存在。
  - 检查是否有过滤导致消息被屏蔽（各类 `muted*` 列表）。

- 无法跳转：
  - 确认你对源服务器/频道有访问权限；若无权限，Discord 无法打开该链接。

- Docker 构建失败：
  - 重新执行 `docker compose build --no-cache`。
  - 确认网络访问 npm registry 正常，或配置企业私有镜像代理。

---

## 五、FAQ

- 需要配置 `outputChannels` 吗？
  - 不需要。Webhook 输出模式下，该字段不生效。

- 能否将图片也上传到目标频道？
  - 目前以文本描述形式展示。如需要，我可以扩展为通过 Webhook 文件上传图片（受大小与类型限制）。请告知你的具体需求。

- 能否关闭堆叠合并？
  - 可以，将 `stackMessages` 设为 `false` 即可实时发送。

- 能否只转发某些频道或用户？
  - 使用 `allowed*` 列表（或 `channelConfigs`）来限制；若所有 `allowed*` 都为空则不做限制。

---

## 六、维护与升级

- 依赖管理：使用 pnpm。Docker 构建中已包含安装和构建步骤。
- ESM 模块：本项目使用 `type: module`，注意 Node 版本需 `>=20`。

如需更多定制（例如图片上传、Webhook 展示名/头像自定义、消息格式模板化），请提出具体需求。
