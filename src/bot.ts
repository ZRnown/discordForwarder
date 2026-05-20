import {
  AnyChannel,
  Client as SelfBotClient,
  Message,
  PartialMessage,
  Role,
  User
} from "discord.js-selfbot-v13";
import { Client as BotClient } from "discord.js";

import {
  ActiveCategory,
  ActiveCategoryConfig,
  ActivePersonaConfig,
  ChannelId,
  Config
} from "./config.js";
import { formatSize } from "./format.js";
import { SenderBot } from "./senderBot.js";
import { getEnv } from "./env.js";
import { FileLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

interface ActiveOverrideResult {
  content: string;
  senderBot?: SenderBot;
  extraSenderBots?: SenderBot[];
  username?: string;
  avatarUrl?: string;
  useEmbed?: boolean;
  components?: any[];
}

interface PersonaMatch {
  config: ActivePersonaConfig;
}

interface TargetMessageMapping {
  channelId: string;
  messageId: string;
}

interface StoredTargetMessageMapping extends TargetMessageMapping {
  targets?: Record<string, TargetMessageMapping>;
}

interface TargetScopeLike {
  webhookGuildId?: string;
  remark?: string;
  webhookUrl?: string;
  defaultChannelId?: string;
  threadId?: string;
  threadName?: string;
}

interface PendingSourceForwardState {
  promise: Promise<void>;
  resolve: () => void;
  refCount: number;
}

interface RawGatewayReference {
  messageId: string;
  channelId?: string;
  guildId?: string;
}

interface RawGatewayReferencedMessage {
  id: string;
  channelId?: string;
  guildId?: string;
  content: string;
  embeds: any[];
  attachments: Map<string, any>;
  mentions: {
    users: Map<any, any>;
    channels: Map<any, any>;
    roles: Map<any, any>;
  };
  author?: {
    id?: string;
    username?: string;
    globalName?: string;
    tag?: string;
  };
  createdTimestamp?: number;
}

interface RawGatewayMessageRecord {
  reference?: RawGatewayReference;
  referencedMessage?: RawGatewayReferencedMessage;
}

interface ForwardUpload {
  url: string;
  filename: string;
  isImage?: boolean;
  isVideo?: boolean;
}

const ACTIVE_HEADLINE_MAP: Record<string, string> = {
  "running (valid for entry)": "策略执行中 (允许入场)",
  "valid limits (not yet filled)": "有效限价单 (尚未成交)",
  "invalid (running & stops at entry)":
    "订单无效 (策略执行中 & 止损设在入场价)",
  "valid limits": "有效限价单"
};

const STANDALONE_LINE_MAP: Record<string, string> = {
  "no trades available": "当前无可成交交易"
};

const INLINE_PHRASE_MAP: Record<string, string> = {
  "(not yet filled)": "(尚未成交)",
  "not yet filled": "(尚未成交)"
};

const ALERT_ACTION_MAP: Record<string, string> = {
  "stopped be": "止损移至保本价",
  "stops moved to be": "止损移至保本价",
  "closed in profits": "盈利平仓",
  "closed be": "保本止损被触发",
  "stopped out": "止损平仓",
  "limit order filled": "限价订单已成交",
  "limit order cancelled": "限价订单已取消",
  "updated stoploss, average entry, entry levels":
    "止损位已更新, 平均入场价, 分批入场点位"
};

const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u2028\u2029\uFEFF\u2060]/g;

// 过滤掉动态内容（Discord 时间戳等），用于去重比较
function filterDynamicContent(text: string): string {
  // 过滤 Discord 时间戳：<t:数字:R> 或 <t:数字:F> 等格式
  return text.replace(/<t:\d+:[RFDT]>/g, "<t:DYNAMIC:R>");
}

const matchesId = (expected: ChannelId, actual: string) =>
  expected != null && String(expected) === actual;

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

export class Bot {
  messagesToSend: string[] = [];
  senderBot: SenderBot; // default sender
  private senderBotsBySource?: Map<string, SenderBot[]>;
  private senderBotsByWebhook?: Map<string, SenderBot>;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（同一源消息可按目标社区保存多个镜像消息）
  private sourceToTarget = new Map<string, StoredTargetMessageMapping>();
  // activeBlocks 消息：源消息ID -> 最近一次已发送内容（用于去重，避免重复编辑但内容相同导致刷屏）
  private activeLastSent = new Map<string, string>();
  private env = getEnv();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();
  private personaProfileCache = new Map<
    string,
    { username: string; avatarUrl?: string }
  >();
  private recentSourceMessagesByChannel = new Map<
    string,
    Array<Message | PartialMessage>
  >();
  private pendingSourceForwardStates = new Map<
    string,
    PendingSourceForwardState
  >();
  private rawGatewayMessages = new Map<string, RawGatewayMessageRecord>();

  constructor(
    client: Client,
    config: Config,
    senderBot: SenderBot,
    senderBotsBySource?: Map<string, SenderBot[]>,
    senderBotsByWebhook?: Map<string, SenderBot>
  ) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;
    this.senderBotsByWebhook = senderBotsByWebhook;

    // 初始化时记录 activeBlocks 配置
    const activeBlocksKeys = config.activeBlocks
      ? Object.keys(config.activeBlocks)
      : [];
    this.logger.info(
      `[INIT] Bot started. activeBlocks=${activeBlocksKeys.length}, webhooks=${
        Object.keys(config.channelWebhooks ?? {}).length
      }`
    );

    // 保留可选的通用日志过滤（仅按 filterPattern）
    try {
      const logCfg = this.config.logging || ({} as any);
      const pattern = logCfg.filterPattern;
      if (typeof (this.logger as any).setFilter === "function") {
        (this.logger as any).setFilter(pattern);
      }
    } catch {}

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
      this.logger.info(`client warn: ${String(info).slice(0, 200)}`);
    });

    (this.client as any).on?.("raw", (packet: any) => {
      try {
        if (packet?.t !== "MESSAGE_CREATE" || !packet?.d?.id) {
          return;
        }
        this.rememberRawGatewayMessage(packet.d);
      } catch {}
    });

    (this.client as any).on("messageCreate", async (message: Message) => {
      await this.processAndSend(message);
    });

    (this.client as any).on(
      "messageUpdate",
      async (
        oldMessage: Message | PartialMessage,
        newMessage: Message | PartialMessage
      ) => {
        try {
          const resolved = (
            newMessage.partial ? await newMessage.fetch() : newMessage
          ) as Message;
          if (!resolved?.channelId) return;

          const active = this.resolveActiveCategory(resolved.channelId);
          const genericSenders = this.getSendersForChannel(resolved.channelId);
          const hasGenericTargets = genericSenders.length > 0;
          if (!active && !hasGenericTargets) return;

          if (!active) {
            const hasMappedGenericTarget = genericSenders.some((sender) =>
              Boolean(this.findTargetMessage(resolved.id, sender))
            );
            if (!hasMappedGenericTarget) {
              return;
            }
            this.logger.info(
              `[GENERIC_UPDATE] messageUpdate handled channelId=${resolved.channelId} messageId=${resolved.id}`
            );
            await this.processAndSend(resolved, undefined, {
              preferExistingTargetEdit: true
            });
            return;
          }

          // 先调用 applyActiveOverrides 检查内容是否与上次相同
          // applyActiveOverrides 内部已经做了去重检查，如果内容相同会返回 null
          const renderOutput = await this.messageAction(resolved, undefined);
          const originalText = (renderOutput.content || "").trim();
          const activeOverride = await this.applyActiveOverrides(
            resolved,
            originalText
          );

          // 如果 activeOverride 是 null，说明内容相同（已被去重），静默返回
          if (!activeOverride) {
            return;
          }

          // 内容不同，简单记录一条
          this.logger.info(
            `[ACTIVE_BLOCKS] messageUpdate handled category=${active.key} channelId=${resolved.channelId} messageId=${resolved.id}`
          );
          await this.processAndSend(resolved);
        } catch (err) {
          this.logger.error(
            `[ACTIVE_BLOCKS] messageUpdate error: ${String(err)}`
          );
        }
      }
    );

    // 移除 specialChannels 专用的 messageUpdate 监听

    // 为了支持“回复可跳转”，改为单条即时发送（如需保留堆叠，可另加配置开关）
  }

  private getSenderForChannel(channelId: string): SenderBot | undefined {
    const arr = this.senderBotsBySource?.get(channelId);
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
  }

  private getSendersForChannel(channelId: string): SenderBot[] {
    const arr = this.senderBotsBySource?.get(channelId);
    return Array.isArray(arr) ? arr : [];
  }

  private getSenderForWebhook(webhookUrl: string): SenderBot | undefined {
    return this.senderBotsByWebhook?.get(webhookUrl);
  }

  private getWebhookReplyFallbackMode():
    | "real_reply_only"
    | "body_embed_only"
    | "legacy" {
    if (this.config.webhookReplyFallbackMode === "real_reply_only") {
      return "real_reply_only";
    }
    if (this.config.webhookReplyFallbackMode === "legacy") {
      return "legacy";
    }
    return "body_embed_only";
  }

  private useContentEmbedWebhookReplyFallbacks() {
    return this.getWebhookReplyFallbackMode() !== "real_reply_only";
  }

  private useLegacyWebhookReplyFallbacks() {
    return this.getWebhookReplyFallbackMode() === "legacy";
  }

  private getForwardSnapshot(
    message: Message | PartialMessage
  ): Message | PartialMessage | undefined {
    const snapshots = (message as any)?.messageSnapshots;
    if (!snapshots || typeof snapshots.values !== "function") {
      return undefined;
    }

    for (const snapshot of snapshots.values()) {
      if (snapshot) {
        return snapshot as Message | PartialMessage;
      }
    }

    return undefined;
  }

  private getRenderableTextContent(message?: Message | PartialMessage): string {
    return String((message as any)?.content || "").trim();
  }

  private getAttachmentCount(message?: Message | PartialMessage): number {
    const attachments = (message as any)?.attachments;
    return attachments && typeof attachments.size === "number"
      ? attachments.size
      : Array.isArray(attachments)
        ? attachments.length
        : 0;
  }

  private hasRenderableMessageBody(
    message?: Message | PartialMessage
  ): boolean {
    if (!message) {
      return false;
    }

    const content = this.getRenderableTextContent(message);
    const embeds = Array.isArray((message as any).embeds)
      ? (message as any).embeds.length
      : 0;
    const attachmentCount = this.getAttachmentCount(message);

    return content.length > 0 || embeds > 0 || attachmentCount > 0;
  }

  private mergeForwardWrapperWithSnapshot(
    message: Message | PartialMessage,
    snapshot: Message | PartialMessage
  ): Message | PartialMessage {
    const wrapperEmbeds = Array.isArray((message as any)?.embeds)
      ? (message as any).embeds
      : [];
    const snapshotEmbeds = Array.isArray((snapshot as any)?.embeds)
      ? (snapshot as any).embeds
      : [];
    const wrapperAttachments = (message as any)?.attachments;
    const snapshotAttachments = (snapshot as any)?.attachments;

    return {
      ...(message as any),
      ...(snapshot as any),
      content:
        this.getRenderableTextContent(snapshot) ||
        this.getRenderableTextContent(message),
      embeds: snapshotEmbeds.length > 0 ? snapshotEmbeds : wrapperEmbeds,
      attachments:
        this.getAttachmentCount(snapshot) > 0
          ? snapshotAttachments
          : wrapperAttachments,
      mentions: (snapshot as any)?.mentions || (message as any)?.mentions
    } as Message | PartialMessage;
  }

  private getRenderableSourceMessage(
    message: Message | PartialMessage
  ): Message | PartialMessage {
    const snapshot = this.getForwardSnapshot(message);
    const wrapperContent = this.getRenderableTextContent(message);
    const snapshotContent = this.getRenderableTextContent(snapshot);

    if (!wrapperContent && snapshotContent) {
      return snapshot
        ? this.mergeForwardWrapperWithSnapshot(message, snapshot)
        : message;
    }

    if (this.hasRenderableMessageBody(message)) {
      return message;
    }

    if (this.hasRenderableMessageBody(snapshot)) {
      return snapshot!;
    }

    return message;
  }

  private rememberRawGatewayMessage(rawMessage: any) {
    if (!rawMessage?.id) {
      return;
    }

    const record: RawGatewayMessageRecord = {};
    const messageReference = rawMessage.message_reference;
    if (messageReference?.message_id) {
      record.reference = {
        messageId: String(messageReference.message_id),
        channelId:
          messageReference.channel_id != null
            ? String(messageReference.channel_id)
            : undefined,
        guildId:
          messageReference.guild_id != null
            ? String(messageReference.guild_id)
            : undefined
      };
    }

    const referencedMessage = rawMessage.referenced_message;
    if (referencedMessage?.id) {
      record.referencedMessage = {
        id: String(referencedMessage.id),
        channelId:
          referencedMessage.channel_id != null
            ? String(referencedMessage.channel_id)
            : record.reference?.channelId,
        guildId:
          referencedMessage.guild_id != null
            ? String(referencedMessage.guild_id)
            : record.reference?.guildId,
        content: String(referencedMessage.content || ""),
        embeds: Array.isArray(referencedMessage.embeds)
          ? referencedMessage.embeds
          : [],
        attachments: new Map(
          Array.isArray(referencedMessage.attachments)
            ? referencedMessage.attachments.map((attachment: any) => [
                String(attachment.id || attachment.url || Math.random()),
                {
                  url: attachment.url,
                  name: attachment.filename || attachment.name || "file",
                  contentType:
                    attachment.content_type || attachment.contentType || "",
                  size: attachment.size || 0
                }
              ])
            : []
        ),
        mentions: {
          users: new Map(),
          channels: new Map(),
          roles: new Map()
        },
        author: referencedMessage.author
          ? {
              id:
                referencedMessage.author.id != null
                  ? String(referencedMessage.author.id)
                  : undefined,
              username: referencedMessage.author.username || undefined,
              globalName:
                referencedMessage.author.global_name ||
                referencedMessage.author.globalName ||
                undefined,
              tag:
                referencedMessage.author.username &&
                referencedMessage.author.discriminator
                  ? `${referencedMessage.author.username}#${referencedMessage.author.discriminator}`
                  : referencedMessage.author.username || undefined
            }
          : undefined,
        createdTimestamp: referencedMessage.timestamp
          ? Date.parse(referencedMessage.timestamp)
          : undefined
      };
    }

    if (record.reference || record.referencedMessage) {
      this.rawGatewayMessages.set(String(rawMessage.id), record);
    }
  }

  private getReplyReference(
    message?: Message | PartialMessage | null
  ): { messageId: string; channelId?: string } | undefined {
    if (!message) {
      return undefined;
    }

    const candidates = [
      (message as any).reference,
      (message as any).messageReference,
      (message as any).message_reference
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const messageId =
        candidate.messageId ?? candidate.messageID ?? candidate.message_id;
      if (!messageId) {
        continue;
      }

      const channelId =
        candidate.channelId ?? candidate.channelID ?? candidate.channel_id;
      return {
        messageId: String(messageId),
        channelId: channelId != null ? String(channelId) : undefined
      };
    }

    const rawGatewayRecord = this.rawGatewayMessages.get(
      String((message as any).id || "")
    );
    if (rawGatewayRecord?.reference?.messageId) {
      return {
        messageId: rawGatewayRecord.reference.messageId,
        channelId: rawGatewayRecord.reference.channelId
      };
    }

    return undefined;
  }

  private async fetchReplyReferenceMessage(
    message: Message | PartialMessage
  ): Promise<Message | PartialMessage | null> {
    const replyReference = this.getReplyReference(message);
    if (!replyReference?.messageId) {
      return null;
    }

    const fetchReference = (message as any)?.fetchReference;
    if (typeof fetchReference === "function") {
      try {
        const ref = await fetchReference.call(message);
        if (ref) {
          return ref;
        }
      } catch {}
    }

    const rawGatewayRecord = this.rawGatewayMessages.get(
      String((message as any).id || "")
    );
    if (rawGatewayRecord?.referencedMessage) {
      const referencedMessage = rawGatewayRecord.referencedMessage;
      return {
        id: referencedMessage.id,
        channelId: referencedMessage.channelId,
        guildId: referencedMessage.guildId,
        content: referencedMessage.content,
        embeds: referencedMessage.embeds,
        attachments: referencedMessage.attachments,
        mentions: referencedMessage.mentions,
        author: referencedMessage.author,
        createdTimestamp: referencedMessage.createdTimestamp
      } as Message | PartialMessage;
    }

    const channelMessages = (message as any)?.channel?.messages;
    if (channelMessages && typeof channelMessages.fetch === "function") {
      try {
        const ref = await channelMessages.fetch(replyReference.messageId);
        if (ref) {
          return ref;
        }
      } catch {}
    }

    return null;
  }

  private escapeMassMentions(text: string): string {
    return text
      .replace(/@everyone/gi, "@\u200beveryone")
      .replace(/@here/gi, "@\u200bhere");
  }

  private normalizeReplyInferenceKey(text?: string | null): string {
    return String(text || "")
      .replace(ZERO_WIDTH_REGEX, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private beginSourceForwardTracking(sourceMessageId: string) {
    const existing = this.pendingSourceForwardStates.get(sourceMessageId);
    if (existing) {
      existing.refCount += 1;
      return () => {
        const current = this.pendingSourceForwardStates.get(sourceMessageId);
        if (!current) {
          return;
        }
        current.refCount -= 1;
        if (current.refCount <= 0) {
          current.resolve();
          this.pendingSourceForwardStates.delete(sourceMessageId);
        }
      };
    }

    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.pendingSourceForwardStates.set(sourceMessageId, {
      promise,
      resolve,
      refCount: 1
    });

    return () => {
      const current = this.pendingSourceForwardStates.get(sourceMessageId);
      if (!current) {
        return;
      }
      current.refCount -= 1;
      if (current.refCount <= 0) {
        current.resolve();
        this.pendingSourceForwardStates.delete(sourceMessageId);
      }
    };
  }

  private async waitForSourceForwardCompletion(
    sourceMessageId: string,
    timeoutMs = 5000
  ) {
    const state = this.pendingSourceForwardStates.get(sourceMessageId);
    if (!state) {
      return;
    }

    try {
      await Promise.race([
        state.promise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } catch {}
  }

  private rememberRecentSourceMessage(message: Message | PartialMessage) {
    const channelId = String((message as any)?.channelId || "");
    if (!channelId) {
      return;
    }

    const existing = this.recentSourceMessagesByChannel.get(channelId) || [];
    const deduped = existing.filter(
      (candidate) =>
        String((candidate as any)?.id || "") !==
        String((message as any)?.id || "")
    );
    deduped.unshift(message);
    this.recentSourceMessagesByChannel.set(channelId, deduped.slice(0, 300));
  }

  private isReplyInferenceCandidateMatch(
    message: Message,
    candidate: Message | PartialMessage,
    matchKey: string
  ) {
    const candidateId = String((candidate as any)?.id || "");
    if (!candidateId || candidateId === String(message.id)) {
      return false;
    }

    const candidateKey = this.normalizeReplyInferenceKey(
      (candidate as any)?.content || ""
    );
    if (!candidateKey || candidateKey !== matchKey) {
      return false;
    }

    const currentWebhookId = (message as any)?.webhookId
      ? String((message as any).webhookId)
      : "";
    const currentAuthorId = (message.author as any)?.id
      ? String((message.author as any).id)
      : "";
    const candidateWebhookId = (candidate as any)?.webhookId
      ? String((candidate as any).webhookId)
      : "";
    const candidateAuthorId = (candidate as any)?.author?.id
      ? String((candidate as any).author.id)
      : "";

    if (
      currentWebhookId &&
      candidateWebhookId &&
      candidateWebhookId !== currentWebhookId
    ) {
      return false;
    }

    if (
      currentAuthorId &&
      candidateAuthorId &&
      candidateAuthorId !== currentAuthorId
    ) {
      return false;
    }

    return true;
  }

  private pickReplyInferenceCandidate(
    message: Message,
    candidates: Array<Message | PartialMessage>,
    matchKey: string,
    options?: { preferEarliest?: boolean }
  ) {
    const orderedCandidates = options?.preferEarliest
      ? [...candidates].reverse()
      : candidates;
    let fallbackCandidate: Message | PartialMessage | undefined;

    for (const candidate of orderedCandidates) {
      if (!this.isReplyInferenceCandidateMatch(message, candidate, matchKey)) {
        continue;
      }

      const candidateId = String((candidate as any)?.id || "");
      if (
        this.findTargetMessage(candidateId) ||
        this.pendingSourceForwardStates.has(candidateId)
      ) {
        return candidate;
      }

      fallbackCandidate ??= candidate;
    }

    return fallbackCandidate;
  }

  private async findPreviousSourceMessageByContent(
    message: Message,
    rawContent: string,
    options?: { preferEarliest?: boolean }
  ): Promise<Message | PartialMessage | undefined> {
    const matchKey = this.normalizeReplyInferenceKey(rawContent);
    if (!matchKey) {
      return undefined;
    }

    const recentCandidates =
      this.recentSourceMessagesByChannel.get(String(message.channelId)) || [];
    const recentMatch = this.pickReplyInferenceCandidate(
      message,
      recentCandidates,
      matchKey,
      options
    );
    const recentMatchId = recentMatch
      ? String((recentMatch as any)?.id || "")
      : "";
    if (
      recentMatch &&
      recentMatchId &&
      (this.findTargetMessage(recentMatchId) ||
        this.pendingSourceForwardStates.has(recentMatchId))
    ) {
      return recentMatch;
    }

    const fetchMessages = (message.channel as any)?.messages?.fetch;
    if (typeof fetchMessages !== "function") {
      return undefined;
    }

    try {
      const collection = await fetchMessages.call(
        (message.channel as any).messages,
        {
          limit: 300,
          before: message.id
        }
      );
      const candidates =
        typeof collection?.values === "function"
          ? Array.from(collection.values())
          : Array.isArray(collection)
            ? collection
            : [];
      return (
        this.pickReplyInferenceCandidate(
          message,
          candidates,
          matchKey,
          options
        ) || recentMatch
      );
    } catch (err) {
      this.logger.debug(
        `按正文回查上一条源消息失败 source=${message.id} error=${String(err)}`
      );
    }

    return undefined;
  }

  private sanitizeOutgoingValue<T>(value: T): T {
    if (typeof value === "string") {
      return this.escapeMassMentions(value) as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeOutgoingValue(item)) as T;
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entryValue]) => [key, this.sanitizeOutgoingValue(entryValue)]
      )
    ) as T;
  }

  private async extractEmbedReplyBody(
    message: Message | PartialMessage,
    embeds: readonly any[] = []
  ): Promise<string> {
    const blocks: string[] = [];
    const users =
      typeof (message as any)?.mentions?.users?.values === "function"
        ? (message as any).mentions.users.values()
        : [];
    const channels =
      typeof (message as any)?.mentions?.channels?.values === "function"
        ? (message as any).mentions.channels.values()
        : [];
    const roles =
      typeof (message as any)?.mentions?.roles?.values === "function"
        ? (message as any).mentions.roles.values()
        : [];
    const renderText = async (text?: string | null) => {
      if (!text) {
        return "";
      }

      return (
        await this.renderMentions(String(text), users, channels, roles)
      ).trim();
    };

    for (const embed of embeds) {
      const lines: string[] = [];
      const description = await renderText(embed?.description);
      if (description) {
        lines.push(description);
      }

      if (Array.isArray(embed?.fields)) {
        for (const field of embed.fields) {
          const name = await renderText(field?.name);
          const value = await renderText(field?.value);
          if (name && value) {
            lines.push(`${name}\n${value}`);
          } else if (name) {
            lines.push(name);
          } else if (value) {
            lines.push(value);
          }
        }
      }

      const footer = await renderText(embed?.footer?.text);
      if (footer) {
        lines.push(footer);
      }

      if (lines.length > 0) {
        blocks.push(lines.join("\n"));
      }
    }

    return blocks.join("\n\n").trim();
  }

  private async normalizeEmbedsForWebhook(
    message: Message | PartialMessage,
    embeds: readonly any[] = [],
    options?: {
      dropTitleWhenContentPresent?: boolean;
    }
  ): Promise<any[]> {
    const users =
      typeof (message as any)?.mentions?.users?.values === "function"
        ? (message as any).mentions.users.values()
        : [];
    const channels =
      typeof (message as any)?.mentions?.channels?.values === "function"
        ? (message as any).mentions.channels.values()
        : [];
    const roles =
      typeof (message as any)?.mentions?.roles?.values === "function"
        ? (message as any).mentions.roles.values()
        : [];
    const renderText = async (text?: string | null) => {
      if (!text) {
        return "";
      }

      return (
        await this.renderMentions(String(text), users, channels, roles)
      ).trim();
    };

    const normalized: any[] = [];
    for (const embed of embeds) {
      const next: any = {};
      const description = await renderText(embed?.description);
      const footerText = await renderText(embed?.footer?.text);
      const fields = Array.isArray(embed?.fields)
        ? (
            await Promise.all(
              embed.fields.map(async (field: any) => {
                const name = await renderText(field?.name);
                const value = await renderText(field?.value);
                if (!name && !value) {
                  return null;
                }
                return {
                  ...(name ? { name } : {}),
                  ...(value ? { value } : {}),
                  ...(typeof field?.inline === "boolean"
                    ? { inline: field.inline }
                    : {})
                };
              })
            )
          ).filter(Boolean)
        : [];

      const title = await renderText(embed?.title);
      const shouldDropTitle =
        options?.dropTitleWhenContentPresent &&
        Boolean(description || footerText || fields.length > 0);
      if (title && !shouldDropTitle) {
        next.title = title;
      }
      if (description) {
        next.description = description;
      }
      if (fields.length > 0) {
        next.fields = fields;
      }
      if (footerText || embed?.footer?.iconURL || embed?.footer?.icon_url) {
        next.footer = {
          ...(footerText ? { text: footerText } : {}),
          ...(embed?.footer?.iconURL || embed?.footer?.icon_url
            ? { icon_url: embed.footer.iconURL || embed.footer.icon_url }
            : {})
        };
      }
      if (
        embed?.author?.name ||
        embed?.author?.url ||
        embed?.author?.iconURL ||
        embed?.author?.icon_url
      ) {
        const authorName = await renderText(embed.author.name);
        next.author = {
          ...(authorName ? { name: authorName } : {}),
          ...(embed.author.url ? { url: String(embed.author.url) } : {}),
          ...(embed.author.iconURL || embed.author.icon_url
            ? { icon_url: embed.author.iconURL || embed.author.icon_url }
            : {})
        };
      }
      if (embed?.url) {
        next.url = String(embed.url);
      }
      if (typeof embed?.color === "number") {
        next.color = embed.color;
      }
      if (embed?.timestamp) {
        const ts = new Date(embed.timestamp);
        if (!Number.isNaN(ts.getTime())) {
          next.timestamp = ts.toISOString();
        }
      }
      const imageUrl = embed?.image?.url;
      if (imageUrl) {
        next.image = { url: String(imageUrl) };
      }
      const thumbnailUrl = embed?.thumbnail?.url;
      if (thumbnailUrl) {
        next.thumbnail = { url: String(thumbnailUrl) };
      }

      if (Object.keys(next).length > 0) {
        normalized.push(next);
      }
    }

    return normalized;
  }

  private buildReplyStyleEmbed(options: {
    quotedAuthorName?: string;
    quotedText: string;
    mainText: string;
    color?: number;
    timestamp?: string;
    replyJumpUrl?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
  }) {
    let quotedText = this.escapeMassMentions(options.quotedText || "");
    if (options.replyJumpUrl) {
      quotedText = `${quotedText}\n\n[查看被回复](${options.replyJumpUrl})`;
    }

    const quoted = quotedText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    let formattedTime: string | undefined;
    try {
      if (options.timestamp) {
        const dt = new Date(options.timestamp);
        const pad = (n: number) => String(n).padStart(2, "0");
        formattedTime = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
      }
    } catch {}

    const quotedWithTime = formattedTime
      ? `${quoted}\n> (${formattedTime})`
      : quoted;
    const headerLine = options.quotedAuthorName
      ? `回复@${options.quotedAuthorName}：\n`
      : "";
    const mainText = this.escapeMassMentions(options.mainText || "");

    const embed: any = {
      color: options.color || 0x5865f2,
      description:
        `${headerLine}${quotedWithTime}${quotedWithTime ? "\n" : ""}回复内容：\n${mainText}`.trim()
    };
    if (options.imageUrl) {
      embed.image = { url: options.imageUrl };
    }
    if (options.thumbnailUrl) {
      embed.thumbnail = { url: options.thumbnailUrl };
    }

    return embed;
  }

  private collectMessageUploads(
    message?: Message | PartialMessage
  ): ForwardUpload[] {
    const uploads: ForwardUpload[] = [];
    try {
      const attachments = (message as any)?.attachments;
      const values =
        attachments && typeof attachments.values === "function"
          ? Array.from(attachments.values())
          : Array.isArray(attachments)
            ? attachments
            : [];
      for (const att of values) {
        const url = String(att?.url || "");
        if (!url) {
          continue;
        }
        const filename = String(att?.name || att?.filename || "file");
        const ct = String(
          att?.contentType || att?.content_type || ""
        ).toLowerCase();
        const isImage =
          ct.startsWith("image/") ||
          /(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)$/i.test(url);
        const isVideo =
          ct.startsWith("video/") ||
          /(\.mp4|\.mov|\.webm|\.mkv|\.avi)$/i.test(url);
        uploads.push({ url, filename, isImage, isVideo });
      }
    } catch {}
    return uploads;
  }

  private getPreferredImageUrl(
    message?: Message | PartialMessage
  ): string | undefined {
    const attachmentImage = this.collectMessageUploads(message).find(
      (item) => item.isImage
    )?.url;
    if (attachmentImage) {
      return attachmentImage;
    }

    try {
      const embeds = Array.isArray((message as any)?.embeds)
        ? (message as any).embeds
        : [];
      for (const embed of embeds) {
        const imageUrl = embed?.image?.url || embed?.thumbnail?.url;
        if (imageUrl) {
          return String(imageUrl);
        }
      }
    } catch {}

    return undefined;
  }

  private getPreferredVideoUrl(
    message?: Message | PartialMessage
  ): string | undefined {
    const attachmentVideo = this.collectMessageUploads(message).find(
      (item) => item.isVideo
    )?.url;
    if (attachmentVideo) {
      return attachmentVideo;
    }

    try {
      const embeds = Array.isArray((message as any)?.embeds)
        ? (message as any).embeds
        : [];
      for (const embed of embeds) {
        const videoUrl = embed?.video?.url;
        if (videoUrl) {
          return String(videoUrl);
        }
      }
    } catch {}

    return undefined;
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
      const json = JSON.parse(buf) as Record<string, unknown>;
      const normalizedEntries = Object.entries(json)
        .map(([sourceMessageId, mapping]) => {
          const normalized = this.normalizeStoredTargetMapping(mapping);
          return normalized
            ? ([sourceMessageId, normalized] as const)
            : undefined;
        })
        .filter(
          (entry): entry is readonly [string, StoredTargetMessageMapping] =>
            Boolean(entry)
        );
      this.sourceToTarget = new Map(normalizedEntries);
    } catch {}
  }

  private async saveMapping() {
    try {
      await this.ensureDataDir();
      const obj = Object.fromEntries(this.sourceToTarget.entries());
      const tmp = this.mapFile + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(obj), "utf-8");
      await fs.rename(tmp, this.mapFile);
    } catch {}
  }

  private normalizeStoredTargetMapping(
    value: unknown
  ): StoredTargetMessageMapping | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const channelId = record.channelId != null ? String(record.channelId) : "";
    const messageId = record.messageId != null ? String(record.messageId) : "";
    if (!channelId || !messageId) {
      return undefined;
    }

    const normalized: StoredTargetMessageMapping = { channelId, messageId };
    const targets = record.targets;
    if (targets && typeof targets === "object") {
      const normalizedTargets = Object.fromEntries(
        Object.entries(targets as Record<string, unknown>)
          .map(([key, targetValue]) => {
            const target = this.normalizeStoredTargetMapping(targetValue);
            return target
              ? [
                  key,
                  { channelId: target.channelId, messageId: target.messageId }
                ]
              : undefined;
          })
          .filter((entry): entry is [string, TargetMessageMapping] =>
            Boolean(entry)
          )
      );
      if (Object.keys(normalizedTargets).length > 0) {
        normalized.targets = normalizedTargets;
      }
    }

    return normalized;
  }

  private getTargetScopeKeys(scope?: TargetScopeLike): string[] {
    if (!scope) {
      return [];
    }

    const keys = [
      scope.webhookUrl && scope.threadId
        ? `webhook:${scope.webhookUrl}:thread:${scope.threadId}`
        : undefined,
      scope.webhookUrl && scope.threadName
        ? `webhook:${scope.webhookUrl}:threadName:${scope.threadName}`
        : undefined,
      scope.webhookUrl ? `webhook:${scope.webhookUrl}` : undefined,
      scope.defaultChannelId ? `channel:${scope.defaultChannelId}` : undefined,
      scope.remark ? `remark:${scope.remark}` : undefined,
      scope.webhookGuildId ? `guild:${scope.webhookGuildId}` : undefined
    ].filter((value): value is string => Boolean(value));

    return [...new Set(keys)];
  }

  private getTargetScopeKey(scope?: TargetScopeLike): string | undefined {
    return this.getTargetScopeKeys(scope)[0];
  }

  private findTargetMessage(
    sourceMessageId: string,
    scope?: TargetScopeLike
  ): TargetMessageMapping | undefined {
    const stored = this.sourceToTarget.get(sourceMessageId);
    if (!stored) {
      return undefined;
    }

    for (const scopeKey of this.getTargetScopeKeys(scope)) {
      if (stored.targets?.[scopeKey]) {
        return stored.targets[scopeKey];
      }
    }

    return { channelId: stored.channelId, messageId: stored.messageId };
  }

  private findTargetMessageInExactScope(
    sourceMessageId: string,
    scope?: TargetScopeLike
  ): TargetMessageMapping | undefined {
    const stored = this.sourceToTarget.get(sourceMessageId);
    if (!stored) {
      return undefined;
    }

    for (const scopeKey of this.getTargetScopeKeys(scope)) {
      if (stored.targets?.[scopeKey]) {
        return stored.targets[scopeKey];
      }
    }

    return undefined;
  }

  private rememberTargetMessage(
    sourceMessageId: string,
    target: TargetMessageMapping,
    scope?: TargetScopeLike
  ) {
    const current = this.sourceToTarget.get(sourceMessageId);
    const scopeKey = this.getTargetScopeKey(scope);
    const next: StoredTargetMessageMapping = {
      channelId: target.channelId,
      messageId: target.messageId
    };

    const nextTargets = current?.targets ? { ...current.targets } : undefined;
    if (scopeKey) {
      const scopedTargets = nextTargets ?? {};
      scopedTargets[scopeKey] = {
        channelId: target.channelId,
        messageId: target.messageId
      };
      next.targets = scopedTargets;
    } else if (nextTargets && Object.keys(nextTargets).length > 0) {
      next.targets = nextTargets;
    }

    this.sourceToTarget.set(sourceMessageId, next);
  }

  private forgetTargetMessage(
    sourceMessageId: string,
    scope?: TargetScopeLike
  ) {
    const current = this.sourceToTarget.get(sourceMessageId);
    if (!current) {
      return;
    }

    const scopeKeys = this.getTargetScopeKeys(scope);
    if (scopeKeys.length === 0) {
      this.sourceToTarget.delete(sourceMessageId);
      return;
    }

    const nextTargets = current.targets ? { ...current.targets } : {};
    for (const scopeKey of scopeKeys) {
      delete nextTargets[scopeKey];
    }

    const remainingTargets = Object.entries(nextTargets);
    if (remainingTargets.length === 0) {
      this.sourceToTarget.delete(sourceMessageId);
      return;
    }

    const [firstTarget] = remainingTargets;
    this.sourceToTarget.set(sourceMessageId, {
      channelId: firstTarget[1].channelId,
      messageId: firstTarget[1].messageId,
      targets: Object.fromEntries(remainingTargets)
    });
  }

  private getSyntheticReplyWrapperSourceId(sourceMessageId: string) {
    return `synthetic-reply:${sourceMessageId}`;
  }

  private findSyntheticReplyTargetMessage(
    sourceMessageId: string,
    scope?: TargetScopeLike
  ): TargetMessageMapping | undefined {
    return this.findTargetMessageInExactScope(
      this.getSyntheticReplyWrapperSourceId(sourceMessageId),
      scope
    );
  }

  private rememberSyntheticReplyTargetMessage(
    sourceMessageId: string,
    target: TargetMessageMapping,
    scope?: TargetScopeLike
  ) {
    this.rememberTargetMessage(
      this.getSyntheticReplyWrapperSourceId(sourceMessageId),
      target,
      scope
    );
  }

  private async tryHandleSyntheticWebhookReplyForward(options: {
    message: Message;
    renderSource: Message | PartialMessage;
    senders: SenderBot[];
    username?: string;
    avatarUrl?: string;
    mainText: string;
    uploads: Array<{
      url: string;
      filename: string;
      isImage?: boolean;
      isVideo?: boolean;
    }>;
  }): Promise<boolean> {
    const {
      message,
      renderSource,
      senders,
      username,
      avatarUrl,
      mainText,
      uploads
    } = options;
    if (!this.useLegacyWebhookReplyFallbacks()) {
      return false;
    }
    if (this.getReplyReference(message)?.messageId) {
      return false;
    }
    if (!(message as any).webhookId) {
      return false;
    }
    if (!mainText.trim()) {
      return false;
    }
    if (
      !Array.isArray(renderSource.embeds) ||
      renderSource.embeds.length === 0
    ) {
      return false;
    }

    const quotedTextRaw = await this.extractEmbedReplyBody(
      renderSource,
      renderSource.embeds
    );
    if (!quotedTextRaw.trim()) {
      return false;
    }

    let replyTimestamp: string | undefined;
    const firstEmbedWithTimestamp = renderSource.embeds.find(
      (embed: any) => embed?.timestamp
    );
    if (firstEmbedWithTimestamp?.timestamp) {
      const dt = new Date(firstEmbedWithTimestamp.timestamp);
      if (!Number.isNaN(dt.getTime())) {
        replyTimestamp = dt.toISOString();
      }
    }
    const replyAuthorName =
      (message.author as any)?.globalName ||
      message.author.username ||
      message.author.tag ||
      username;

    for (const sender of senders) {
      try {
        const senderQuotedText = this.escapeMassMentions(
          this.rewriteDiscordSourceLinks(quotedTextRaw, [], sender).trim()
        );
        const senderMainText = this.escapeMassMentions(
          this.rewriteDiscordSourceLinks(mainText, [], sender).trim()
        );
        const syntheticSourceId = this.getSyntheticReplyWrapperSourceId(
          message.id
        );

        let syntheticTarget = this.findSyntheticReplyTargetMessage(
          message.id,
          sender
        );
        if (!syntheticTarget) {
          const parentResults = await sender.sendData([
            {
              content: senderQuotedText,
              sourceMessageId: syntheticSourceId,
              username,
              avatarUrl,
              useEmbed: false
            }
          ]);
          const parentResult =
            (parentResults &&
              parentResults.find((item) => item.targetMessageId)) ||
            (parentResults && parentResults[0]);
          if (!parentResult?.targetMessageId) {
            throw new Error(
              "synthetic parent send did not return targetMessageId"
            );
          }
          syntheticTarget = {
            channelId: String(parentResult.targetChannelId),
            messageId: String(parentResult.targetMessageId)
          };
          this.rememberSyntheticReplyTargetMessage(
            message.id,
            syntheticTarget,
            sender
          );
          await this.saveMapping();
        }

        const replyJumpUrl =
          syntheticTarget && (sender as any).webhookGuildId
            ? `https://discord.com/channels/${(sender as any).webhookGuildId}/${syntheticTarget.channelId}/${syntheticTarget.messageId}`
            : undefined;

        const replyEmbed = this.buildReplyStyleEmbed({
          quotedAuthorName: replyAuthorName,
          quotedText: senderQuotedText,
          mainText: senderMainText,
          color: 0x5865f2,
          timestamp: replyTimestamp,
          replyJumpUrl
        });

        const childResults = await sender.sendData([
          {
            content: "",
            sourceMessageId: message.id,
            replyToTarget: syntheticTarget,
            username,
            avatarUrl,
            useEmbed: true,
            extraEmbeds: [replyEmbed],
            uploads
          }
        ]);
        const childResult =
          (childResults && childResults.find((item) => item.targetMessageId)) ||
          (childResults && childResults[0]);
        if (!childResult?.targetMessageId) {
          throw new Error(
            "synthetic reply child send did not return targetMessageId"
          );
        }
        this.rememberTargetMessage(
          message.id,
          {
            channelId: String(childResult.targetChannelId),
            messageId: String(childResult.targetMessageId)
          },
          sender
        );
        await this.saveMapping();
        this.logger.info(
          `已按伪回复样式转发: source=${message.id} synthetic=${syntheticTarget.channelId}/${syntheticTarget.messageId} target=${childResult.targetChannelId}/${childResult.targetMessageId}`
        );
      } catch (sendErr) {
        this.logger.error(`发送伪回复样式消息失败: ${String(sendErr)}`);
      }
    }

    return true;
  }

  private async tryHandleMatchedSourceWebhookReplyForward(options: {
    message: Message;
    renderSource: Message | PartialMessage;
    senders: SenderBot[];
    username?: string;
    avatarUrl?: string;
    quotedDisplayText: string;
    replyLookupRawText: string;
    uploads: Array<{
      url: string;
      filename: string;
      isImage?: boolean;
      isVideo?: boolean;
    }>;
  }): Promise<boolean> {
    const {
      message,
      renderSource,
      senders,
      username,
      avatarUrl,
      quotedDisplayText,
      replyLookupRawText,
      uploads
    } = options;

    if (!this.useContentEmbedWebhookReplyFallbacks()) {
      return false;
    }

    if (this.getReplyReference(message)?.messageId) {
      return false;
    }
    if (!(message as any).webhookId) {
      return false;
    }
    if (!quotedDisplayText.trim()) {
      return false;
    }
    if (
      !Array.isArray(renderSource.embeds) ||
      renderSource.embeds.length === 0
    ) {
      return false;
    }

    const replyBodyRaw = await this.extractEmbedReplyBody(
      renderSource,
      renderSource.embeds
    );
    if (!replyBodyRaw.trim()) {
      return false;
    }

    const normalizedPrimaryLookupText =
      this.normalizeReplyInferenceKey(replyLookupRawText);
    const normalizedEmbedLookupText =
      this.normalizeReplyInferenceKey(replyBodyRaw);
    const replyMatchCandidates = [
      {
        lookupRawText: replyLookupRawText,
        quotedDisplayText,
        replyMainText: replyBodyRaw,
        matchedBy: "body"
      }
    ];
    if (
      normalizedEmbedLookupText &&
      normalizedEmbedLookupText !== normalizedPrimaryLookupText &&
      quotedDisplayText.trim()
    ) {
      replyMatchCandidates.push({
        lookupRawText: replyBodyRaw,
        quotedDisplayText: replyBodyRaw,
        replyMainText: quotedDisplayText,
        matchedBy: "embed"
      });
    }

    let matchedSourceMessage: Message | PartialMessage | undefined;
    let matchedSourceId = "";
    let matchedReplyCandidate = replyMatchCandidates[0];
    for (const candidate of replyMatchCandidates) {
      const candidateMatchedSourceMessage =
        await this.findPreviousSourceMessageByContent(
          message,
          candidate.lookupRawText,
          {
            preferEarliest: true
          }
        );
      const candidateMatchedSourceId = candidateMatchedSourceMessage
        ? String((candidateMatchedSourceMessage as any).id || "")
        : "";
      if (!candidateMatchedSourceId) {
        continue;
      }
      matchedSourceMessage = candidateMatchedSourceMessage;
      matchedSourceId = candidateMatchedSourceId;
      matchedReplyCandidate = candidate;
      break;
    }

    let scopedMatchedTargets = matchedSourceId
      ? senders.map((sender) => ({
          sender,
          target: this.findTargetMessage(matchedSourceId, sender)
        }))
      : [];
    if (matchedSourceId) {
      if (scopedMatchedTargets.some((entry) => !entry.target)) {
        this.logger.debug(
          `等待正文匹配源消息映射就绪 source=${matchedSourceId} current=${message.id}`
        );
        await this.waitForSourceForwardCompletion(matchedSourceId);
        scopedMatchedTargets = senders.map((sender) => ({
          sender,
          target: this.findTargetMessage(matchedSourceId, sender)
        }));
      }
      if (scopedMatchedTargets.some((entry) => !entry.target)) {
        return false;
      }
    } else {
      return false;
    }

    const currentAuthorName =
      (message.author as any)?.globalName ||
      message.author.username ||
      message.author.tag ||
      username;
    const currentTimestamp =
      message.createdTimestamp != null
        ? new Date(message.createdTimestamp).toISOString()
        : undefined;

    for (const sender of senders) {
      try {
        const senderQuotedText = this.escapeMassMentions(
          this.rewriteDiscordSourceLinks(
            matchedReplyCandidate.quotedDisplayText,
            [],
            sender
          ).trim()
        );
        const senderMainText = this.escapeMassMentions(
          this.rewriteDiscordSourceLinks(
            matchedReplyCandidate.replyMainText,
            [],
            sender
          ).trim()
        );

        const matchedTarget = scopedMatchedTargets.find(
          (entry) => entry.sender === sender
        )?.target;
        if (!matchedSourceMessage || !matchedTarget) {
          return false;
        }
        const quotedAuthorName =
          ((matchedSourceMessage as any).author?.globalName as
            | string
            | undefined) ||
          ((matchedSourceMessage as any).author?.username as
            | string
            | undefined) ||
          ((matchedSourceMessage as any).author?.tag as string | undefined) ||
          currentAuthorName;
        const timestamp =
          (matchedSourceMessage as any).createdTimestamp != null
            ? new Date(
                (matchedSourceMessage as any).createdTimestamp
              ).toISOString()
            : currentTimestamp;
        const replyJumpUrl = (sender as any).webhookGuildId
          ? `https://discord.com/channels/${(sender as any).webhookGuildId}/${matchedTarget.channelId}/${matchedTarget.messageId}`
          : undefined;

        const quotedImageUrl = this.getPreferredImageUrl(matchedSourceMessage);
        const replyEmbed = this.buildReplyStyleEmbed({
          quotedAuthorName,
          quotedText: senderQuotedText,
          mainText: senderMainText,
          color: 0x5865f2,
          timestamp,
          replyJumpUrl,
          ...(uploads.length > 0
            ? { thumbnailUrl: quotedImageUrl }
            : { imageUrl: quotedImageUrl })
        });

        const childResults = await sender.sendData([
          {
            content: "",
            sourceMessageId: message.id,
            username,
            avatarUrl,
            useEmbed: true,
            extraEmbeds: [replyEmbed],
            uploads
          }
        ]);
        const childResult =
          (childResults && childResults.find((item) => item.targetMessageId)) ||
          (childResults && childResults[0]);
        if (!childResult?.targetMessageId) {
          throw new Error(
            "matched-source reply child send did not return targetMessageId"
          );
        }

        this.rememberTargetMessage(
          message.id,
          {
            channelId: String(childResult.targetChannelId),
            messageId: String(childResult.targetMessageId)
          },
          sender
        );
        await this.saveMapping();
        this.logger.info(
          `已按正文/embed 匹配回复样式转发: source=${message.id} matchedSource=${matchedSourceId} matchedBy=${matchedReplyCandidate.matchedBy} target=${childResult.targetChannelId}/${childResult.targetMessageId}`
        );
      } catch (sendErr) {
        const targetLabel =
          (sender as any).remark ||
          (sender as any).defaultChannelId ||
          (sender as any).webhookUrl ||
          "unknown";
        this.logger.error(
          `发送正文/embed 回复样式消息失败: source=${message.id} matchedSource=${matchedSourceId || "none"} matchedBy=${matchedReplyCandidate.matchedBy} target=${targetLabel} error=${String(sendErr)}`
        );
      }
    }

    return true;
  }

  private findScopedSender(
    sourceChannelId: string,
    scope?: TargetScopeLike
  ): SenderBot | undefined {
    const senders = this.getSendersForChannel(sourceChannelId);
    if (senders.length === 0) {
      return undefined;
    }

    const scopeKeys = new Set(this.getTargetScopeKeys(scope));
    if (scopeKeys.size === 0) {
      return senders[0];
    }

    return (
      senders.find((sender) =>
        this.getTargetScopeKeys(sender).some((candidate) =>
          scopeKeys.has(candidate)
        )
      ) ?? senders[0]
    );
  }

  private async applyActiveOverrides(
    message: Message,
    originalText: string
  ): Promise<ActiveOverrideResult | null> {
    const activeMatch = this.resolveActiveCategory(message.channelId);
    if (!activeMatch) {
      return null;
    }

    // 很多 activeBlocks 消息（特别是 futures/spot）主要内容在 embed.description 里，
    // 如果 originalText 为空，则回退到 embed 文本作为翻译与 persona 匹配的输入。
    // 对于 alerts，需要确保 message.content 也被包含，因为 role mention 可能在 message.content 中
    let effectiveText = originalText;
    // 对于 alerts，合并 message.content 和 originalText，确保 role mention 能被匹配到
    if (activeMatch.key === "alerts" && message.content) {
      effectiveText = `${message.content}\n${originalText}`.trim();
    }
    if (!effectiveText?.trim()) {
      const embedParts: string[] = [];
      try {
        for (const embed of message.embeds) {
          if (embed.title) embedParts.push(String(embed.title));
          if (embed.description) embedParts.push(String(embed.description));
        }
      } catch {}
      effectiveText = embedParts.join("\n").trim();
    }

    if (!effectiveText?.trim()) {
      // 有效内容为空时直接跳过，不再详细记录
      return null;
    }

    const senderBot = this.getSenderForWebhook(
      activeMatch.config.targetWebhook
    );
    if (!senderBot) {
      return null;
    }

    const personas = this.resolvePersonasForBlock();
    const matchStrategy = activeMatch.config.matchStrategy ?? "auto";
    let personaMatches = this.matchActivePersonas(
      message,
      effectiveText,
      personas,
      matchStrategy
    );

    // 对于 alerts，如果没有匹配到 persona，返回 null（不要使用默认 persona）
    if (personaMatches.length === 0) {
      this.logger.info(
        `[ACTIVE_BLOCKS] no persona matched category=${activeMatch.key} channelId=${message.channelId} messageId=${message.id}`
      );
      // 对于 alerts，如果没有匹配到 persona，不发送消息
      if (activeMatch.key === "alerts") {
        return null;
      }
      // 对于其他类别，使用第一个 persona 作为 fallback
      if (personas.length > 0) {
        personaMatches = [{ config: personas[0] }];
        this.logger.info(
          `[ACTIVE_BLOCKS] using fallback persona=${personas[0].keyword || personas[0].userId} category=${activeMatch.key}`
        );
      }
    } else {
      this.logger.info(
        `[ACTIVE_BLOCKS] matched personas=${personaMatches.length} category=${activeMatch.key} channelId=${message.channelId}`
      );
    }
    const translated = await this.buildActiveContent(
      activeMatch.key,
      effectiveText,
      personaMatches,
      senderBot
    );
    if (!translated) {
      this.logger.info(
        `[ACTIVE_BLOCKS] buildActiveContent empty category=${activeMatch.key} channelId=${message.channelId} messageId=${message.id}`
      );
      return null;
    }

    // 在输出日志之前，先检查内容是否与上次相同
    const lastSent = this.activeLastSent.get(message.id);
    if (lastSent) {
      // 快速计算 finalText 用于去重检查（包括回复头部，但不包括翻译）
      let quickFinalText = translated.trim();

      // 如果有回复，添加回复头部
      const replyReference = this.getReplyReference(message);
      if (replyReference?.messageId) {
        let authorName: string | undefined;
        try {
          const ru: any = (message as any).mentions?.repliedUser;
          if (ru) {
            authorName = ru.globalName || ru.username || ru.tag;
          }
        } catch {}
        if (!authorName) {
          try {
            const ref = await this.fetchReplyReferenceMessage(message);
            authorName =
              (ref?.author as any)?.globalName ||
              ref?.author?.username ||
              ref?.author?.tag ||
              undefined;
          } catch {}
        }
        if (!authorName) authorName = "某条消息";
        const gid = message.guildId || "@me";
        const refChan = replyReference.channelId || message.channelId;
        const replyUrl = `https://discord.com/channels/${gid}/${refChan}/${replyReference.messageId}`;
        quickFinalText = `↳ @${authorName} • ${replyUrl}\n${quickFinalText}`;
      }

      // 检查是否与上次相同（允许部分匹配，因为 finalText 可能包含翻译）
      // 先过滤掉动态内容（如时间戳）再比较
      const normalizedLast = filterDynamicContent(lastSent.trim());
      const normalizedCurrent = filterDynamicContent(quickFinalText.trim());
      if (
        normalizedLast === normalizedCurrent ||
        normalizedLast.endsWith(normalizedCurrent) ||
        normalizedCurrent.endsWith(normalizedLast) ||
        (normalizedLast.includes(normalizedCurrent) &&
          normalizedCurrent.length > 50)
      ) {
        // 内容相同，静默返回，不输出任何日志
        return null;
      }
    }

    // 内容不同，输出一条简短日志并继续处理
    this.logger.info(
      `[ACTIVE_BLOCKS] detected category=${activeMatch.key} channelId=${message.channelId} messageId=${message.id}`
    );

    const matchedPersona = personaMatches[0]?.config;
    const personaProfile = await this.resolvePersonaProfile(
      matchedPersona?.userId,
      message
    );
    // persona 头像/名字查找日志简化为一条
    this.logger.info(
      `[ACTIVE_BLOCKS] persona resolved category=${activeMatch.key} userId=${matchedPersona?.userId || "none"} username=${personaProfile?.username || "none"} avatar=${personaProfile?.avatarUrl ? "yes" : "no"}`
    );
    const personaDisplay = this.getPersonaDisplay(personaMatches[0]);
    // alerts 不在开头添加频道链接（已在 translateStoppedLine 中添加到末尾）
    const finalContent =
      activeMatch.key === "alerts" || !personaDisplay
        ? translated.trim()
        : `${personaDisplay}\n${translated.trim()}`;

    const personaButton = this.buildPersonaChannelButton(
      personaMatches[0],
      senderBot,
      message
    );
    const overrideButtons = personaButton ? [personaButton] : undefined;
    const extraSenderBots = this.buildActiveThreadSenderBots(
      activeMatch.config,
      personaMatches
    );

    return {
      content: finalContent,
      senderBot,
      extraSenderBots,
      // 始终优先使用 userId 查到的用户名；若获取失败，则退回源作者名称
      username: personaProfile?.username,
      avatarUrl: personaProfile?.avatarUrl,
      useEmbed: true,
      components: overrideButtons
    };
  }

  private buildActiveThreadSenderBots(
    config: ActiveCategoryConfig,
    personaMatches: PersonaMatch[]
  ) {
    if (!config.threadWebhook) {
      return [];
    }

    const seen = new Set<string>();
    const senders: SenderBot[] = [];
    for (const match of personaMatches) {
      const threadName = String(
        match.config.keyword || match.config.userId || ""
      ).trim();
      if (!threadName || seen.has(threadName)) {
        continue;
      }
      seen.add(threadName);
      senders.push(
        new SenderBot({
          chatsToSend: [],
          replacementsDictionary: this.config.replacementsDictionary,
          webhookUrl: config.threadWebhook,
          remark: `activeBlocks thread: ${threadName}`,
          threadName
        })
      );
    }
    return senders;
  }

  private resolveActiveCategory(
    channelId: string
  ): { key: ActiveCategory; config: ActiveCategoryConfig } | undefined {
    const activeBlocks = this.config.activeBlocks;
    if (!activeBlocks || Object.keys(activeBlocks).length === 0) {
      return undefined;
    }

    const entries = Object.entries(activeBlocks) as Array<
      [ActiveCategory, ActiveCategoryConfig | undefined]
    >;
    for (const [key, config] of entries) {
      if (!config) continue;
      const ids = this.getBlockSourceIds(config);
      if (ids.length === 0) continue;
      if (ids.some((id) => matchesId(id, channelId))) {
        return { key, config };
      }
    }
    return undefined;
  }

  private getBlockSourceIds(config: ActiveCategoryConfig): ChannelId[] {
    if (config.sourceChannelIds && config.sourceChannelIds.length > 0) {
      return config.sourceChannelIds;
    }
    if (
      config.sourceChannelId !== undefined &&
      config.sourceChannelId !== null
    ) {
      return [config.sourceChannelId];
    }
    return [];
  }

  private resolvePersonasForBlock(): ActivePersonaConfig[] {
    const entries = Object.entries(this.config.activePersonas ?? {});
    return entries.map(([key, persona]) => ({
      ...persona,
      keyword: persona.keyword ?? key
    }));
  }

  private collectChannelMentions(message: Message, text: string): Set<string> {
    const ids = new Set<string>();
    const collect = (input?: string | null) => {
      if (!input) return;
      const regex = /<#(\d+)>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(input))) {
        ids.add(match[1]);
      }
    };

    collect(message.content);
    collect(text);

    try {
      for (const embed of message.embeds ?? []) {
        collect(embed.title);
        collect(embed.description);
        if (Array.isArray(embed.fields)) {
          for (const field of embed.fields) {
            collect(field?.name);
            collect(field?.value);
          }
        }
        collect(embed.footer?.text);
      }
    } catch {}

    return ids;
  }

  private matchActivePersonas(
    message: Message,
    originalText: string,
    personas: ActivePersonaConfig[],
    strategy: "keyword" | "role" | "auto" | "channel"
  ): PersonaMatch[] {
    const matches: PersonaMatch[] = [];
    const combinedRaw = `${message.content || ""}\n${originalText || ""}`;
    const combinedNormalized = this.normalizeMatchTarget(combinedRaw);
    const tokenCandidates = this.extractMatchTokens(combinedRaw);
    const referencedChannelIds = this.collectChannelMentions(
      message,
      combinedRaw
    );
    const checkKeyword =
      strategy === "keyword" || strategy === "auto" || strategy === "channel";
    const checkRole =
      strategy === "role" || strategy === "auto" || strategy === "channel";

    for (const persona of personas) {
      let matched = false;

      // 1. 优先根据 sourceChannelId 与消息/Embed 中出现的频道链接匹配
      if (persona.sourceChannelId) {
        const id = String(persona.sourceChannelId);
        if (referencedChannelIds.has(id)) {
          matched = true;
        }
      }

      // 2. 关键字匹配（除非显式关闭）
      if (!matched && checkKeyword && persona.keyword) {
        const kw = this.normalizeMatchTarget(persona.keyword);
        if (
          kw &&
          (combinedNormalized.includes(kw) ||
            tokenCandidates.some((token) => this.isFuzzyTokenMatch(token, kw)))
        ) {
          matched = true;
        }
      }

      // 3. 角色匹配
      if (!matched && checkRole && persona.identityRoleId) {
        const roleId = String(persona.identityRoleId);
        // 检查 message.content 和 originalText 中是否包含 <@&roleId>
        const hasRoleInContent = (message.content || "").includes(
          `<@&${roleId}>`
        );
        const hasRoleInText = (originalText || "").includes(`<@&${roleId}>`);
        matched =
          Boolean(message.mentions?.roles?.get(roleId)) ||
          Boolean((message as any).member?.roles?.cache?.has?.(roleId)) ||
          hasRoleInContent ||
          hasRoleInText;
      }

      // 4. userId 匹配（始终允许，作为最后兜底）
      if (!matched && persona.userId) {
        matched = matchesId(persona.userId, message.author?.id || "");
      }

      if (matched) {
        matches.push({ config: persona });
      }
    }

    return matches;
  }

  private extractMatchTokens(text: string) {
    return (text || "")
      .split(/[^A-Za-z0-9\p{L}|｜]+/u)
      .map((token) => this.normalizeMatchTarget(token))
      .filter(Boolean);
  }

  private normalizeMatchTarget(text: string) {
    return this.stripInvisible(text)
      .toLowerCase()
      .replace(/[\s|｜]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  private stripInvisible(text: string) {
    return (text || "").replace(ZERO_WIDTH_REGEX, "");
  }

  private async buildActiveContent(
    category: ActiveCategory,
    rawText: string,
    personaMatches: PersonaMatch[],
    targetScope?: TargetScopeLike
  ): Promise<string | null> {
    const normalizedRaw = this.insertHeadingBoundaries(rawText);
    const stripped = this.stripPersonaMarkers(normalizedRaw, personaMatches);
    if (!stripped.trim()) {
      return null;
    }

    // 所有类别都使用统一的格式化逻辑
    const body = await this.formatStructuredActiveBlock(
      stripped,
      personaMatches,
      targetScope
    );
    if (!body || !body.trim()) {
      return null;
    }
    return body;
  }

  private insertHeadingBoundaries(text: string) {
    const keys = [
      ...Object.keys(ACTIVE_HEADLINE_MAP),
      ...Object.keys(STANDALONE_LINE_MAP)
    ].sort((a, b) => b.length - a.length);
    let normalized = text;
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "gi");
      normalized = normalized.replace(regex, (match) => `\n${match}\n`);
    }
    return normalized;
  }

  private stripPersonaMarkers(raw: string, personaMatches: PersonaMatch[]) {
    const personaInfos = personaMatches.map((match) => ({
      match,
      keyword:
        this.normalizeMatchTarget(String(match.config.keyword || "")) ||
        undefined,
      jumpChannelId: match.config.jumpChannelId
        ? String(match.config.jumpChannelId)
        : undefined,
      sourceChannelId: match.config.sourceChannelId
        ? String(match.config.sourceChannelId)
        : undefined
    }));

    const lines = this.stripInvisible(raw).replace(/\r/g, "").split("\n");

    const result: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^PnL:/i.test(trimmed)) continue;
      const norm = this.normalizeMatchTarget(trimmed);

      // 若该行只是 persona 标记（昵称、源频道等），则丢弃，不再保留到正文中，
      // 只依赖顶部 personaDisplay(jumpChannel) 来展示人物频道。
      let isPersonaMarker = false;
      for (const info of personaInfos) {
        if (!info.keyword && !info.sourceChannelId) continue;

        let matchesKeyword = false;
        if (info.keyword) {
          matchesKeyword =
            norm.includes(info.keyword) ||
            this.levenshteinWithin(norm, info.keyword, 1) ||
            this.levenshteinWithin(info.keyword, norm, 1);
        }

        const sourceMention = info.sourceChannelId
          ? `<#${info.sourceChannelId}>`
          : undefined;
        const matchesSource = sourceMention
          ? trimmed.includes(sourceMention)
          : false;

        if (matchesKeyword || matchesSource) {
          isPersonaMarker = true;
          break;
        }
      }

      if (!isPersonaMarker) {
        result.push(trimmed);
      }
    }

    return result
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private async formatStructuredActiveBlock(
    raw: string,
    personaMatches: PersonaMatch[],
    targetScope?: TargetScopeLike
  ): Promise<string> {
    // 检查翻译是否启用
    const translationEnabled = this.env.TRANSLATION_ENABLED !== "false";

    // 先做内联替换（仅在翻译启用时）
    let preprocessed = raw;
    if (translationEnabled) {
      for (const [key, value] of Object.entries(INLINE_PHRASE_MAP)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "gi");
        preprocessed = preprocessed.replace(regex, value);
      }
    }

    const output: string[] = [];
    const lines = preprocessed.split("\n");
    let pendingLabel: string | undefined;
    let i = 0;

    // 主 persona 的频道显示（用于替换 “未知”）
    const mainPersona = personaMatches[0];
    const mainPersonaChannel = mainPersona?.config.jumpChannelId
      ? `<#${mainPersona.config.jumpChannelId}>`
      : "";

    while (i < lines.length) {
      let trimmed = this.stripInvisible(lines[i]).trim();

      // 跳过空行、仅由星号构成的无意义行、或纯 emoji 行（但保留必要的分隔）
      if (!trimmed || trimmed === "*" || trimmed === "**") {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        i++;
        continue;
      }

      // 跳过纯 emoji 行（不包含字母数字，只包含 emoji 和符号）
      // 匹配：只包含 emoji、符号、空格，没有字母数字
      if (
        /^[\s\p{Emoji}\p{Symbol}\p{Punctuation}]*$/u.test(trimmed) &&
        !/[a-zA-Z0-9]/.test(trimmed)
      ) {
        // 纯 emoji/符号行，跳过不处理
        i++;
        continue;
      }

      // 先尝试整行标题匹配（仅在翻译启用时）
      if (translationEnabled) {
        const heading = this.translateActiveHeading(trimmed);
        if (heading) {
          output.push(heading);
          pendingLabel = undefined;
          i++;
          continue;
        }

        // 尝试 standalone line 匹配
        const standalone = this.translateStandaloneLine(trimmed);
        if (standalone) {
          // "当前无可成交交易" 作为独立行显示，不合并到上一行
          // 如果 standalone 是括号内容，尝试合并到上一行（无空格）
          if (standalone.startsWith("(") && output.length > 0) {
            // 找到最后一个非空行
            let lastNonEmptyIdx = output.length - 1;
            while (lastNonEmptyIdx >= 0 && output[lastNonEmptyIdx] === "") {
              lastNonEmptyIdx--;
            }
            if (lastNonEmptyIdx >= 0) {
              const lastLine = output[lastNonEmptyIdx];
              if (!lastLine.includes(standalone)) {
                output[lastNonEmptyIdx] = `${lastLine}${standalone}`;
                pendingLabel = undefined;
                i++;
                continue;
              }
            }
          }
          // 独立行，直接添加
          output.push(standalone);
          pendingLabel = undefined;
          i++;
          continue;
        }
      }

      // 尝试 stopped line（仅在翻译启用时）
      if (translationEnabled) {
        const stopped = await this.translateStoppedLine(
          trimmed,
          personaMatches
        );
        if (stopped) {
          output.push(...stopped);
          pendingLabel = undefined;
          i++;
          continue;
        }
      }

      // 提取标签前缀（如 :Spot:）
      const labelInfo = this.extractLabelPrefix(trimmed);
      if (labelInfo) {
        // 调试日志：检查表情符号替换
        if (labelInfo.label.includes("<:") && labelInfo.label.includes(":")) {
          this.logger.info(
            `[EMOJI_REPLACE] 匹配到表情: 原始行="${trimmed.substring(0, 50)}" -> label="${labelInfo.label}" matchedLength=${labelInfo.matchedLength}`
          );
        }
        pendingLabel = labelInfo.label;
        trimmed = trimmed.slice(labelInfo.matchedLength).trim();
        if (!trimmed) {
          i++;
          continue;
        }
      }

      // 尝试翻译 Entry 行（仅在翻译启用时）
      if (translationEnabled) {
        const entryLine = this.translateEntryLine(trimmed, pendingLabel);
        if (entryLine) {
          pendingLabel = undefined;
          output.push(entryLine);
          i++;
          continue;
        }
      }

      // 如果有 pending label，合并输出（无空格）
      if (pendingLabel) {
        output.push(`${pendingLabel}${trimmed}`);
        pendingLabel = undefined;
        i++;
        continue;
      }

      // 如果当前行是括号内容（如 "(尚未成交)"），合并到上一行
      if (
        trimmed.startsWith("(") &&
        trimmed.endsWith(")") &&
        output.length > 0
      ) {
        let lastNonEmptyIdx = output.length - 1;
        while (lastNonEmptyIdx >= 0 && output[lastNonEmptyIdx] === "") {
          lastNonEmptyIdx--;
        }
        if (lastNonEmptyIdx >= 0) {
          output[lastNonEmptyIdx] = `${output[lastNonEmptyIdx]}${trimmed}`;
          i++;
          continue;
        }
      }

      // 其他情况：做行内替换，保持原行结构
      let processed = trimmed;
      // 将 "⁠未知" 替换为主 persona 频道（如果有），并删除 "@用户名" 以及 "#未知"
      if (mainPersonaChannel) {
        processed = processed.replace(/⁠未知/g, mainPersonaChannel);
      } else {
        processed = processed.replace(/⁠未知/g, "");
      }
      processed = processed.replace(/\bw\/\s*@\S+/gi, "");
      processed = processed.replace(/@未知身份组/gi, "");
      processed = processed.replace(/@[A-Za-z0-9_]+/g, "");
      processed = processed.replace(/⁠#未知/g, "");
      // 去掉整行包裹的 * 或 **（Markdown 粗体/斜体标记）
      processed = processed.replace(/^\*+(.+?)\*+$/g, "$1");
      // 行内短语替换
      for (const [key, value] of Object.entries(INLINE_PHRASE_MAP)) {
        const regex = new RegExp(
          key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "gi"
        );
        processed = processed.replace(regex, value);
      }
      // Entry/SL/TP 等术语替换（仅在翻译启用时）
      if (translationEnabled) {
        processed = processed.replace(/\bEntry:\s*/gi, "入场: ");
        processed = processed.replace(/\bSL:\s*/gi, "止损: ");
        processed = processed.replace(/\bTPs?:\s*/gi, "止盈: ");
        processed = processed.replace(/\bAVG:\s*/gi, "平均: ");
        processed = processed.replace(/\bBE\b/gi, "成本价");
      }
      processed = processed.replace(/\s*PnL:.*$/i, "");
      // 删除尾部多余的星号（例如末尾的 "**"）
      processed = processed.replace(/\s*\*+\s*$/g, "");
      // 删除行首多余的星号或横线（例如开头的 "**" 或 "-"）
      processed = processed.replace(/^\s*[\*-]+\s*/g, "");
      // 清理多余空格
      processed = processed.replace(/\s+/g, " ").trim();

      if (processed) {
        output.push(processed);
      }
      pendingLabel = undefined;
      i++;
    }

    // 清理多余空行（删除所有连续空行，只保留必要的分隔）
    // 但保留模块标题前的空行
    const cleaned: string[] = [];
    let lastWasEmpty = false;
    for (let j = 0; j < output.length; j++) {
      if (output[j] === "") {
        // 只在非空行之间保留一个空行作为分隔
        if (!lastWasEmpty && cleaned.length > 0) {
          cleaned.push("");
          lastWasEmpty = true;
        }
      } else {
        // 检查是否是模块标题（加粗的标题）
        const isModuleTitle =
          output[j].trim().startsWith("**") && output[j].trim().endsWith("**");
        // 如果是模块标题，且前一行不是空行，确保添加一个空行
        if (isModuleTitle && cleaned.length > 0 && !lastWasEmpty) {
          cleaned.push("");
          lastWasEmpty = true;
        }
        cleaned.push(output[j]);
        lastWasEmpty = false;
      }
    }

    // 细节优化：确保模块标题之间有换行
    // 同时清理无意义的星号和横线行
    const finalLines: string[] = [];
    for (let j = 0; j < cleaned.length; j++) {
      const line = cleaned[j];
      const trimmedLine = line.trim();

      // 跳过空行
      if (trimmedLine === "") {
        // 避免出现连续空行
        if (
          finalLines.length > 0 &&
          finalLines[finalLines.length - 1].trim() === ""
        ) {
          continue;
        }
        finalLines.push("");
        continue;
      }

      // 跳过无意义的行：只包含星号、横线、空格
      if (/^[\s\*-]*$/.test(trimmedLine)) {
        continue;
      }

      // 检查是否是模块标题（加粗的标题）
      const isModuleTitle =
        trimmedLine.startsWith("**") && trimmedLine.endsWith("**");

      // 如果当前行是模块标题，检查前一行，确保模块之间有换行
      if (isModuleTitle && finalLines.length > 0) {
        // 找到最后一个非空行
        let lastNonEmptyIdx = finalLines.length - 1;
        while (
          lastNonEmptyIdx >= 0 &&
          finalLines[lastNonEmptyIdx].trim() === ""
        ) {
          lastNonEmptyIdx--;
        }

        if (lastNonEmptyIdx >= 0) {
          const prevLine = finalLines[lastNonEmptyIdx].trim();
          // 如果前一个非空行不是模块标题，确保在模块标题前有一个空行
          if (prevLine !== "" && !prevLine.startsWith("**")) {
            // 检查最后一行是否是空行
            const lastLine = finalLines[finalLines.length - 1];
            // 如果最后一行不是空行，添加一个空行
            if (lastLine.trim() !== "") {
              this.logger.debug(
                `[FORMAT] Adding blank line before module title: "${trimmedLine}", prevLine: "${prevLine}"`
              );
              finalLines.push("");
            } else {
              this.logger.debug(
                `[FORMAT] Module title "${trimmedLine}" already has blank line after prevLine: "${prevLine}"`
              );
            }
            // 如果最后一行是空行，说明已经有分隔了，不需要再添加
          } else {
            this.logger.debug(
              `[FORMAT] Module title "${trimmedLine}", prevLine is module title or empty: "${prevLine}"`
            );
          }
        } else {
          this.logger.debug(
            `[FORMAT] Module title "${trimmedLine}", no previous non-empty line found`
          );
        }
      }

      finalLines.push(
        this.rewriteDiscordSourceLinks(trimmedLine, personaMatches, targetScope)
      );
    }

    return finalLines.join("\n").trim();
  }

  private rewriteDiscordSourceLinks(
    line: string,
    personaMatches: PersonaMatch[],
    targetScope?: TargetScopeLike
  ): string {
    if (!line.includes("https://discord.com/channels/")) {
      return line;
    }

    const primaryPersona = personaMatches[0]?.config;
    const personaBySourceChannel = new Map<string, ActivePersonaConfig>();

    for (const persona of Object.values(this.config.activePersonas ?? {})) {
      if (!persona?.sourceChannelId) continue;
      personaBySourceChannel.set(String(persona.sourceChannelId), persona);
    }

    for (const match of personaMatches) {
      if (!match.config.sourceChannelId) continue;
      personaBySourceChannel.set(
        String(match.config.sourceChannelId),
        match.config
      );
    }

    const resolveTargetUrl = (
      sourceGuildId: string,
      sourceChannelId: string,
      sourceMessageId: string
    ) => {
      const persona =
        personaBySourceChannel.get(sourceChannelId) ?? primaryPersona;
      const sender = this.findScopedSender(sourceChannelId, targetScope);
      const senderGuildId = (sender as any)?.webhookGuildId;
      const senderChannelId = (sender as any)?.defaultChannelId;
      const guildId =
        persona?.jumpGuildId ||
        primaryPersona?.jumpGuildId ||
        senderGuildId ||
        "@me";
      const mapped = this.findTargetMessage(sourceMessageId, targetScope);

      if (mapped) {
        return `https://discord.com/channels/${guildId}/${mapped.channelId}/${mapped.messageId}`;
      }

      if (
        personaBySourceChannel.has(sourceChannelId) &&
        persona?.jumpChannelId
      ) {
        return `https://discord.com/channels/${guildId}/${persona.jumpChannelId}`;
      }

      if (
        primaryPersona?.jumpChannelId &&
        primaryPersona.jumpGuildId &&
        String(primaryPersona.jumpGuildId) !== sourceGuildId
      ) {
        return `https://discord.com/channels/${primaryPersona.jumpGuildId}/${primaryPersona.jumpChannelId}`;
      }

      if (senderChannelId) {
        return `https://discord.com/channels/${senderGuildId || "@me"}/${senderChannelId}`;
      }

      return undefined;
    };

    let rewritten = line.replace(
      /\[([^\]]+)\]\(<https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)>\)/g,
      (full, label, sourceGuildId, sourceChannelId, sourceMessageId) => {
        const targetUrl = resolveTargetUrl(
          sourceGuildId,
          sourceChannelId,
          sourceMessageId
        );
        return targetUrl ? `[${label}](<${targetUrl}>)` : full;
      }
    );

    rewritten = rewritten.replace(
      /<?https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)>?/g,
      (full, sourceGuildId, sourceChannelId, sourceMessageId) => {
        const targetUrl = resolveTargetUrl(
          sourceGuildId,
          sourceChannelId,
          sourceMessageId
        );
        if (!targetUrl) return full;
        return full.startsWith("<") && full.endsWith(">")
          ? `<${targetUrl}>`
          : targetUrl;
      }
    );

    return rewritten;
  }

  private rewriteDiscordSourceLinksInValue<T>(
    value: T,
    personaMatches: PersonaMatch[],
    targetScope?: TargetScopeLike
  ): T {
    if (typeof value === "string") {
      return this.rewriteDiscordSourceLinks(
        value,
        personaMatches,
        targetScope
      ) as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this.rewriteDiscordSourceLinksInValue(item, personaMatches, targetScope)
      ) as T;
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const plainValue =
      typeof (value as any).toJSON === "function"
        ? (value as any).toJSON()
        : value;
    const rewrittenEntries = Object.entries(
      plainValue as Record<string, unknown>
    ).map(([key, entryValue]) => [
      key,
      this.rewriteDiscordSourceLinksInValue(
        entryValue,
        personaMatches,
        targetScope
      )
    ]);

    return Object.fromEntries(rewrittenEntries) as T;
  }

  private translateActiveHeading(line: string): string | null {
    const normalized = line.trim().toLowerCase();
    // 先尝试完整匹配
    if (ACTIVE_HEADLINE_MAP[normalized]) {
      // 标题加粗
      return `**${ACTIVE_HEADLINE_MAP[normalized]}**`;
    }
    // 尝试部分匹配：找到最长的匹配项
    const sortedKeys = Object.keys(ACTIVE_HEADLINE_MAP).sort(
      (a, b) => b.length - a.length
    );
    for (const key of sortedKeys) {
      if (normalized.startsWith(key)) {
        const translated = ACTIVE_HEADLINE_MAP[key];
        const remainder = line.trim().slice(key.length).trim();
        if (remainder) {
          // 标题加粗，剩余部分不加粗
          return `**${translated}**${remainder}`;
        }
        // 标题加粗
        return `**${translated}**`;
      }
    }
    return null;
  }

  private translateStandaloneLine(line: string): string | null {
    const normalized = line.trim().toLowerCase();
    return STANDALONE_LINE_MAP[normalized] ?? null;
  }

  private extractLabelPrefix(
    line: string
  ): { label: string; matchedLength: number } | null {
    // 使用 :Long:, :Short:, :Spot: 等格式
    // 强制将 :Long:, :Short:, :Spot: 转换为带 ID 的格式

    // 1) 直接匹配已有的自定义表情（复用已有 ID）
    const customEmojiMatch = line.match(/^\s*<:([A-Za-z0-9_]+):(\d+)>/);
    if (customEmojiMatch) {
      return {
        label: `<:${customEmojiMatch[1]}:${customEmojiMatch[2]}>`,
        matchedLength: customEmojiMatch[0].length
      };
    }

    // 2) 强制匹配 :Long:, :Short:, :Spot: 并转换为带 ID 的格式
    const emojiIdMap: Record<string, { name: string; id: string }> = {
      long: { name: "Long", id: "1446387197128212530" },
      short: { name: "Short", id: "1446471976024805376" },
      spot: { name: "Spot", id: "1446387108540317769" }
    };

    // 匹配 :Spot:, :Long:, :Short:（支持有无空格，支持大小写）
    for (const [key, info] of Object.entries(emojiIdMap)) {
      // 先匹配没有空格的情况：":Spot:ETH" 或 ":Spot:BTC"
      // 使用 (?=\S) 前瞻确保后面有非空白字符，但不消耗字符
      const noSpaceRegex = new RegExp(`^-?\\s*:${key}:(?=\\S)`, "i");
      const noSpaceMatch = line.match(noSpaceRegex);
      if (noSpaceMatch) {
        // 匹配到 ":Spot:"，matchedLength 是 ":Spot:" 的长度（不包括后面的字符）
        return {
          label: `<:${info.name}:${info.id}>`,
          matchedLength: noSpaceMatch[0].length
        };
      }

      // 再匹配有空格的情况：":Spot: " 或 "- :Spot: "
      // 使用 \s+ 确保匹配一个或多个空格
      const withSpaceRegex = new RegExp(`^-?\\s*:${key}:\\s+`, "i");
      const withSpaceMatch = line.match(withSpaceRegex);
      if (withSpaceMatch) {
        // 匹配到 ":Spot: "，matchedLength 是 ":Spot: " 的长度（包括空格）
        return {
          label: `<:${info.name}:${info.id}>`,
          matchedLength: withSpaceMatch[0].length
        };
      }
    }

    // 其他模式（如 :Long/Short:）
    const longShortMatch = line.match(/^-?\s*:long\/short:\s*/i);
    if (longShortMatch) {
      return { label: ":Long/Short:", matchedLength: longShortMatch[0].length };
    }

    // 3) 通用匹配：只匹配包含字母的标签（如 :Spot:），跳过纯 emoji 或符号
    const generic = line.match(/^(-?\s*):\s*([A-Za-z]+:)\s*/);
    if (generic && /[A-Za-z]/.test(generic[2])) {
      const matchedLength = generic[0].length;
      const hasDash = generic[1].trim().startsWith("-");
      const emojiText = generic[2]; // 例如 ":Spot:"
      const normalizedEmoji = emojiText.toLowerCase();

      // 检查是否是 :Long:, :Short:, :Spot:，如果是，强制转换为带 ID 的格式
      if (
        normalizedEmoji === ":long:" ||
        normalizedEmoji === ":short:" ||
        normalizedEmoji === ":spot:"
      ) {
        const emojiKey = normalizedEmoji.slice(1, -1); // 去掉首尾冒号
        const emojiInfo = emojiIdMap[emojiKey];
        if (emojiInfo) {
          return {
            label: `<:${emojiInfo.name}:${emojiInfo.id}>`,
            matchedLength
          };
        }
      }

      // 其他情况，保留原格式
      const prefix = `${hasDash ? "-" : ""}${emojiText}`.replace(/\s+/g, "");
      return { label: prefix, matchedLength };
    }

    return null;
  }

  private translateEntryLine(line: string, prefix?: string): string | null {
    const match = line.match(/^([A-Za-z0-9/ ]+?)\s+Entry:\s*(.+)$/i);
    if (!match) return null;

    const symbol = match[1].trim();
    let remainder = match[2].trim();

    const avgMatch = remainder.match(/\(AVG:\s*([^)]+)\)/i);
    const average = avgMatch ? avgMatch[1].trim() : undefined;
    if (avgMatch) {
      remainder = remainder.replace(avgMatch[0], "").trim();
    }

    const slMatch = remainder.match(/SL:\s*([^T]+?)(?=\s+(?:TPs?:|PnL:|$))/i);
    const stop = slMatch ? slMatch[1].trim() : undefined;
    if (slMatch) {
      remainder = remainder.replace(slMatch[0], "").trim();
    }

    const tpMatch = remainder.match(/TPs?:\s*([^P]+?)(?=\s+PnL:|$)/i);
    const takeProfit = tpMatch ? tpMatch[1].trim() : undefined;
    if (tpMatch) {
      remainder = remainder.replace(tpMatch[0], "").trim();
    }

    remainder = remainder.replace(/\s*PnL:.*$/i, "").trim();
    if (!remainder) return null;

    let result = `${prefix ? `${prefix}` : ""}${symbol} 入场: ${remainder}`;
    if (average) result += ` (平均: ${average})`;
    if (stop) result += ` 止损: ${this.translateStopLoss(stop)}`;
    if (takeProfit) result += ` 止盈: ${takeProfit}`;

    return result;
  }

  private translateStopLoss(value: string) {
    const trimmed = value.trim();
    if (/^B\/?E$/i.test(trimmed) || /^BE$/i.test(trimmed)) return "成本价";
    return trimmed;
  }

  private async translateStoppedLine(
    line: string,
    personaMatches: PersonaMatch[]
  ): Promise<string[] | null> {
    // 匹配 alerts 消息格式：
    // 1. <:Type:数字> **SYMBOL** https://...: ACTION <@&roleId>
    // 2. :Type: **SYMBOL** https://...: ACTION <@&roleId>
    // 3. :Type~数字: SYMBOL: ACTION @用户
    let match: RegExpMatchArray | null = null;
    let rawPrefix = "";
    let typeLabel = "";
    let symbol = "";
    let action = "";

    // 尝试匹配格式 1 和 2（带 Discord 链接）
    const alertPattern1 =
      /^(<:(\w+):\d+>|:(\w+):)\s*\*\*([^*]+)\*\*\s*https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+:?\s*(.+?)(?:\s*<@&\d+>)?\s*$/i;
    match = line.match(alertPattern1);

    if (!match) {
      // 尝试更宽松的匹配，允许 action 后面有其他内容
      match = line.match(
        /^(<:(\w+):\d+>|:(\w+):)\s*\*\*([^*]+)\*\*\s*https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+:?\s*(.+?)(?:\s*<@&\d+>)?/i
      );
    }

    if (match) {
      rawPrefix = match[1] || "";
      typeLabel = match[2] || match[3] || "";
      symbol = match[4]?.trim() || "";
      action = match[5]?.trim() || "";
    } else {
      // 尝试匹配格式 3：:Type~数字: SYMBOL: ACTION @用户
      const alertPattern2 =
        /^(:(\w+)~\d+:)\s*([^:]+?):\s*(.+?)(?:\s*@\w+)?\s*$/i;
      match = line.match(alertPattern2);
      if (match) {
        rawPrefix = match[1] || "";
        typeLabel = match[2] || "";
        symbol = match[3]?.trim() || "";
        action = match[4]?.trim() || "";
      }
    }

    if (!match || !typeLabel || !symbol || !action) {
      // 对于 alerts 类别，匹配不上时直接返回，不再记录详细日志避免刷屏
      return null;
    }

    // 清理 action：去掉 @用户 和 <@&roleId> 等 mention
    action = action
      .replace(/\s*@\w+\s*/g, "")
      .replace(/\s*<@&\d+>\s*/g, "")
      .trim();

    // 仅保留一条简短匹配日志
    this.logger.info(
      `activeBlocks: translateStoppedLine matched type=${typeLabel} symbol=${symbol}`
    );

    // 检查翻译是否启用
    const translationEnabled = this.env.TRANSLATION_ENABLED !== "false";
    if (!translationEnabled) {
      // 如果翻译未启用，返回原始格式
      const channelLinks = personaMatches
        .map((m) => `<#${m.config.jumpChannelId}>`)
        .join(" ");
      return [`${rawPrefix} ${symbol} 💬 : ${action} ${channelLinks}`];
    }

    // 翻译 action
    const normalizedAction = action.toLowerCase().trim();
    let translatedAction = ALERT_ACTION_MAP[normalizedAction];
    if (!translatedAction) {
      // 处理 "TP[数字] hit" 的情况（如 "TP1 hit", "TP2 hit", "TP3 hit"）
      // 使用更宽松的正则，允许 "hit" 前后有空格或其他字符
      const tpHitMatch = normalizedAction.match(/^tp(\d+).*hit/i);
      if (tpHitMatch) {
        const tpNumber = tpHitMatch[1];
        const tpNumberMap: Record<string, string> = {
          "1": "第一",
          "2": "第二",
          "3": "第三",
          "4": "第四",
          "5": "第五",
          "6": "第六",
          "7": "第七",
          "8": "第八",
          "9": "第九",
          "10": "第十"
        };
        const tpNumberText = tpNumberMap[tpNumber] || `第${tpNumber}`;
        translatedAction = `${tpNumberText}止盈已触发`;
      } else {
        // 处理单独的 "TP[数字]" 的情况（如 "TP1", "TP2", "TP3"），翻译为 "到达第X目标"
        const tpMatch = normalizedAction.match(/^tp(\d+)$/i);
        if (tpMatch) {
          const tpNumber = tpMatch[1];
          const tpNumberMap: Record<string, string> = {
            "1": "第一",
            "2": "第二",
            "3": "第三",
            "4": "第四",
            "5": "第五",
            "6": "第六",
            "7": "第七",
            "8": "第八",
            "9": "第九",
            "10": "第十"
          };
          const tpNumberText = tpNumberMap[tpNumber] || `第${tpNumber}`;
          translatedAction = `到达${tpNumberText}目标`;
        } else {
          // 处理 "Stops moved to [number]" 或 "Stops moved to BE" 的情况
          const stopsMovedMatch = normalizedAction.match(
            /^stops?\s+moved\s+to\s+(.+)$/i
          );
          if (stopsMovedMatch) {
            const target = stopsMovedMatch[1].trim();
            // 确保 "BE" 被正确翻译为 "保本价"（不区分大小写）
            if (target.toLowerCase() === "be") {
              translatedAction = "止损移至保本价";
            } else {
              translatedAction = `止损移至 ${target}`;
            }
          } else {
            // 尝试部分匹配
            for (const [key, value] of Object.entries(ALERT_ACTION_MAP)) {
              if (normalizedAction.includes(key)) {
                translatedAction = value;
                break;
              }
            }
            // 如果还是找不到，走一次 LLM fallback，避免少数新文案直接漏英文
            if (!translatedAction) {
              translatedAction = await this.translateActiveAlerts(action);
            }
          }
        }
      }
    }

    // 获取所有匹配的 persona 频道链接
    const personaChannelLinks = personaMatches
      .filter((p) => p.config.jumpChannelId)
      .map((p) => `<#${p.config.jumpChannelId}>`)
      .join(" ");

    // 构建最终格式：保留原始表情前缀，避免从 <:Short:id> 退化为 :Short:
    const emojiPrefix = rawPrefix || `:${typeLabel}:`;
    const result = `${emojiPrefix} ${symbol} 💬 : ${translatedAction}${personaChannelLinks ? ` ${personaChannelLinks}` : ""}`;

    return [result];
  }

  private async resolvePersonaProfile(userId?: ChannelId, message?: Message) {
    if (!userId && userId !== 0) {
      this.logger.info(
        `[ACTIVE_BLOCKS] resolvePersonaProfile invalid userId=${userId}`
      );
      return null;
    }
    const id = String(userId);

    // 检查缓存
    if (this.personaProfileCache.has(id)) {
      const cached = this.personaProfileCache.get(id)!;
      this.logger.info(
        `[ACTIVE_BLOCKS] persona cache hit userId=${id} username=${cached.username} avatar=${cached.avatarUrl ? "yes" : "no"}`
      );
      return cached;
    }

    this.logger.info(
      `[ACTIVE_BLOCKS] resolvePersonaProfile start userId=${id}`
    );

    try {
      let user: any = null;

      // 直接从 guild.members 中查找（禁止使用 users.fetch）
      if (message?.guild) {
        try {
          const guild: any = message.guild;
          const members: any = guild?.members;
          if (members) {
            // 先尝试从缓存获取
            let member = members.cache?.get?.(id);
            if (member) {
              this.logger.info(
                `[ACTIVE_BLOCKS] guild.members.cache hit userId=${id}`
              );
              user = member.user;
            } else if (typeof members.fetch === "function") {
              // 如果缓存没有，尝试 fetch
              try {
                member = await members.fetch(id);
                if (member) {
                  this.logger.info(
                    `[ACTIVE_BLOCKS] guild.members.fetch hit userId=${id}`
                  );
                  user = member.user;
                }
              } catch (memberErr) {
                this.logger.error(
                  `[ACTIVE_BLOCKS] guild.members.fetch failed userId=${id} error=${String(memberErr)}`
                );
              }
            }
          }
        } catch (guildErr) {
          this.logger.error(
            `[ACTIVE_BLOCKS] resolvePersonaProfile guild error userId=${id} error=${String(guildErr)}`
          );
        }
      } else {
        this.logger.info(
          `[ACTIVE_BLOCKS] no guild info, cannot resolve via guild.members userId=${id}`
        );
      }

      // 如果 guild.members 查找失败，尝试从 users.cache 获取（但不 fetch）
      if (!user) {
        const userManager: any = (this.client as any)?.users;
        user = userManager?.cache?.get?.(id);
        if (user) {
          this.logger.info(`[ACTIVE_BLOCKS] users.cache hit userId=${id}`);
        }
      }

      if (!user) {
        this.logger.error(
          `[ACTIVE_BLOCKS] resolvePersonaProfile failed userId=${id} (guild.members & users.cache)`
        );
        return null;
      }

      const username = user.globalName || user.username || user.tag;
      this.logger.info(
        `[ACTIVE_BLOCKS] user resolved userId=${id} username=${user.username || "none"} final=${username}`
      );

      let avatarUrl: string | undefined;
      if (typeof user.displayAvatarURL === "function") {
        avatarUrl = user.displayAvatarURL({ size: 128, format: "png" });
      } else if (typeof user.avatarURL === "function") {
        avatarUrl = user.avatarURL({ size: 128, format: "png" });
      }

      const profile = { username, avatarUrl };
      this.personaProfileCache.set(id, profile);
      this.logger.info(
        `[ACTIVE_BLOCKS] persona profile saved userId=${id} avatar=${avatarUrl ? "yes" : "no"}`
      );
      return profile;
    } catch (err) {
      this.logger.error(
        `[ACTIVE_BLOCKS] resolvePersonaProfile exception userId=${id} error=${String(err)}`
      );
      return null;
    }
  }

  private async translateActiveAlerts(text: string) {
    const prompt =
      "You convert trading alerts to concise Simplified Chinese. Keep tickers, numbers, emoji, and punctuation intact. Translate prose, replace 'Entry' with '入场', 'SL' with '止损', 'TP' with '止盈', and 'BE' with '成本价'. Remove any PnL fields. Do not add commentary.";
    const translated = await this.translateText(text, { systemPrompt: prompt });
    return (translated || text).trim();
  }

  private getPersonaDisplay(persona: PersonaMatch | undefined) {
    if (!persona?.config.jumpChannelId) return undefined;
    return `<#${persona.config.jumpChannelId}>`;
  }

  private buildPersonaChannelButton(
    persona: PersonaMatch | undefined,
    sender: SenderBot,
    message: Message
  ) {
    if (!persona?.config.jumpChannelId) return undefined;
    const label =
      persona.config.channelButtonLabel || persona.config.keyword || "查看频道";
    // 使用配置的jumpGuildId，如果没有则使用源消息的guildId
    const guildId = persona.config.jumpGuildId || message.guildId || "@me";
    const url = `https://discord.com/channels/${guildId}/${persona.config.jumpChannelId}`;
    return { type: 2, style: 5, label, url };
  }

  private isFuzzyTokenMatch(token: string, keyword: string) {
    if (!token || !keyword) return false;
    const t = token.toLowerCase();
    const k = keyword.toLowerCase();
    // 对于长度很短的关键词（如 "jd"、"db"），只允许完全匹配，避免与 "1D" 之类误匹配
    if (k.length <= 2) {
      return t === k;
    }
    if (t.includes(k)) return true;
    return this.levenshteinWithin(t, k, 1);
  }

  private levenshteinWithin(a: string, b: string, limit: number) {
    if (Math.abs(a.length - b.length) > limit) return false;
    const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0];
      dp[0] = i;
      let minRow = dp[0];
      for (let j = 1; j <= b.length; j++) {
        const temp = dp[j];
        if (a[i - 1] === b[j - 1]) {
          dp[j] = prev;
        } else {
          dp[j] = Math.min(prev, dp[j - 1], dp[j]) + 1;
        }
        prev = temp;
        if (dp[j] < minRow) minRow = dp[j];
      }
      if (minRow > limit) return false;
    }
    return dp[b.length] <= limit;
  }

  private async tryEditExistingForwardedMessages(
    sourceMessage: Message,
    preparedMessages: Array<{ sender: SenderBot; item: any }>
  ): Promise<boolean> {
    let attemptedEdits = 0;

    for (const prepared of preparedMessages) {
      const existingTarget = this.findTargetMessage(
        sourceMessage.id,
        prepared.sender
      );
      if (!existingTarget) {
        continue;
      }

      const body = prepared.sender.buildWebhookBody(prepared.item, {
        includeReplyReference: false
      });
      if (!body) {
        continue;
      }

      attemptedEdits += 1;
      try {
        await prepared.sender.editWebhookMessage(
          existingTarget.messageId,
          body
        );
      } catch (editErr) {
        this.logger.error(
          `[GENERIC_UPDATE] 编辑已转发消息失败，回退为新发 source=${sourceMessage.id} target=${existingTarget.channelId}/${existingTarget.messageId} error=${String(editErr)}`
        );
        return false;
      }
    }

    if (attemptedEdits === 0) {
      return false;
    }

    this.logger.info(
      `[GENERIC_UPDATE] ✏️ 已编辑转发消息 source=${sourceMessage.id} targets=${attemptedEdits}`
    );
    return true;
  }

  private async processAndSend(
    message: Message,
    tag?: string,
    options?: { preferExistingTargetEdit?: boolean }
  ) {
    const finishSourceForward = this.beginSourceForwardTracking(
      String(message.id)
    );
    try {
      this.rememberRecentSourceMessage(message);
      // 懒加载历史映射（进程首次消息时）
      if (this.sourceToTarget.size === 0) {
        await this.loadMapping();
      }

      const renderSource = this.getRenderableSourceMessage(message);

      // 渲染 mentions 后得到用户可见文本
      const renderOutput = await this.messageAction(message, tag);
      const originalText = (renderOutput.content || "").trim();

      const activeOverride = await this.applyActiveOverrides(
        message,
        originalText
      );

      // 对于 activeBlocks 消息，提前检查去重（在输出日志之前）
      if (activeOverride) {
        // 快速计算 finalText 用于去重检查（包括回复头部，但不包括翻译）
        let quickFinalText = activeOverride.content ?? originalText;

        // 如果有回复，添加回复头部（简化版本，用于去重检查）
        const replyReference = this.getReplyReference(message);
        if (replyReference?.messageId) {
          let authorName: string | undefined;
          try {
            const ru: any = (message as any).mentions?.repliedUser;
            if (ru) {
              authorName = ru.globalName || ru.username || ru.tag;
            }
          } catch {}
          if (!authorName) {
            try {
              const ref = await this.fetchReplyReferenceMessage(message);
              authorName =
                (ref?.author as any)?.globalName ||
                ref?.author?.username ||
                ref?.author?.tag ||
                undefined;
            } catch {}
          }
          if (!authorName) authorName = "某条消息";
          const gid = message.guildId || "@me";
          const refChan = replyReference.channelId || message.channelId;
          const replyUrl = `https://discord.com/channels/${gid}/${refChan}/${replyReference.messageId}`;
          quickFinalText = `↳ @${authorName} • ${replyUrl}\n${quickFinalText}`;
        }

        // 检查是否与上次相同（允许部分匹配，因为 finalText 可能包含翻译）
        const last = this.activeLastSent.get(message.id);
        if (last) {
          // 如果上次的内容包含当前内容，或者当前内容包含上次内容，认为是重复
          // 先过滤掉动态内容（如时间戳）再比较
          const normalizedLast = filterDynamicContent(last.trim());
          const normalizedCurrent = filterDynamicContent(quickFinalText.trim());
          if (
            normalizedLast === normalizedCurrent ||
            normalizedLast.endsWith(normalizedCurrent) ||
            normalizedCurrent.endsWith(normalizedLast) ||
            (normalizedLast.includes(normalizedCurrent) &&
              normalizedCurrent.length > 50)
          ) {
            // 内容相同，静默跳过，不输出任何日志
            return;
          }
        }
      }

      if (activeOverride) {
        this.logger.info(
          `[ACTIVE_BLOCKS] processAndSend override=yes category=${this.resolveActiveCategory(message.channelId)?.key || "unknown"} messageId=${message.id}`
        );
      }

      const senders = activeOverride?.senderBot
        ? [activeOverride.senderBot, ...(activeOverride.extraSenderBots ?? [])]
        : this.getSendersForChannel(message.channelId);
      if (!senders || senders.length === 0) {
        this.logger.debug(`跳过：未映射的源频道 channel=${message.channelId}`);
        return;
      }
      const baseActionButtons: any[] = [...(activeOverride?.components ?? [])];

      // sender 级配置优先，其次是 activeOverride，最后才回退到源作者
      const firstSenderForThis =
        senders && senders.length > 0 ? senders[0] : undefined;
      const senderDisplayName = (firstSenderForThis as any)?.displayName;
      let username: string | undefined =
        senderDisplayName || activeOverride?.username;
      // Determine sender-based avatar preference: prefer sender.avatarUrl over persona/source avatar
      let avatarUrl: string | undefined = undefined;
      if (firstSenderForThis && (firstSenderForThis as any).avatarUrl) {
        avatarUrl = (firstSenderForThis as any).avatarUrl;
      } else if (activeOverride?.avatarUrl) {
        avatarUrl = activeOverride.avatarUrl;
      } else {
        avatarUrl = undefined;
      }

      if (activeOverride) {
        if (!username) {
          username =
            (message.author as any)?.globalName ||
            message.author.username ||
            message.author.tag;
        }

        // 如果既没有 activeOverride.avatarUrl 又没有 sender.avatarUrl，则回退到源作者头像
        if (!avatarUrl) {
          try {
            const anyAuthor = message.author as any;
            if (typeof anyAuthor.displayAvatarURL === "function") {
              avatarUrl = anyAuthor.displayAvatarURL({
                size: 128,
                format: "png"
              });
            } else if (typeof anyAuthor.avatarURL === "function") {
              avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
            }
          } catch {}
        }
      } else {
        // 非 activeBlocks 消息，优先 sender.displayName，否则使用源作者信息
        if (!username) {
          username =
            (message.author as any)?.globalName ||
            message.author.username ||
            message.author.tag;
        }
        try {
          const anyAuthor = message.author as any;
          if (!avatarUrl) {
            if (typeof anyAuthor.displayAvatarURL === "function") {
              avatarUrl = anyAuthor.displayAvatarURL({
                size: 128,
                format: "png"
              });
            } else if (typeof anyAuthor.avatarURL === "function") {
              avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
            }
          }
        } catch {}
      }

      // 收集当前消息的附件（图片/视频标记用于 embed 图像）
      const uploads: ForwardUpload[] = this.collectMessageUploads(renderSource);

      // 特判：单条 Twitter/X 或 Tenor/Giphy 链接，改为纯文本发送触发原生预览
      const rawContent = (renderSource.content || "").trim();
      const cleanedSingle = rawContent.replace(/[<>]/g, "");
      const isSingleUrl = /^(https?:\/\/\S+)$/.test(cleanedSingle);
      const isTwitterOnly =
        isSingleUrl &&
        /^(?:https?:\/\/)(?:x\.com|twitter\.com)\//i.test(cleanedSingle);
      const isGifPageOnly =
        isSingleUrl &&
        /^(?:https?:\/\/)(?:tenor\.com|giphy\.com)\//i.test(cleanedSingle);

      let useEmbed = activeOverride?.useEmbed ?? true;
      let finalText = activeOverride?.content ?? originalText;
      const skipDefaultTranslation = Boolean(activeOverride);
      if (isTwitterOnly || isGifPageOnly) {
        useEmbed = false;
        finalText = cleanedSingle;
        uploads.length = 0; // 不携带附件
      }
      // 处理回复消息：构建 reply-style 引用块（上方为被回复的原消息）
      const replyReference = this.getReplyReference(message);
      let replyContext: {
        quotedText: string;
        quotedAuthorName?: string;
        timestamp?: string;
        color?: number;
        quotedImageUrl?: string;
        quotedVideoUrl?: string;
        quotedVideoUploads?: ForwardUpload[];
      } | null = null;
      let repliedAuthorName: string | undefined;
      if (replyReference?.messageId) {
        if (process.env.LOG_LEVEL !== "error")
          console.log(
            `[DEBUG] Message ${message.id} is a reply to ${replyReference.messageId}`
          );
        try {
          const ref = await this.fetchReplyReferenceMessage(message);
          if (!ref) {
            throw new Error("reply reference fetch returned empty");
          }
          const authorName =
            (ref.author as any)?.globalName ||
            ref.author?.username ||
            ref.author?.tag ||
            "未知用户";
          repliedAuthorName = authorName;

          // 获取被回复消息的内容并渲染 mentions（用户和角色，保留频道mention以便后面替换为目标频道）
          let original = ref.content || "";
          try {
            for (const user of ref.mentions.users.values()) {
              const display =
                (user as any).displayName ||
                (user as any).username ||
                `@${user.id}`;
              original = original.replace(
                new RegExp(`<@!?${user.id}>`, "g"),
                `@${display}`
              );
            }
          } catch {}
          try {
            for (const role of ref.mentions.roles.values()) {
              const name = (role as any).name || `@role`;
              original = original.replace(
                new RegExp(`<@&${role.id}>`, "g"),
                `@${name}`
              );
            }
          } catch {}

          // 如果为空则尝试使用 embed 标题或描述
          if (!original.trim() && ref.embeds.length > 0) {
            const firstEmbed = ref.embeds[0];
            if (firstEmbed.title) {
              original = `[${firstEmbed.title}]`;
            } else if (firstEmbed.description) {
              original =
                firstEmbed.description.substring(0, 200) +
                (firstEmbed.description.length > 200 ? "..." : "");
            }
          }

          // 截断过长内容，保持展示简洁
          if (original.length > 500)
            original = original.substring(0, 500) + "...";

          const ts = ref.createdTimestamp
            ? new Date(ref.createdTimestamp).toISOString()
            : undefined;
          const quotedUploads = this.collectMessageUploads(ref);
          replyContext = {
            quotedText: original || "无内容",
            quotedAuthorName: authorName,
            timestamp: ts,
            color: 0x5865f2,
            quotedImageUrl: this.getPreferredImageUrl(ref),
            quotedVideoUrl: this.getPreferredVideoUrl(ref),
            quotedVideoUploads: quotedUploads.filter((item) => item.isVideo)
          };

          if (process.env.LOG_LEVEL !== "error")
            console.log(`[DEBUG] Created reply embed for ${authorName}`);
        } catch (err) {
          if (process.env.LOG_LEVEL !== "error")
            console.log(`[DEBUG] Failed to create reply embed:`, err);
          try {
            const ru: any = (message as any).mentions?.repliedUser;
            if (ru) {
              const authorName = ru.globalName || ru.username || ru.tag;
              repliedAuthorName = authorName;
              replyContext = {
                quotedText: "无法获取消息内容",
                quotedAuthorName: authorName,
                timestamp: new Date().toISOString(),
                color: 0x5865f2
              };
            }
          } catch {}
        }
      }

      // 翻译逻辑：仅在满足启用条件时追加译文（且不是单链接场景）
      try {
        const env = this.env;
        if (
          !skipDefaultTranslation &&
          !isTwitterOnly &&
          !isGifPageOnly &&
          env &&
          env.DEEPSEEK_API_KEY &&
          env.DEEPSEEK_API_URL &&
          env.TRANSLATION_ENABLED !== "false"
        ) {
          const raw = originalText;
          const hasLatin = /[A-Za-z]/.test(raw);
          const hasCJK = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(raw);
          const urlRe = /^(<?\bhttps?:\/\/\S+>?)$/i;
          const tokens = raw.split(/\s+/).filter(Boolean);
          const isAllUrls =
            tokens.length > 0 && tokens.every((t) => urlRe.test(t));
          const cleaned = raw.replace(/\p{Cf}/gu, "");
          const aliasFilter = cleaned.replace(/[^:\sA-Za-z0-9_~+.-]/gu, "");
          const isOnlyAliasEmotes = /^(?:\s*:[A-Za-z0-9_~+.-]+:\s*)+$/u.test(
            aliasFilter
          );
          const isOnlyCustomEmotes =
            /^(?:\s*<a?:[A-Za-z0-9_~+.-]+:\d+>\s*)+$/u.test(raw);
          const compact = raw.replace(/[\s\n\r\t]+/g, "");
          const emojiOnly =
            compact.length > 0 &&
            compact.replace(
              /[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu,
              ""
            ) === "";
          const shouldTranslate =
            hasLatin &&
            !hasCJK &&
            !isAllUrls &&
            !isOnlyAliasEmotes &&
            !isOnlyCustomEmotes &&
            !emojiOnly;
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
      } catch {}

      // 对于 spot、futures、alerts 消息，在转发前替换表情符号
      if (activeOverride) {
        const activeCategory = this.resolveActiveCategory(
          message.channelId
        )?.key;
        if (
          activeCategory === "spot" ||
          activeCategory === "futures" ||
          activeCategory === "alerts"
        ) {
          // 先替换已有的表情格式（如 <:Spot~3:1295345480204681216> 或 <:Spot:1295345480204681216>）
          // 匹配 <:Long:...>、<:Long~数字:...> 等格式，统一替换为固定 ID
          finalText = finalText.replace(
            /<:Long[^:]*:\d+>/gi,
            "<:Long:1446387197128212530>"
          );
          finalText = finalText.replace(
            /<:Short[^:]*:\d+>/gi,
            "<:Short:1446471976024805376>"
          );
          finalText = finalText.replace(
            /<:Spot[^:]*:\d+>/gi,
            "<:Spot:1446387108540317769>"
          );

          // 再替换文本格式 :Spot:、:Long:、:Short: 为带 ID 的格式
          // 使用负向前瞻确保不匹配已经在 <:...:数字> 格式中的部分
          // 匹配 :Long: 但后面不是数字和 >
          finalText = finalText.replace(
            /:Long:(?!\d+>)/gi,
            "<:Long:1446387197128212530>"
          );
          finalText = finalText.replace(
            /:Short:(?!\d+>)/gi,
            "<:Short:1446471976024805376>"
          );
          finalText = finalText.replace(
            /:Spot:(?!\d+>)/gi,
            "<:Spot:1446387108540317769>"
          );

          this.logger.info(
            `[EMOJI_REPLACE] 已替换表情符号 category=${activeCategory} messageId=${message.id}`
          );
          this.logger.info(
            `[EMOJI_REPLACE] 替换后的内容预览: ${finalText.substring(0, 200)}`
          );
        }
      }

      finalText = this.escapeMassMentions(finalText);

      // activeBlocks 消息去重：保存实际要发送的最终文本
      if (activeOverride) {
        this.activeLastSent.set(message.id, filterDynamicContent(finalText));
      }

      const buildActionRows = (buttons: any[]) => {
        const rows: any[] = [];
        for (let i = 0; i < buttons.length; i += 5) {
          rows.push({
            type: 1,
            components: buttons.slice(i, i + 5)
          });
        }
        return rows;
      };
      const buildSourceUrl = (channelId: string, messageId: string) => {
        const gid = message.guildId || "@me";
        return `https://discord.com/channels/${gid}/${channelId}/${messageId}`;
      };
      const replySourceUrl = replyReference?.messageId
        ? buildSourceUrl(
            replyReference.channelId || message.channelId,
            replyReference.messageId
          )
        : undefined;
      const baseFinalText = finalText;
      const baseExtraEmbeds = activeOverride
        ? undefined
        : await this.normalizeEmbedsForWebhook(
            renderSource,
            renderSource.embeds,
            {
              dropTitleWhenContentPresent:
                !replyReference?.messageId && Boolean(baseFinalText.trim())
            }
          );

      if (
        !activeOverride &&
        !options?.preferExistingTargetEdit &&
        (await this.tryHandleMatchedSourceWebhookReplyForward({
          message,
          renderSource,
          senders,
          username,
          avatarUrl,
          quotedDisplayText: originalText,
          replyLookupRawText: String(renderSource.content || ""),
          uploads
        }))
      ) {
        return;
      }

      if (
        !activeOverride &&
        !options?.preferExistingTargetEdit &&
        (await this.tryHandleSyntheticWebhookReplyForward({
          message,
          renderSource,
          senders,
          username,
          avatarUrl,
          mainText: baseFinalText,
          uploads
        }))
      ) {
        return;
      }

      const buildMessageForSender = async (sender: SenderBot) => {
        const actionButtons: any[] = [...baseActionButtons];
        const scopedReplyTarget = replyReference?.messageId
          ? this.findTargetMessage(replyReference.messageId, sender)
          : undefined;
        let replyJumpUrl = replySourceUrl;
        if (scopedReplyTarget && (sender as any).webhookGuildId) {
          replyJumpUrl = `https://discord.com/channels/${(sender as any).webhookGuildId}/${scopedReplyTarget.channelId}/${scopedReplyTarget.messageId}`;
          actionButtons.push({
            type: 2,
            style: 5,
            label: "查看被回复",
            url: replyJumpUrl
          });
        } else if (replySourceUrl) {
          actionButtons.push({
            type: 2,
            style: 5,
            label: "查看被回复(源)",
            url: replySourceUrl
          });
        }

        const scopedCurrentTarget = this.findTargetMessage(message.id, sender);
        let sourceButtonUrl = buildSourceUrl(message.channelId, message.id);
        let sourceButtonLabel = "查看源消息";
        if (scopedCurrentTarget) {
          const targetGuildId =
            (sender as any).webhookGuildId || message.guildId;
          sourceButtonUrl = `https://discord.com/channels/${targetGuildId || "@me"}/${scopedCurrentTarget.channelId}/${scopedCurrentTarget.messageId}`;
          sourceButtonLabel = "查看转发消息";
        }
        actionButtons.push({
          type: 2,
          style: 5,
          label: sourceButtonLabel,
          url: sourceButtonUrl
        });

        const components =
          actionButtons.length > 0 ? buildActionRows(actionButtons) : undefined;
        let senderFinalText = activeOverride
          ? baseFinalText
          : this.rewriteDiscordSourceLinks(baseFinalText, [], sender);
        const senderExtraEmbeds = activeOverride
          ? undefined
          : this.sanitizeOutgoingValue(
              this.rewriteDiscordSourceLinksInValue(baseExtraEmbeds, [], sender)
            );
        const mergedEmbeds: any[] = [];
        const shouldKeepPlainContentWithEmbeds =
          !replyContext &&
          !activeOverride &&
          Boolean(senderFinalText.trim()) &&
          Array.isArray(senderExtraEmbeds) &&
          senderExtraEmbeds.length > 0;

        if (replyContext) {
          let replyDesc = String(replyContext.quotedText || "");
          try {
            const refChannelId = replyReference?.channelId;
            if (scopedReplyTarget && refChannelId) {
              replyDesc = replyDesc.replace(
                new RegExp(`<#${refChannelId}>`, "g"),
                `<#${scopedReplyTarget.channelId}>`
              );
            }
          } catch {}

          mergedEmbeds.push(
            this.buildReplyStyleEmbed({
              quotedAuthorName: repliedAuthorName,
              quotedText: replyDesc,
              mainText: senderFinalText || "",
              color: replyContext.color,
              timestamp: replyContext.timestamp,
              replyJumpUrl,
              ...(uploads.length > 0
                ? { thumbnailUrl: replyContext.quotedImageUrl }
                : { imageUrl: replyContext.quotedImageUrl })
            })
          );
          senderFinalText = "";
        }

        if (
          !replyContext &&
          senderExtraEmbeds &&
          Array.isArray(senderExtraEmbeds)
        ) {
          mergedEmbeds.push(...senderExtraEmbeds);
        }

        const mergedUploads = replyContext?.quotedVideoUploads?.length
          ? [...replyContext.quotedVideoUploads, ...uploads]
          : uploads;

        return {
          content: senderFinalText,
          sourceMessageId: message.id,
          replyToSourceMessageId: replyReference?.messageId,
          replyToTarget: scopedReplyTarget,
          username,
          avatarUrl,
          useEmbed: shouldKeepPlainContentWithEmbeds ? false : useEmbed,
          extraEmbeds: mergedEmbeds.length > 0 ? mergedEmbeds : undefined,
          uploads: mergedUploads,
          ...(components ? { components } : {})
        };
      };

      const preparedMessages = await Promise.all(
        senders.map(async (sender) => ({
          sender,
          item: await buildMessageForSender(sender)
        }))
      );

      const primaryMessage = preparedMessages[0].item;
      const singleMessageLimit = primaryMessage.useEmbed ? 4096 : 2000;
      const existingTarget =
        activeOverride &&
        senders.length === 1 &&
        (primaryMessage.uploads?.length || 0) === 0 &&
        (primaryMessage.content || "").length <= singleMessageLimit
          ? this.findTargetMessage(message.id, senders[0])
          : undefined;

      if (existingTarget) {
        const editBody = senders[0].buildWebhookBody(primaryMessage, {
          includeReplyReference: false
        });
        if (editBody) {
          try {
            await senders[0].editWebhookMessage(
              existingTarget.messageId,
              editBody
            );
            const activeCategory = this.resolveActiveCategory(
              message.channelId
            )?.key;
            this.logger.info(
              `[ACTIVE_BLOCKS] ✏️ 已编辑转发消息 category=${activeCategory || "unknown"} source=${message.id} -> target=${existingTarget.channelId}/${existingTarget.messageId}`
            );
            return;
          } catch (editErr) {
            this.logger.error(
              `[ACTIVE_BLOCKS] 编辑已转发消息失败，回退为新发 category=${this.resolveActiveCategory(message.channelId)?.key || "unknown"} messageId=${message.id} error=${String(editErr)}`
            );
          }
        }
      }

      if (options?.preferExistingTargetEdit && !activeOverride) {
        const editedExisting = await this.tryEditExistingForwardedMessages(
          message,
          preparedMessages
        );
        if (editedExisting) {
          return;
        }
      }

      // 添加明确的日志显示要发送的内容
      if (replyReference?.messageId) {
        this.logger.info(
          `[REPLY] Sending reply message: sourceId=${message.id} replyTo=${replyReference.messageId}`
        );
        this.logger.info(
          `[REPLY] Content preview: ${(primaryMessage.content || "").substring(0, 150)}`
        );
        this.logger.info(
          `[REPLY] Has replyToTarget: ${!!primaryMessage.replyToTarget}, useEmbed: ${useEmbed}`
        );
      }

      try {
        const resultsBySender: Array<{
          sender: SenderBot;
          item: typeof primaryMessage;
          results: Array<any>;
        }> = [];
        for (const prepared of preparedMessages) {
          try {
            const results = await prepared.sender.sendData([prepared.item]);
            resultsBySender.push({
              sender: prepared.sender,
              item: prepared.item,
              results: results || []
            });
            if (results && results.length > 0) {
              const first = results[0];
              if (first.sourceMessageId) {
                this.rememberTargetMessage(
                  first.sourceMessageId,
                  {
                    channelId: String(first.targetChannelId),
                    messageId: String(first.targetMessageId)
                  },
                  prepared.sender
                );
                await this.saveMapping();
                const activeCategory = this.resolveActiveCategory(
                  message.channelId
                )?.key;
                if (activeOverride) {
                  this.logger.info(
                    `[ACTIVE_BLOCKS] ✅ 成功发送 activeBlocks 消息！category=${activeCategory || "unknown"} source=${first.sourceMessageId} -> target=${first.targetChannelId}/${first.targetMessageId}`
                  );
                }
                this.logger.info(
                  `已转发: source=${first.sourceMessageId} -> target=${first.targetChannelId}/${first.targetMessageId}`
                );
              }
            }
          } catch (sendErr) {
            this.logger.error(`发送到某个目标失败: ${String(sendErr)}`);
          }
        }

        // 构建每个目标的跳转按钮（每个目标一个），并在已发送的目标消息上进行编辑以加入这些按钮
        const targetInfos: Array<{
          sender: SenderBot;
          guildId?: string;
          channelId: string;
          messageId: string;
          label: string;
          baseComponents?: any[];
        }> = [];
        for (let i = 0; i < resultsBySender.length; i++) {
          const pair = resultsBySender[i];
          const res =
            (pair.results && pair.results.find((r) => r.targetMessageId)) ||
            (pair.results && pair.results[0]);
          if (res && res.targetMessageId) {
            const guildId =
              (pair.sender as any).webhookGuildId ||
              (senders[0] as any)?.webhookGuildId ||
              message.guildId;
            const label = (pair.sender as any).remark || `目标 ${i + 1}`;
            targetInfos.push({
              sender: pair.sender,
              guildId,
              channelId: String(res.targetChannelId),
              messageId: String(res.targetMessageId),
              label,
              baseComponents: pair.item.components
            });
          }
        }

        if (targetInfos.length > 0) {
          // 构建按钮并拆分为每行最多 5 个
          const buttons = targetInfos.map((t) => ({
            type: 2,
            style: 5,
            label: t.label.slice(0, 80),
            url: `https://discord.com/channels/${t.guildId || "@me"}/${t.channelId}/${t.messageId}`
          }));
          const rows: any[] = [];
          for (let i = 0; i < buttons.length; i += 5) {
            rows.push({ type: 1, components: buttons.slice(i, i + 5) });
          }

          // 将这些按钮添加到每个已发送的目标消息（编辑消息）
          for (const info of targetInfos) {
            try {
              // 仅编辑对应 sender 发送的消息
              const mergedRows = [
                ...(info.baseComponents || []),
                ...rows
              ].slice(0, 5);
              await info.sender.editWebhookMessage(info.messageId, {
                components: mergedRows
              });
            } catch (editErr) {
              this.logger.error(
                `编辑目标消息以添加按钮失败: ${String(editErr)}`
              );
            }
          }
        }
      } catch (e) {
        const activeCategory = this.resolveActiveCategory(
          message.channelId
        )?.key;
        if (activeOverride) {
          this.logger.error(
            `[ACTIVE_BLOCKS] ❌ activeBlocks 消息发送失败！category=${activeCategory || "unknown"} messageId=${message.id} error=${String(e)}`
          );
        }
        this.logger.error(`转发失败: ${String(e)}`);
      }
    } finally {
      finishSourceForward();
    }
  }

  // 在目标频道历史消息中尝试解析出某个 sourceId 的映射
  private async tryResolveMappingFromTarget(
    _sourceId: string,
    _senderForThis?: SenderBot
  ): Promise<{ channelId: string; messageId: string } | undefined> {
    // historyScan disabled: do not scan target channels to resolve mappings
    return undefined;
  }

  async messageAction(
    message: Message<boolean> | PartialMessage,
    tag?: string
  ) {
    const renderSource = this.getRenderableSourceMessage(message);
    let render = "";
    const allAttachments: string[] = [];

    // 用户可见内容：仅进行 mention 渲染，不包含调试信息
    render += await this.renderMentions(
      renderSource.content || "",
      renderSource.mentions.users.values(),
      renderSource.mentions.channels.values(),
      renderSource.mentions.roles.values()
    );

    // 构建详尽日志并写入文件
    try {
      let log = `messageAction id=${message.id} guild=${message.guildId || "DM"} channel=${message.channelId} author=${(message as any).author?.tag}`;
      if (tag) log += ` tag=${tag}`;
      if (this.getReplyReference(message)?.messageId) {
        try {
          const referenceMessage =
            await this.fetchReplyReferenceMessage(message);
          const mapped = referenceMessage
            ? this.findTargetMessage(referenceMessage.id)
            : undefined;
          const hasAssets =
            (referenceMessage?.attachments?.size ?? 0) > 0 ||
            (referenceMessage?.embeds?.length ?? 0) > 0;
          log += `\n  reference: author=${referenceMessage?.author?.tag} mapped=${!!mapped} assets=${hasAssets}`;
        } catch (e) {
          log += `\n  reference: fetch failed ${String(e)}`;
        }
      }
      for (const embed of renderSource.embeds) {
        log += `\n  Embed:`;
        if (embed.title) log += `\n    Title: ${embed.title}`;
        if (embed.description) log += `\n    Description: ${embed.description}`;
        if (embed.url) log += `\n    Url: ${embed.url}`;
        if (embed.thumbnail) log += `\n    Thumbnail: ${embed.thumbnail.url}`;
        if (embed.image) log += `\n    Image: ${embed.image.url}`;
        if (embed.video)
          log += `\n    Video: ${(embed as any).video?.url || "yes"}`;
        if (embed.author) log += `\n    Author: ${embed.author.name}`;
        if (embed.footer)
          log += `\n    Footer: ${(embed.footer as any)?.text || ""}`;
      }
      for (const attachment of renderSource.attachments.values()) {
        log += `\n  Attachment: name=${attachment.name} size=${formatSize(attachment.size)} url=${attachment.url}`;
      }
      await this.logger.debug(log);
    } catch {}

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
        this.logger.error(
          `renderMentions failed to fetch channel: ${String(e)}`
        );
      }
    }

    for (const role of roles) {
      text = text.replace(`<@&${role.id}>`, `@${role.name}`);
    }

    return text;
  }

  private async translateText(
    text: string,
    translateOptions?: { systemPrompt?: string; temperature?: number }
  ): Promise<string | null> {
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
      safe = safe.replace(
        /[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu,
        (m) => {
          const idx = placeholders.push(m) - 1;
          return `__EMJ_${idx}__`;
        }
      );

      const payload = JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              translateOptions?.systemPrompt ||
              "You are a deterministic translation engine. Translate input to Simplified Chinese. Output ONLY the translated text."
          },
          {
            role: "user",
            content: safe
          }
        ],
        temperature: translateOptions?.temperature ?? 0
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

      const maxAttempts = 3;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result: any = await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
              let body = "";
              res.on("data", (chunk) => (body += chunk));
              res.on("end", () => {
                const statusCode = Number(res.statusCode || 0);
                if (statusCode < 200 || statusCode >= 300) {
                  let parsedBody: any = null;
                  try {
                    parsedBody = body ? JSON.parse(body) : null;
                  } catch {}
                  const errorDetail =
                    parsedBody?.error?.message ||
                    parsedBody?.message ||
                    body ||
                    res.statusMessage ||
                    `HTTP ${statusCode}`;
                  reject(
                    new Error(
                      `DeepSeek 翻译请求失败(${statusCode}): ${String(errorDetail).slice(0, 200)}`
                    )
                  );
                  return;
                }
                try {
                  resolve(body ? JSON.parse(body) : null);
                } catch (e) {
                  reject(e);
                }
              });
            });
            req.setTimeout(15000, () =>
              req.destroy(new Error("DeepSeek 请求超时"))
            );
            req.on("error", (err) => reject(err));
            req.write(payload);
            req.end();
          });

          let content = result?.choices?.[0]?.message?.content;
          if (typeof content !== "string" || !content.trim()) {
            throw new Error("DeepSeek 返回空翻译结果");
          }
          // Restore placeholders
          content = content.replace(/__EMJ_(\d+)__/g, (_, i) => {
            const idx = Number(i);
            return Number.isFinite(idx) && placeholders[idx] != null
              ? placeholders[idx]
              : _;
          });
          return content.trim();
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            continue;
          }
        }
      }

      this.logger.error(
        `[TRANSLATE] failed after ${maxAttempts} attempts: ${String(lastError)}`
      );
      return null;
    } catch {
      return null;
    }
  }
}
