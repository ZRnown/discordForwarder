// Polyfill for File API in pkg environment
if (typeof globalThis.File === "undefined") {
  try {
    // Try to use Node.js built-in File (Node 18+)
    const buffer = require("node:buffer");
    if (buffer.File) {
      globalThis.File = buffer.File;
    } else {
      throw new Error("File not available");
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

// 控制台日志级别：默认仅在非 "error" 模式打印常规信息
const shouldLog = (process.env.LOG_LEVEL || "error") !== "error";
// 立即输出启动信息（受 shouldLog 控制）
if (shouldLog) {
  console.log("=".repeat(50));
  console.log("[Bootstrap] 程序开始启动...");
  console.log("[Bootstrap] Node.js 版本:", process.version);
  console.log("[Bootstrap] 工作目录:", process.cwd());
  console.log("=".repeat(50));
}

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
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";

import { Bot, Client } from "./bot.js";
import { getConfig } from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { TokenChecker } from "./tokenChecker.js";
import { FileLogger } from "./logger.js";

const runtimeLogger = new FileLogger();
runtimeLogger.installConsoleCapture();

async function sendStartupNotification(defaultSender: SenderBot | undefined) {
  const content = `[BOT] ✅ 转发器已启动（${new Date().toLocaleString("zh-CN")}）`;

  // Only send to webhook when explicitly enabled via env var
  const env = getEnv();
  const sendEnabled =
    String(env.SEND_STARTUP_NOTIFICATION || "false") === "true";
  if (!defaultSender || !sendEnabled) {
    // don't send; record to log file (respect minimal console output)
    try {
      if (shouldLog) {
        await runtimeLogger.info(content);
      } else {
        // ensure it's recorded even when LOG_LEVEL=error by writing as ERROR
        await runtimeLogger.error(content);
      }
    } catch {}
    return;
  }

  try {
    await defaultSender.sendData([
      {
        content
      }
    ]);
    if (shouldLog) console.log("[Startup] 已向默认目标发送启动通知");
  } catch (error) {
    console.error("[Startup] 启动通知发送失败：", error);
  }
}

async function bootstrap() {
  try {
    if (shouldLog) console.log("[Startup] 正在启动转发器...");
    if (shouldLog) console.log("[Startup] 工作目录:", process.cwd());
    if (shouldLog) console.log("[Startup] 正在加载环境变量...");
    const env = getEnv();
    if (!env.DISCORD_TOKEN) {
      console.error("[Startup] ❌ 错误: 未找到 DISCORD_TOKEN 环境变量");
      console.error("[Startup] 请确保 .env 文件存在且包含 DISCORD_TOKEN");
      process.exit(1);
    }
    if (shouldLog) console.log("[Startup] ✓ DISCORD_TOKEN 已加载");

    if (shouldLog) console.log("[Startup] 正在加载配置文件...");
    const config = await getConfig();
    if (shouldLog) console.log("[Startup] ✓ 配置文件已加载");

    // Build mapping from source channel IDs to webhook URLs (support multiple targets per source)
    const senderBotsBySource = new Map<string, SenderBot[]>();
    const senderBotsByWebhook = new Map<string, SenderBot>();
    let defaultSenderBot: SenderBot | undefined;
    const prepares: Promise<any>[] = [];

    const ensureSenderBot = (
      webhookEntry:
        | string
        | {
            url: string;
            remark?: string;
            displayName?: string;
            avatarUrl?: string;
            threadId?: string;
            threadName?: string;
            emojiMap?: Record<
              string,
              string | { id: string; name?: string; animated?: boolean }
            >;
          }
    ) => {
      const webhookUrl =
        typeof webhookEntry === "string" ? webhookEntry : webhookEntry.url;
      const senderKey =
        typeof webhookEntry === "string"
          ? webhookUrl
          : `${webhookUrl}|threadId:${webhookEntry.threadId || ""}|threadName:${webhookEntry.threadName || ""}`;
      let existing = senderBotsByWebhook.get(senderKey);
      if (existing) return existing;
      const sb = new SenderBot({
        chatsToSend: [],
        replacementsDictionary: config.replacementsDictionary,
        webhookUrl,
        remark:
          typeof webhookEntry === "object" ? webhookEntry.remark : undefined,
        displayName:
          typeof webhookEntry === "object"
            ? webhookEntry.displayName
            : undefined,
        avatarUrl:
          typeof webhookEntry === "object" ? webhookEntry.avatarUrl : undefined,
        threadId:
          typeof webhookEntry === "object" ? webhookEntry.threadId : undefined,
        threadName:
          typeof webhookEntry === "object"
            ? webhookEntry.threadName
            : undefined,
        emojiMap:
          typeof webhookEntry === "object" ? webhookEntry.emojiMap : undefined
      });
      senderBotsByWebhook.set(senderKey, sb);
      if (!senderBotsByWebhook.has(webhookUrl)) {
        senderBotsByWebhook.set(webhookUrl, sb);
      }
      prepares.push(sb.prepare());
      return sb;
    };

    // 1) Base mapping from channelWebhooks
    if (
      config.channelWebhooks &&
      Object.keys(config.channelWebhooks).length > 0
    ) {
      for (const [channelId, webhookEntry] of Object.entries(
        config.channelWebhooks
      )) {
        const entries = Array.isArray(webhookEntry)
          ? webhookEntry
          : [webhookEntry];
        const sbs: SenderBot[] = entries.map((e) => ensureSenderBot(e));
        senderBotsBySource.set(channelId, sbs);
        if (!defaultSenderBot && sbs.length > 0) defaultSenderBot = sbs[0];
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
      console.error(
        "[Startup] 请在 config.json 的 channelWebhooks 中至少配置一个 webhook URL"
      );
      process.exit(1);
    }
    if (shouldLog) console.log("[Startup] ✓ Webhook 配置已加载");

    await Promise.all(prepares);

    // Output webhook info to help configure historyScan.channels
    {
      const seen = new Set<SenderBot>();
      for (const sbs of senderBotsBySource.values()) {
        for (const sb of sbs) {
          if (seen.has(sb)) continue;
          seen.add(sb);
          try {
            if (shouldLog)
              console.log(
                `[webhook] guild_id=${(sb as any).webhookGuildId || "-"} channel_id=${(sb as any).defaultChannelId || "-"}`
              );
          } catch {}
        }
      }
    }

    if (shouldLog) console.log("[Startup] 正在初始化 Discord 客户端...");
    const backend = env.DISCORD_BOT_BACKEND === "bot" ? "bot" : "selfbot";
    const client: Client =
      backend === "bot"
        ? new BotClient({
            intents: [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent
            ],
            partials: [Partials.Channel, Partials.Message]
          })
        : new SelfBotClient();
    const bot = new Bot(
      client,
      config,
      defaultSenderBot!,
      senderBotsBySource,
      senderBotsByWebhook
    );

    // 初始化 token checker
    if (shouldLog) console.log("[Startup] 正在初始化 Token 检查器...");
    const tokenChecker = new TokenChecker(client);
    await tokenChecker.init();
    if (shouldLog) console.log("[Startup] ✓ Token 检查器已初始化");

    // 当客户端准备好后，启动 token 检查
    (client as any).once("ready", () => {
      const user = client.user;
      if (user) {
        if (shouldLog) console.log("[Startup] ✅ Discord 客户端已就绪");
        if (shouldLog)
          console.log(`[Startup] 登录账号: ${user.tag} (ID: ${user.id})`);
      } else {
        if (shouldLog) console.log("[Startup] ✅ Discord 客户端已就绪");
      }
      if (shouldLog)
        console.log(
          "[TokenChecker] Discord client ready, starting token monitoring..."
        );
      tokenChecker.checkAndNotify().catch(console.error);
      sendStartupNotification(defaultSenderBot).catch(console.error);
    });

    (client as any).on("error", (error: any) => {
      console.error("[Startup] ❌ Discord 客户端错误:", error);
    });

    if (shouldLog)
      console.log(`[Startup] 正在登录 Discord... backend=${backend}`);
    try {
      const loginToken =
        backend === "bot" ? `Bot ${env.DISCORD_TOKEN}` : env.DISCORD_TOKEN;
      await bot.client.login(loginToken);
      if (shouldLog) console.log("[Startup] ✓ 登录请求已发送，等待连接...");
    } catch (error) {
      console.error("[Startup] ❌ 登录失败:", error);
      const errorMessage = (error as any)?.message || String(error);
      const errorCode = (error as any)?.code;
      const isInvalidToken =
        errorCode === "TOKEN_INVALID" ||
        errorMessage.toLowerCase().includes("invalid token") ||
        errorMessage.includes("An invalid token was provided");
      if (isInvalidToken) {
        console.error("[Startup] ⚠️ 检测到 Token 无效，触发通知");
        try {
          await tokenChecker.notifyInvalidNow("invalid");
        } catch (notifyError) {
          console.error("[Startup] 发送 Token 无效通知失败:", notifyError);
        }
      }
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
