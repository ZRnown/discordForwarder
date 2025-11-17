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
import { isAllowedByConfig } from "./filterMessages.js";
import { formatSize } from "./format.js";
import { SenderBot } from "./senderBot.js";
import { getEnv } from "./env.js";
import { ProxyAgent } from "proxy-agent";

interface RenderOutput {
  content: string;
}

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

export class Bot {
  messagesToSend: string[] = [];
  senderBot: SenderBot;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  private sourceToTarget = new Map<string, { channelId: string; messageId: string }>();
  private env = getEnv();
  private httpAgent = this.env.PROXY_URL
    ? new ProxyAgent({ getProxyForUrl: () => this.env.PROXY_URL })
    : undefined;

  constructor(client: Client, config: Config, senderBot: SenderBot) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;

    // @ts-expect-error This expression is not callable.
    this.client.on("ready", (clientArg: Client<true>) => {
      console.log(`Logged into Discord as @${clientArg.user?.tag}!`);
    });

    // @ts-expect-error This expression is not callable.
    this.client.on("messageCreate", async (message: Message) => {
      if (!isAllowedByConfig(message, this.config)) return;
      await this.processAndSend(message);
    });

    if (config.showMessageUpdates)
      // @ts-expect-error This expression is not callable.
      this.client.on(
        "messageUpdate",
        async (_oldMessage: Message, newMessage: Message) => {
          if (!isAllowedByConfig(newMessage, this.config)) return;
          await this.processAndSend(newMessage, "updated");
        }
      );

    if (config.showMessageDeletions)
      // @ts-expect-error This expression is not callable.
      this.client.on("messageDelete", async (message: Message) => {
        if (!isAllowedByConfig(message, this.config)) return;
        await this.processAndSend(message, "deleted");
      });

    // 为了支持“回复可跳转”，改为单条即时发送（如需保留堆叠，可另加配置开关）
  }

  private async processAndSend(message: Message, tag?: string) {
    const renderOutput = await this.messageAction(message, tag);

    // DeepSeek 翻译：有文本即可（不再要求“纯文本”），开关启用且存在内容
    const hasText = (message.content?.trim() || "") !== "";
    let originalContent = (renderOutput.content || "").trim();
    let translatedText: string | undefined;

    // 构造真实回复：若已建立映射，则通过 webhook 的 message_reference 在目标侧回复
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    let ctaLine: string | undefined;
    if (message.reference) {
      try {
        const ref = await message.fetchReference();
        const mapped = this.sourceToTarget.get(ref.id);
        if (mapped) {
          replyToTarget = { channelId: mapped.channelId, messageId: mapped.messageId };
          // 无论是否有附件/Embed，都生成 CTA 行；有资产时用“查看附件”，否则用“查看消息”
          if (this.senderBot.webhookGuildId) {
            const link = `https://discord.com/channels/${this.senderBot.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
            const display = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
            const hasAssets = (ref.attachments?.size ?? 0) > 0 || (ref.embeds?.length ?? 0) > 0;
            const label = hasAssets ? "查看附件" : "查看消息";
            ctaLine = `↳ @${display}: [${label}](${link})`;
          }
        }
      } catch (err) {
        console.error(err);
      }
    }

    // 翻译：有文本即可
    if (this.env.TRANSLATION_ENABLED !== "false" && hasText && this.env.DEEPSEEK_API_KEY) {
      try {
        translatedText = await this.translateText(originalContent);
      } catch (e) {
        console.error(e);
      }
    }

    // 拼装最终内容：CTA 在顶部；译文段不重复 CTA
    const parts: string[] = [];
    if (ctaLine) parts.push(ctaLine);
    if (originalContent) parts.push(originalContent);
    if (translatedText) {
      parts.push("-----------");
      parts.push(translatedText);
    }
    const finalContent = parts.join("\n");

    // 伪装作者：使用源作者的昵称/用户名和头像
    const username = (message.member as any)?.displayName || message.author.username || message.author.tag;
    let avatarUrl: string | undefined;
    try {
      const anyAuthor = message.author as any;
      if (typeof anyAuthor.displayAvatarURL === "function") {
        avatarUrl = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
      } else if (typeof anyAuthor.avatarURL === "function") {
        avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
      }
    } catch {}

    // 收集需要上传的附件：首张图片将内嵌到同一个 Embed，视频/其他作为同条消息的附件（可直接播放）
    const uploads: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
    try {
      for (const att of message.attachments.values()) {
        const url = att.url;
        const filename = att.name || "file";
        const ct = (att.contentType || "").toLowerCase();
        const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
        const isVideo = ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(url);
        uploads.push({ url, filename, isImage, isVideo });
      }
    } catch {}

    const toSend = [{
      content: `${finalContent}`.trim(),
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed: true,
      uploads
    }];

    const results = await this.senderBot.sendData(toSend);
    if (results && results.length > 0) {
      const first = results[0];
      if (first.sourceMessageId) {
        this.sourceToTarget.set(first.sourceMessageId, {
          channelId: first.targetChannelId,
          messageId: first.targetMessageId
        });
      }
    }
  }

  async messageAction(
    message: Message<boolean> | PartialMessage,
    tag?: string
  ) {
    const debug = this.env.DEBUG_OUTPUT === "true";
    let render = "";
    const allAttachments: string[] = [];

    if (debug) {
      // 仅在调试模式下展开引用内容，但不再输出源站链接。
      if (message.reference) {
        const referenceMessage = await message.fetchReference();
        const renderOutput = await this.messageAction(referenceMessage);
        // 若已有源→目标映射，则展示目标内可点击链接；否则仅展示内容
        const mapped = this.sourceToTarget.get(referenceMessage.id);
        if (mapped && this.senderBot.webhookGuildId) {
          const targetLink = `https://discord.com/channels/${this.senderBot.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
          render += `\n(引用 @${referenceMessage.author.tag} 的消息:\n> ${renderOutput.content}\n> 目标内链接: [查看消息](${targetLink}))\n`;
        } else {
          render += `\n(引用 @${referenceMessage.author.tag} 的消息:\n> ${renderOutput.content})\n`;
        }
      }
    }

    render += await this.renderMentions(
      message.content,
      message.mentions.users.values(),
      message.mentions.channels.values(),
      message.mentions.roles.values()
    );

    if (debug) {
      const embeds = message.embeds.map((embed) => {
        let stringEmbed = "Embed:\n";

        if (embed.title) stringEmbed += `  Title: ${embed.title}\n`;
        if (embed.description)
          stringEmbed += `  Description: ${embed.description}\n`;
        if (embed.url) stringEmbed += `  Url: ${embed.url}\n`;
        if (embed.color) stringEmbed += `  Color: ${embed.color}\n`;
        if (embed.timestamp) stringEmbed += `  Url: ${embed.timestamp}\n`;

        const fields = embed.fields.map(
          (field) =>
            `    Field:\n      Name: ${field.name}\n      Value: ${field.value}\n`
        );
        if (fields.length != 0) stringEmbed += `  Fields:\n${fields.join("")}`;

        if (embed.thumbnail)
          stringEmbed += `  Thumbnail: ${embed.thumbnail.url}\n`;
        if (embed.image) stringEmbed += `  Image: ${embed.image.url}\n`;
        if (embed.video) stringEmbed += `  Video: ${embed.video.url}\n`;
        if (embed.author) stringEmbed += `  Author: ${embed.author.name}\n`;
        if (embed.footer) stringEmbed += `  Footer: ${embed.footer.iconURL}\n`;

        return stringEmbed;
      });

      render += embeds.join("");

      for (const attachment of message.attachments.values()) {
        allAttachments.push(
          `Attachment:\n  Name: ${attachment.name}\n${
            attachment.description
              ? `\tDescription: ${attachment.description}\n`
              : ""
          }  Size: ${formatSize(attachment.size)}\n  Url: ${attachment.url}`
        );
      }

      render += allAttachments.join("");
    }

    if (debug) console.log(render);

    return { content: render } as RenderOutput;
  }

  private async translateText(text: string): Promise<string | null> {
    try {
      const url = this.env.DEEPSEEK_API_URL as string;
      const payload = JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are a translation engine. Translate the user content into Chinese accurately and concisely. Keep URLs as-is." },
          { role: "user", content: text }
        ],
        temperature: 0.3
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
          Authorization: `Bearer ${this.env.DEEPSEEK_API_KEY}`,
          "Content-Length": Buffer.byteLength(payload)
        },
        agent: this.httpAgent as any
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
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });

      const content = result?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content.trim() : null;
    } catch (e) {
      return null;
    }
  }

  async renderMentions(
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
      } catch (err) {
        console.error(err);
      }
    }

    for (const role of roles) {
      text = text.replace(`<@&${role.id}>`, `@${role.name}`);
    }

    return text;
  }
}
