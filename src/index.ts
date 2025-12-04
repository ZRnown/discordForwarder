// Polyfill for File API in pkg environment
if (typeof globalThis.File === 'undefined') {
  try {
    // Try to use Node.js built-in File (Node 18+)
    const buffer = require('node:buffer');
    if (buffer.File) {
      globalThis.File = buffer.File;
    } else {
      throw new Error('File not available');
    }
  } catch {
    // Fallback: create a minimal File polyfill
    globalThis.File = class File extends (globalThis.Blob || class Blob {}) {
      name: string;
      lastModified: number;
      constructor(chunks: any[], name: string, options?: any) {
        super(chunks, options);
        this.name = name;
        this.lastModified = options?.lastModified || Date.now();
      }
    } as any;
  }
}

// 立即输出，确保能看到启动信息
console.log("=".repeat(50));
console.log("[Bootstrap] 程序开始启动...");
console.log("[Bootstrap] Node.js 版本:", process.version);
console.log("[Bootstrap] 工作目录:", process.cwd());
console.log("=".repeat(50));

// 捕获所有未处理的错误
process.on("uncaughtException", (error) => {
  console.error("[Fatal] 未捕获的异常:", error);
  if (error.stack) console.error("[Fatal] 堆栈:", error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] 未处理的 Promise 拒绝:", reason);
  if (reason instanceof Error && reason.stack) {
    console.error("[Fatal] 堆栈:", reason.stack);
  }
  process.exit(1);
});

import { Client as SelfBotClient } from "discord.js-selfbot-v13";

import { Bot, Client } from "./bot.js";
import { getConfig } from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { TokenChecker } from "./tokenChecker.js";

async function sendStartupNotification(defaultSender: SenderBot | undefined) {
  if (!defaultSender) return;
  const content = `[BOT] ✅ 转发器已启动（${new Date().toLocaleString("zh-CN")}）`;
  try {
    await defaultSender.sendData([
      {
        content
      }
    ]);
    console.log("[Startup] 已向默认目标发送启动通知");
  } catch (error) {
    console.error("[Startup] 启动通知发送失败：", error);
  }
}

async function bootstrap() {
  try {
    console.log("[Startup] 正在启动转发器...");
    console.log("[Startup] 工作目录:", process.cwd());
    
    console.log("[Startup] 正在加载环境变量...");
    const env = getEnv();
  if (!env.DISCORD_TOKEN) {
    console.error("[Startup] ❌ 错误: 未找到 DISCORD_TOKEN 环境变量");
    console.error("[Startup] 请确保 .env 文件存在且包含 DISCORD_TOKEN");
    process.exit(1);
  }
  console.log("[Startup] ✓ DISCORD_TOKEN 已加载");
  
  console.log("[Startup] 正在加载配置文件...");
  const config = await getConfig();
  console.log("[Startup] ✓ 配置文件已加载");

  // Build mapping from source channel IDs to webhook URLs
  const senderBotsBySource = new Map<string, SenderBot>();
  const senderBotsByWebhook = new Map<string, SenderBot>();
  let defaultSenderBot: SenderBot | undefined;
  const prepares: Promise<any>[] = [];

  const ensureSenderBot = (webhookUrl: string) => {
    let existing = senderBotsByWebhook.get(webhookUrl);
    if (existing) return existing;
    const sb = new SenderBot({
      chatsToSend: [],
      replacementsDictionary: config.replacementsDictionary,
      webhookUrl
    });
    senderBotsByWebhook.set(webhookUrl, sb);
    prepares.push(sb.prepare());
    return sb;
  };

  // 1) Base mapping from channelWebhooks
  if (config.channelWebhooks && Object.keys(config.channelWebhooks).length > 0) {
    for (const [channelId, webhookUrl] of Object.entries(config.channelWebhooks)) {
      const sb = ensureSenderBot(webhookUrl);
      senderBotsBySource.set(channelId, sb);
      if (!defaultSenderBot) defaultSenderBot = sb;
    }
  }

  // 2) Pre-warm SenderBot instances defined via active blocks
  const activeBlocks = Object.values(config.activeBlocks ?? {});
  for (const block of activeBlocks) {
    if (!block?.targetWebhook) continue;
    ensureSenderBot(block.targetWebhook);
  }

  if (!defaultSenderBot) {
    console.error("[Startup] ❌ 错误: 未配置任何 webhook");
    console.error("[Startup] 请在 config.json 的 channelWebhooks 中至少配置一个 webhook URL");
    process.exit(1);
  }
  console.log("[Startup] ✓ Webhook 配置已加载");

  await Promise.all(prepares);

  // Output webhook info to help configure historyScan.channels
  {
    const seen = new Set<SenderBot>();
    for (const sb of senderBotsBySource.values()) {
      if (seen.has(sb)) continue;
      seen.add(sb);
      try {
        console.log(`[webhook] guild_id=${sb.webhookGuildId || "-"} channel_id=${sb.defaultChannelId || "-"}`);
      } catch {}
    }
  }

  console.log("[Startup] 正在初始化 Discord 客户端...");
  const client: Client = new SelfBotClient();
  const bot = new Bot(client, config, defaultSenderBot!, senderBotsBySource, senderBotsByWebhook);

  // 初始化 token checker
  console.log("[Startup] 正在初始化 Token 检查器...");
  const tokenChecker = new TokenChecker(client);
  await tokenChecker.init();
  console.log("[Startup] ✓ Token 检查器已初始化");

  // 当客户端准备好后，启动 token 检查
  client.once("ready", () => {
    console.log("[Startup] ✅ Discord 客户端已就绪");
    console.log("[TokenChecker] Discord client ready, starting token monitoring...");
    tokenChecker.checkAndNotify().catch(console.error);
    sendStartupNotification(defaultSenderBot).catch(console.error);
  });

  client.on("error", (error) => {
    console.error("[Startup] ❌ Discord 客户端错误:", error);
  });

  console.log("[Startup] 正在登录 Discord...");
  try {
    await bot.client.login(env.DISCORD_TOKEN);
    console.log("[Startup] ✓ 登录请求已发送，等待连接...");
  } catch (error) {
    console.error("[Startup] ❌ 登录失败:", error);
    process.exit(1);
  }

  const gracefulShutdown = async () => {
    console.log("\n[Shutdown] Gracefully shutting down...");
    await tokenChecker.destroy();
    process.exit(0);
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
  } catch (error) {
    console.error("[Startup] Bootstrap 内部错误:", error);
    if (error instanceof Error && error.stack) {
      console.error("[Startup] 堆栈:", error.stack);
    }
    throw error;
  }
}

bootstrap().catch((error) => {
  console.error("[Startup] ❌ 启动失败:", error);
  if (error instanceof Error) {
    console.error("[Startup] 错误堆栈:", error.stack);
  }
  process.exit(1);
});
