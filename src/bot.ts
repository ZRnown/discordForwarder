import {
  AnyChannel,
  Client as SelfBotClient,
  Message,
  PartialMessage,
  Role,
  User
} from "discord.js-selfbot-v13";
import { Client as BotClient } from "discord.js";

import { Config } from "./config.js";
import { formatSize } from "./format.js";
import { SenderBot } from "./senderBot.js";
import { getEnv } from "./env.js";
import { FileLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

export class Bot {
  messagesToSend: string[] = [];
  senderBot: SenderBot; // default sender
  private senderBotsBySource?: Map<string, SenderBot>;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  private sourceToTarget = new Map<string, { channelId: string; messageId: string }>();
  private env = getEnv();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();

  constructor(client: Client, config: Config, senderBot: SenderBot, senderBotsBySource?: Map<string, SenderBot>) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;

    // 保留可选的通用日志过滤（仅按 filterPattern）
    try {
      const logCfg = this.config.logging || ({} as any);
      const pattern = logCfg.filterPattern;
      if (typeof (this.logger as any).setFilter === "function") {
        (this.logger as any).setFilter(pattern);
      }
    } catch { }

    (this.client as any).on("ready", (clientArg: Client<true>) => {
      const msg = `已登录 Discord，账号 @${clientArg.user?.tag}`;
      this.logger.info(msg);
    });

    // 监听客户端错误，避免 ECONNRESET 直接导致进程崩溃
    (this.client as any).on("error", (err: any) => {
      this.logger.error(`client error: ${String(err?.stack || err)}`);
    });
    (this.client as any).on?.("shardError", (err: any) => {
      this.logger.error(`shard error: ${String(err?.stack || err)}`);
    });
    (this.client as any).on("warn", (info: any) => {
      this.logger.debug(`client warn: ${String(info)}`);
    });

    (this.client as any).on("messageCreate", async (message: Message) => {
      this.logger.debug(`收到新消息: guild=${message.guildId || "DM"} channel=${message.channelId} id=${message.id} author=${message.author?.tag}`);
      await this.processAndSend(message);
    });

    // 移除 specialChannels 专用的 messageUpdate 监听

    // 为了支持“回复可跳转”，改为单条即时发送（如需保留堆叠，可另加配置开关）
  }

  private getSenderForChannel(channelId: string): SenderBot | undefined {
    return this.senderBotsBySource?.get(channelId);
  }

  private async ensureDataDir() {
    const dir = path.dirname(this.mapFile);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      this.logger.error(`ensureDataDir failed: ${String(e)}`);
    }
  }

  private async loadMapping() {
    try {
      await this.ensureDataDir();
      const buf = await fs.readFile(this.mapFile, "utf-8");
      const json = JSON.parse(buf) as Record<string, { channelId: string; messageId: string }>;
      this.sourceToTarget = new Map(Object.entries(json));
    } catch { }
  }

  private async saveMapping() {
    try {
      await this.ensureDataDir();
      const obj = Object.fromEntries(this.sourceToTarget.entries());
      const tmp = this.mapFile + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(obj), "utf-8");
      await fs.rename(tmp, this.mapFile);
    } catch { }
  }

  private async processAndSend(message: Message, tag?: string) {
    // 懒加载历史映射（进程首次消息时）
    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    // 渲染 mentions 后得到用户可见文本
    const renderOutput = await this.messageAction(message, tag);
    const originalText = (renderOutput.content || "").trim();

    const sender = this.getSenderForChannel(message.channelId);
    if (!sender) {
      this.logger.debug(`跳过：未映射的源频道 channel=${message.channelId}`);
      return;
    }

    // 回复映射：若被回复消息存在映射，则在目标侧关联为引用
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    let components: any[] | undefined;
    const actionButtons: any[] = [];
    let replyJumpUrl: string | undefined;
    try {
      if (message.reference?.messageId) {
        const mapped = this.sourceToTarget.get(message.reference.messageId);
        if (mapped) {
          replyToTarget = { channelId: mapped.channelId, messageId: mapped.messageId };
          // 如果 webhookGuildId 存在，添加一个按钮跳转到被回复消息的目标链接
          if (sender.webhookGuildId) {
            const url = `https://discord.com/channels/${sender.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
            replyJumpUrl = url;
            actionButtons.push({ type: 2, style: 5, label: "查看被回复", url });
          }
        } else {
          // 映射不存在，提供回退：指向源被回复消息
          const refChan = message.reference.channelId || message.channelId;
          const gid = message.guildId || "@me";
          const srcReplyUrl = `https://discord.com/channels/${gid}/${refChan}/${message.reference.messageId}`;
          actionButtons.push({ type: 2, style: 5, label: "查看被回复(源)", url: srcReplyUrl });
          // 作为头部链接回退
          replyJumpUrl = replyJumpUrl || srcReplyUrl;
        }
      }
    } catch { }

    // 始终提供“查看源消息”按钮（若能构造 URL）
    try {
      const gid = message.guildId || "@me";
      const sourceUrl = `https://discord.com/channels/${gid}/${message.channelId}/${message.id}`;
      actionButtons.push({ type: 2, style: 5, label: "查看源消息", url: sourceUrl });
    } catch { }

    if (actionButtons.length > 0) {
      components = [
        {
          type: 1,
          components: actionButtons
        }
      ];
    }

    // 伪装作者为源作者（中文日志）
    let username = (message.author as any)?.globalName || message.author.username || message.author.tag;
    let avatarUrl: string | undefined;
    try {
      const anyAuthor = message.author as any;
      if (typeof anyAuthor.displayAvatarURL === "function") {
        avatarUrl = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
      } else if (typeof anyAuthor.avatarURL === "function") {
        avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
      }
    } catch { }

    // 收集当前消息的附件（图片/视频标记用于 embed 图像）
    const uploads: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
    try {
      for (const att of message.attachments.values()) {
        const url = att.url;
        const filename = att.name || "file";
        const ct = (att.contentType || "").toLowerCase();
        const isImage = ct.startsWith("image/") || /(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)$/i.test(url);
        const isVideo = ct.startsWith("video/") || /(\.mp4|\.mov|\.webm|\.mkv|\.avi)$/i.test(url);
        uploads.push({ url, filename, isImage, isVideo });
      }
    } catch { }

    // 特判：单条 Twitter/X 或 Tenor/Giphy 链接，改为纯文本发送触发原生预览
    const rawContent = (message.content || "").trim();
    const cleanedSingle = rawContent.replace(/[<>]/g, "");
    const isSingleUrl = /^(https?:\/\/\S+)$/.test(cleanedSingle);
    const isTwitterOnly = isSingleUrl && /^(?:https?:\/\/)(?:x\.com|twitter\.com)\//i.test(cleanedSingle);
    const isGifPageOnly = isSingleUrl && /^(?:https?:\/\/)(?:tenor\.com|giphy\.com)\//i.test(cleanedSingle);

    let useEmbed = true;
    let finalText = originalText;
    if (isTwitterOnly || isGifPageOnly) {
      useEmbed = false;
      finalText = cleanedSingle;
      uploads.length = 0; // 不携带附件
    }

    // 始终提供“查看源消息”按钮（若能构造 URL）
    try {
      const gid = message.guildId || "@me";
      const sourceUrl = `https://discord.com/channels/${gid}/${message.channelId}/${message.id}`;
      actionButtons.push({ type: 2, style: 5, label: "查看源消息", url: sourceUrl });
    } catch { }

    if (actionButtons.length > 0) {
      components = [
        {
          type: 1,
          components: actionButtons
        }
      ];
    }

    // 若源消息为“回复”，无论是否能建立真正引用，都在文本最前添加可见的回复头部，仅保留作者与可点击链接（不重复展示纯文本频道名）
    console.log(`[DEBUG] Processing message ${message.id}, has reference:`, !!message.reference?.messageId);
    if (message.reference?.messageId) {
      console.log(`[DEBUG] Message ${message.id} is a reply to ${message.reference.messageId}`);
      let authorName: string | undefined;
      try {
        const ref = await message.fetchReference();
        authorName = (ref.author as any)?.globalName || ref.author?.username || ref.author?.tag || undefined;
        console.log(`[DEBUG] Fetched reference author:`, authorName);
      } catch (err) {
        console.log(`[DEBUG] Failed to fetch reference:`, err);
        try {
          const ru: any = (message as any).mentions?.repliedUser;
          if (ru) authorName = ru.globalName || ru.username || ru.tag;
          console.log(`[DEBUG] Fallback to repliedUser:`, authorName);
        } catch { }
      }
      if (!authorName) authorName = "某条消息";
      const link = replyJumpUrl ? ` • ${replyJumpUrl}` : "";
      const header = `↳ @${authorName}${link}`;
      console.log(`[DEBUG] Adding reply header:`, header);
      finalText = `${header}\n${finalText}`;
      console.log(`[DEBUG] Final text after header:`, finalText.substring(0, 100));
    }

    // 翻译逻辑：仅在满足启用条件时追加译文（且不是单链接场景）
    try {
      const env = this.env;
      if (!isTwitterOnly && !isGifPageOnly && env && env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_URL && env.TRANSLATION_ENABLED !== "false") {
        const raw = originalText;
        const hasLatin = /[A-Za-z]/.test(raw);
        const hasCJK = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(raw);
        const urlRe = /^(<?https?:\/\/\S+>?)$/i;
        const tokens = raw.split(/\s+/).filter(Boolean);
        const isAllUrls = tokens.length > 0 && tokens.every((t) => urlRe.test(t));
        const cleaned = raw.replace(/\p{Cf}/gu, "");
        const aliasFilter = cleaned.replace(/[^:\sA-Za-z0-9_~+.-]/gu, "");
        const isOnlyAliasEmotes = /^(?:\s*:[A-Za-z0-9_~+.-]+:\s*)+$/u.test(aliasFilter);
        const isOnlyCustomEmotes = /^(?:\s*<a?:[A-Za-z0-9_~+.-]+:\d+>\s*)+$/u.test(raw);
        const compact = raw.replace(/[\s\n\r\t]+/g, "");
        const emojiOnly = compact.length > 0 && compact.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu, "") === "";
        const shouldTranslate = hasLatin && !hasCJK && !isAllUrls && !isOnlyAliasEmotes && !isOnlyCustomEmotes && !emojiOnly;
        if (shouldTranslate) {
          const translated = await this.translateText(raw);
          if (translated) {
            const a = raw.trim();
            const b = translated.trim();
            if (b && b.toLowerCase() !== a.toLowerCase()) {
              finalText = `${a}\n-----------\n${b}`;
            }
          }
        }
      }
    } catch { }

    const toSend = [{
      content: finalText,
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed,
      uploads,
      ...(components ? { components } : {})
    }];

    toSend[0].content = finalText;

    // 添加明确的日志显示要发送的内容
    if (message.reference?.messageId) {
      this.logger.info(`[REPLY] Sending reply message: sourceId=${message.id} replyTo=${message.reference.messageId}`);
      this.logger.info(`[REPLY] Content preview: ${finalText.substring(0, 150)}`);
      this.logger.info(`[REPLY] Has replyToTarget: ${!!replyToTarget}, useEmbed: ${useEmbed}`);
    }

    try {
      const results = await sender.sendData(toSend);
      if (results && results.length > 0) {
        const first = results[0];
        if (first.sourceMessageId) {
          this.sourceToTarget.set(first.sourceMessageId, { channelId: first.targetChannelId, messageId: first.targetMessageId });
          await this.saveMapping();
          this.logger.info(`已转发: source=${first.sourceMessageId} -> target=${first.targetChannelId}/${first.targetMessageId}`);
        }
      }
    } catch (e) {
      this.logger.error(`转发失败: ${String(e)}`);
    }
  }

  // 在目标频道历史消息中尝试解析出某个 sourceId 的映射
  private async tryResolveMappingFromTarget(_sourceId: string, _senderForThis?: SenderBot): Promise<{ channelId: string; messageId: string } | undefined> {
    // historyScan disabled: do not scan target channels to resolve mappings
    return undefined;
  }

  async messageAction(
    message: Message<boolean> | PartialMessage,
    tag?: string
  ) {
    let render = "";
    const allAttachments: string[] = [];

    // 用户可见内容：仅进行 mention 渲染，不包含调试信息
    render += await this.renderMentions(
      message.content,
      message.mentions.users.values(),
      message.mentions.channels.values(),
      message.mentions.roles.values()
    );

    // 构建详尽日志并写入文件
    try {
      let log = `messageAction id=${message.id} guild=${message.guildId || "DM"} channel=${message.channelId} author=${(message as any).author?.tag}`;
      if (tag) log += ` tag=${tag}`;
      if (message.reference) {
        try {
          const referenceMessage = await message.fetchReference();
          const mapped = this.sourceToTarget.get(referenceMessage.id);
          const hasAssets = (referenceMessage.attachments?.size ?? 0) > 0 || (referenceMessage.embeds?.length ?? 0) > 0;
          log += `\n  reference: author=${referenceMessage.author?.tag} mapped=${!!mapped} assets=${hasAssets}`;
        } catch (e) {
          log += `\n  reference: fetch failed ${String(e)}`;
        }
      }
      for (const embed of message.embeds) {
        log += `\n  Embed:`;
        if (embed.title) log += `\n    Title: ${embed.title}`;
        if (embed.description) log += `\n    Description: ${embed.description}`;
        if (embed.url) log += `\n    Url: ${embed.url}`;
        if (embed.thumbnail) log += `\n    Thumbnail: ${embed.thumbnail.url}`;
        if (embed.image) log += `\n    Image: ${embed.image.url}`;
        if (embed.video) log += `\n    Video: ${(embed as any).video?.url || "yes"}`;
        if (embed.author) log += `\n    Author: ${embed.author.name}`;
        if (embed.footer) log += `\n    Footer: ${(embed.footer as any)?.text || ""}`;
      }
      for (const attachment of message.attachments.values()) {
        log += `\n  Attachment: name=${attachment.name} size=${formatSize(attachment.size)} url=${attachment.url}`;
      }
      await this.logger.debug(log);
    } catch { }

    return { content: render } as RenderOutput;
  }

  private async renderMentions(
    text: string,
    users: IterableIterator<User>,
    channels: IterableIterator<AnyChannel>,
    roles: IterableIterator<Role>
  ) {
    for (const user of users) {
      text = text.replace(`<@${user.id}>`, `@${user.displayName}`);
    }

    for (const channel of channels) {
      try {
        const fetchedChannel = await channel.fetch();

        text = text.replace(
          `<#${channel.id}>`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `#${(fetchedChannel as any).name}`
        );
      } catch (e) {
        this.logger.error(`renderMentions failed to fetch channel: ${String(e)}`);
      }
    }

    for (const role of roles) {
      text = text.replace(`<@&${role.id}>`, `@${role.name}`);
    }

    return text;
  }

  private async translateText(text: string): Promise<string | null> {
    try {
      const raw = (text || "").trim();
      if (!raw) return null;
      const url = String(this.env.DEEPSEEK_API_URL || "");
      const key = String(this.env.DEEPSEEK_API_KEY || "");
      if (!url || !key) return null;

      // Protect emoji aliases, custom emojis, and native emojis from being altered by translation
      const placeholders: string[] = [];
      let safe = raw.replace(/<a?:[A-Za-z0-9_~+.-]+:\\d+>/g, (m) => {
        const idx = placeholders.push(m) - 1;
        return `__EMJ_${idx}__`;
      });
      safe = safe.replace(/:[A-Za-z0-9_~+.-]+:/g, (m) => {
        const idx = placeholders.push(m) - 1;
        return `__EMJ_${idx}__`;
      });
      // Mask native pictographic emojis
      safe = safe.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu, (m) => {
        const idx = placeholders.push(m) - 1;
        return `__EMJ_${idx}__`;
      });

      const payload = JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "You are a deterministic translation engine. Translate input to Simplified Chinese. Output ONLY the translated text."
          },
          {
            role: "user",
            content: safe
          }
        ],
        temperature: 0
      });

      const https = await import("node:https");
      const { URL } = await import("node:url");
      const u = new URL(url);
      const options: import("node:https").RequestOptions = {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      const result: any = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(body ? JSON.parse(body) : null);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.setTimeout(15000, () => req.destroy(new Error("DeepSeek 请求超时")));
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });

      let content = result?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;
      // Restore placeholders
      content = content.replace(/__EMJ_(\d+)__/g, (_, i) => {
        const idx = Number(i);
        return Number.isFinite(idx) && placeholders[idx] != null ? placeholders[idx] : _;
      });
      return content.trim();
    } catch {
      return null;
    }
  }
}
