import {
  AnyChannel,
  Client as SelfBotClient,
  Message,
  PartialMessage,
  Role,
  User
} from "discord.js-selfbot-v13";
import { Client as BotClient } from "discord.js";

import { ActiveCategory, ActiveCategoryConfig, ActivePersonaConfig, ChannelId, Config } from "./config.js";
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
  username?: string;
  avatarUrl?: string;
  useEmbed?: boolean;
  components?: any[];
}

interface PersonaMatch {
  config: ActivePersonaConfig;
}

const ACTIVE_HEADLINE_MAP: Record<string, string> = {
  "running (valid for entry)": "策略执行中 (允许入场)",
  "valid limits (not yet filled)": "有效限价单 (尚未成交)",
  "invalid (running & stops at entry)": "订单无效 (策略执行中 & 止损设在入场价)",
  "valid limits": "有效限价单"
};

const STANDALONE_LINE_MAP: Record<string, string> = {
  "no trades available": "当前无可成交交易"
};

const INLINE_PHRASE_MAP: Record<string, string> = {
  "(not yet filled)": "(尚未成交)",
  "not yet filled": "(尚未成交)"
};

const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u2028\u2029\uFEFF\u2060]/g;

const matchesId = (expected: ChannelId, actual: string) =>
  expected != null && String(expected) === actual;

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

export class Bot {
  messagesToSend: string[] = [];
  senderBot: SenderBot; // default sender
  private senderBotsBySource?: Map<string, SenderBot>;
  private senderBotsByWebhook?: Map<string, SenderBot>;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  private sourceToTarget = new Map<string, { channelId: string; messageId: string }>();
  private env = getEnv();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();
  private personaProfileCache = new Map<string, { username: string; avatarUrl?: string }>();

  constructor(
    client: Client,
    config: Config,
    senderBot: SenderBot,
    senderBotsBySource?: Map<string, SenderBot>,
    senderBotsByWebhook?: Map<string, SenderBot>
  ) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;
    this.senderBotsByWebhook = senderBotsByWebhook;

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

  private getSenderForWebhook(webhookUrl: string): SenderBot | undefined {
    return this.senderBotsByWebhook?.get(webhookUrl);
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

  private async applyActiveOverrides(message: Message, originalText: string): Promise<ActiveOverrideResult | null> {
    const activeMatch = this.resolveActiveCategory(message.channelId);
    if (!activeMatch) return null;

    const senderBot = this.getSenderForWebhook(activeMatch.config.targetWebhook);
    if (!senderBot) {
      this.logger.info(`activeBlocks: 未找到 target webhook 对应的 SenderBot (${activeMatch.config.targetWebhook})`);
      return null;
    }

    const personas = this.resolvePersonasForBlock();
    const matchStrategy = activeMatch.config.matchStrategy ?? "auto";
    let personaMatches = this.matchActivePersonas(message, originalText, personas, matchStrategy);
    if (personaMatches.length === 0 && personas.length > 0) {
      personaMatches = [{ config: personas[0] }];
    }
    const translated = await this.buildActiveContent(activeMatch.key, originalText, personaMatches);
    if (!translated) return null;

    const personaProfile = await this.resolvePersonaProfile(personaMatches[0]?.config.userId);
    const personaDisplay = this.getPersonaDisplay(personaMatches[0]);
    // alerts 不在开头添加频道链接（已在 translateStoppedLine 中添加到末尾）
    const finalContent = (activeMatch.key === "alerts" || !personaDisplay)
      ? translated.trim()
      : `${personaDisplay}\n${translated.trim()}`;

    const personaButton = this.buildPersonaChannelButton(personaMatches[0], senderBot);
    const overrideButtons = personaButton ? [personaButton] : undefined;

    return {
      content: finalContent,
      senderBot,
      username:
        personaProfile?.username ||
        personaMatches[0]?.config.channelButtonLabel ||
        personaMatches[0]?.config.keyword ||
        personaDisplay,
      avatarUrl: personaProfile?.avatarUrl,
      useEmbed: true,
      components: overrideButtons
    };
  }

  private resolveActiveCategory(channelId: string): { key: ActiveCategory; config: ActiveCategoryConfig } | undefined {
    const entries = Object.entries(this.config.activeBlocks ?? {}) as Array<[ActiveCategory, ActiveCategoryConfig | undefined]>;
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
    if (config.sourceChannelId !== undefined && config.sourceChannelId !== null) {
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

  private matchActivePersonas(
    message: Message,
    originalText: string,
    personas: ActivePersonaConfig[],
    strategy: "keyword" | "role" | "auto"
  ): PersonaMatch[] {
    const matches: PersonaMatch[] = [];
    const combinedNormalized = this.normalizeMatchTarget(
      `${message.content || ""}\n${originalText || ""}`
    );
    const tokenCandidates = this.extractMatchTokens(
      `${message.content || ""}\n${originalText || ""}`
    );
    const checkKeyword = strategy === "keyword" || strategy === "auto";
    const checkRole = strategy === "role" || strategy === "auto";

    for (const persona of personas) {
      let matched = false;
      if (checkKeyword && persona.keyword) {
        const kw = this.normalizeMatchTarget(persona.keyword);
        if (
          kw &&
          (combinedNormalized.includes(kw) ||
            tokenCandidates.some((token) => this.isFuzzyTokenMatch(token, kw)))
        ) {
          matched = true;
        }
      }
      if (!matched && checkRole && persona.identityRoleId) {
        const roleId = String(persona.identityRoleId);
        matched =
          Boolean(message.mentions?.roles?.get(roleId)) ||
          Boolean((message as any).member?.roles?.cache?.has?.(roleId)) ||
          (message.content || "").includes(`<@&${roleId}>`);
      }
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
    personaMatches: PersonaMatch[]
  ): Promise<string | null> {
    const normalizedRaw = this.insertHeadingBoundaries(rawText);
    const stripped = this.stripPersonaMarkers(normalizedRaw, personaMatches);
    if (!stripped.trim()) return null;

    // 所有类别都使用统一的格式化逻辑
    const body = this.formatStructuredActiveBlock(stripped, personaMatches);
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
    const personaNames = personaMatches
      .map((p) => this.normalizeMatchTarget(String(p.config.keyword || "")))
      .filter(Boolean);

    const lines = this.stripInvisible(raw)
      .replace(/\r/g, "")
      .split("\n");

    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^PnL:/i.test(trimmed)) return false;
      const norm = this.normalizeMatchTarget(trimmed);
      if (
        personaNames.some(
          (name) =>
            name &&
            (norm.includes(name) ||
              this.levenshteinWithin(norm, name, 1) ||
              this.levenshteinWithin(name, norm, 1))
        )
      ) {
        return false;
      }
      return true;
    });

    return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private formatStructuredActiveBlock(raw: string, personaMatches: PersonaMatch[]): string {
    // 先做内联替换
    let preprocessed = raw;
    for (const [key, value] of Object.entries(INLINE_PHRASE_MAP)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "gi");
      preprocessed = preprocessed.replace(regex, value);
    }

    const output: string[] = [];
    const lines = preprocessed.split("\n");
    let pendingLabel: string | undefined;
    let i = 0;

    while (i < lines.length) {
      let trimmed = this.stripInvisible(lines[i]).trim();
      
      // 跳过空行（但保留必要的分隔）
      if (!trimmed) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        i++;
        continue;
      }

      // 先尝试整行标题匹配
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
        output.push(standalone);
        pendingLabel = undefined;
        i++;
        continue;
      }

      // 尝试 stopped line
      const stopped = this.translateStoppedLine(trimmed, personaMatches);
      if (stopped) {
        output.push(...stopped);
        pendingLabel = undefined;
        i++;
        continue;
      }

      // 提取标签前缀（如 :Spot:）
      const labelInfo = this.extractLabelPrefix(trimmed);
      if (labelInfo) {
        pendingLabel = labelInfo.label;
        trimmed = trimmed.slice(labelInfo.matchedLength).trim();
        if (!trimmed) {
          i++;
          continue;
        }
      }

      // 尝试翻译 Entry 行
      const entryLine = this.translateEntryLine(trimmed, pendingLabel);
      if (entryLine) {
        pendingLabel = undefined;
        output.push(entryLine);
        i++;
        continue;
      }

      // 如果有 pending label，合并输出（无空格）
      if (pendingLabel) {
        output.push(`${pendingLabel}${trimmed}`);
        pendingLabel = undefined;
        i++;
        continue;
      }

      // 如果当前行是括号内容（如 "(尚未成交)"），合并到上一行
      if (trimmed.startsWith("(") && trimmed.endsWith(")") && output.length > 0) {
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
      // 行内短语替换
      for (const [key, value] of Object.entries(INLINE_PHRASE_MAP)) {
        const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        processed = processed.replace(regex, value);
      }
      // Entry/SL/TP 等术语替换
      processed = processed.replace(/\bEntry:\s*/gi, "入场: ");
      processed = processed.replace(/\bSL:\s*/gi, "止损: ");
      processed = processed.replace(/\bTPs?:\s*/gi, "止盈: ");
      processed = processed.replace(/\bAVG:\s*/gi, "平均: ");
      processed = processed.replace(/\bBE\b/gi, "成本价");
      processed = processed.replace(/\s*PnL:.*$/i, "");
      
      output.push(processed);
      pendingLabel = undefined;
      i++;
    }

    // 清理多余空行（删除所有连续空行，只保留必要的分隔）
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
        cleaned.push(output[j]);
        lastWasEmpty = false;
      }
    }

    return cleaned.join("\n").trim();
  }

  private translateActiveHeading(line: string): string | null {
    const normalized = line.trim().toLowerCase();
    // 先尝试完整匹配
    if (ACTIVE_HEADLINE_MAP[normalized]) {
      return ACTIVE_HEADLINE_MAP[normalized];
    }
    // 尝试部分匹配：找到最长的匹配项
    const sortedKeys = Object.keys(ACTIVE_HEADLINE_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      if (normalized.startsWith(key)) {
        const translated = ACTIVE_HEADLINE_MAP[key];
        const remainder = line.trim().slice(key.length).trim();
        if (remainder) {
          return `${translated}${remainder}`;
        }
        return translated;
      }
    }
    return null;
  }

  private translateStandaloneLine(line: string): string | null {
    const normalized = line.trim().toLowerCase();
    return STANDALONE_LINE_MAP[normalized] ?? null;
  }

  private extractLabelPrefix(line: string): { label: string; matchedLength: number } | null {
    const patterns: Array<{ regex: RegExp; label: string }> = [
      { regex: /^-?\s*:?\s*short:\s*/i, label: "📉" },
      { regex: /^-?\s*:?\s*long:\s*/i, label: "📈" },
      { regex: /^-?\s*:?\s*spot:\s*/i, label: "🟡" },
      { regex: /^-?\s*:?\s*long\/short:\s*/i, label: "🌓" }
    ];

    for (const { regex, label } of patterns) {
      const match = line.match(regex);
      if (match) {
        return { label, matchedLength: match[0].length };
      }
    }

    const generic = line.match(/^(-?\s*):\s*([A-Za-z]+:)\s*/);
    if (generic) {
      const matchedLength = generic[0].length;
      const prefix = `${generic[1].trim() || "-"}${generic[2]}`.replace(/\s+/g, "");
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

  private translateStoppedLine(line: string, personaMatches: PersonaMatch[]): string[] | null {
    if (!/Stopped\s+BE/i.test(line)) return null;

    let processed = line;

    // 替换 <:Spot:数字> / <:Short:数字> / <:Long:数字> 为 emoji
    processed = processed.replace(/<:Spot:\d+>/gi, "🟡");
    processed = processed.replace(/<:Short:\d+>/gi, "📉");
    processed = processed.replace(/<:Long:\d+>/gi, "📈");
    
    // 替换 :Spot: / :Short: / :Long: 为 emoji（不带尖括号的格式）
    processed = processed.replace(/:Spot:/gi, "🟡");
    processed = processed.replace(/:Short:/gi, "📉");
    processed = processed.replace(/:Long:/gi, "📈");

    // 提取 **SYMBOL** 中的 symbol
    const symbolMatch = processed.match(/\*\*([^*]+)\*\*/);
    const symbol = symbolMatch ? symbolMatch[1].trim() : "";
    if (symbolMatch) {
      processed = processed.replace(symbolMatch[0], symbol);
    }

    // 省略 Discord 消息链接
    processed = processed.replace(/https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+:?\s*/gi, "");

    // 翻译 Stopped BE
    processed = processed.replace(/Stopped\s+BE/gi, "止损移至保本价");

    // 删除 role mention <@&...> (可能没有结尾的 >)
    processed = processed.replace(/<@&\d+>?/g, "");

    // 删除频道链接 <#...>
    processed = processed.replace(/<#\d+>/g, "");

    // 清理多余空格、冒号和换行
    processed = processed.replace(/\s+/g, " ").trim();
    processed = processed.replace(/:\s*$/, "").trim();
    processed = processed.replace(/^\s*:\s*/, "").trim();

    // 获取 persona 的频道链接，放在最后
    const personaChannelLink =
      personaMatches[0]?.config.jumpChannelId
        ? `<#${personaMatches[0]!.config.jumpChannelId}>`
        : "";

    // 构建最终格式：emoji SYMBOL 止损移至保本价 频道链接
    if (personaChannelLink) {
      processed = `${processed} ${personaChannelLink}`;
    }

    return [processed];
  }

  private async resolvePersonaProfile(userId?: ChannelId) {
    if (!userId && userId !== 0) {
      this.logger.info(`activeBlocks: resolvePersonaProfile called with invalid userId: ${userId}`);
      return null;
    }
    const id = String(userId);
    
    // 检查缓存
    if (this.personaProfileCache.has(id)) {
      const cached = this.personaProfileCache.get(id)!;
      this.logger.info(
        `activeBlocks: persona profile from cache id=${id} username=${cached.username} avatar=${cached.avatarUrl || "none"}`
      );
      return cached;
    }

    this.logger.info(`activeBlocks: fetching persona profile for userId=${id}`);
    
    try {
      const userManager: any = (this.client as any)?.users;
      this.logger.info(`activeBlocks: userManager available: ${!!userManager}, cache available: ${!!userManager?.cache}`);
      
      let user: any = userManager?.cache?.get?.(id);
      this.logger.info(`activeBlocks: user from cache: ${!!user}`);
      
      if (!user && typeof userManager?.fetch === "function") {
        this.logger.info(`activeBlocks: attempting to fetch user ${id} with force=true`);
        try {
          user = await userManager.fetch(id, { force: true });
          this.logger.info(`activeBlocks: user fetched with force=true: ${!!user}`);
        } catch (forceErr) {
          this.logger.info(`activeBlocks: force fetch failed, trying normal fetch: ${String(forceErr)}`);
          try {
            user = await userManager.fetch(id);
            this.logger.info(`activeBlocks: user fetched with normal fetch: ${!!user}`);
          } catch (normalErr) {
            this.logger.info(`activeBlocks: normal fetch also failed: ${String(normalErr)}`);
          }
        }
      } else if (!userManager?.fetch) {
        this.logger.info(`activeBlocks: userManager.fetch is not available`);
      }
      
      if (!user) {
        this.logger.info(`activeBlocks: failed to get user object for id=${id}`);
        return null;
      }
      
      const username = user.globalName || user.username || user.tag;
      this.logger.info(`activeBlocks: user object found, globalName=${user.globalName || "none"}, username=${user.username || "none"}, tag=${user.tag || "none"}`);
      
      let avatarUrl: string | undefined;
      if (typeof user.displayAvatarURL === "function") {
        avatarUrl = user.displayAvatarURL({ size: 128, format: "png" });
        this.logger.info(`activeBlocks: avatar from displayAvatarURL: ${avatarUrl || "none"}`);
      } else if (typeof user.avatarURL === "function") {
        avatarUrl = user.avatarURL({ size: 128, format: "png" });
        this.logger.info(`activeBlocks: avatar from avatarURL: ${avatarUrl || "none"}`);
      } else {
        this.logger.info(`activeBlocks: no avatar URL method available on user object`);
      }
      
      const profile = { username, avatarUrl };
      this.personaProfileCache.set(id, profile);
      this.logger.info(
        `activeBlocks: persona profile resolved successfully id=${id} username=${username} avatar=${avatarUrl || "none"}`
      );
      return profile;
    } catch (err) {
      this.logger.info(`activeBlocks: exception while fetching user ${id}: ${String(err)}`);
      this.logger.info(`activeBlocks: error stack: ${(err as any)?.stack || "no stack"}`);
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

  private buildPersonaChannelButton(persona: PersonaMatch | undefined, sender: SenderBot) {
    if (!persona?.config.jumpChannelId) return undefined;
    const label = persona.config.channelButtonLabel || persona.config.keyword || "查看频道";
    const guildId = sender.webhookGuildId || "@me";
    const url = `https://discord.com/channels/${guildId}/${persona.config.jumpChannelId}`;
    return { type: 2, style: 5, label, url };
  }

  private isFuzzyTokenMatch(token: string, keyword: string) {
    if (!token || !keyword) return false;
    if (token.includes(keyword)) return true;
    return this.levenshteinWithin(token, keyword, 1);
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

  private async processAndSend(message: Message, tag?: string) {
    // 懒加载历史映射（进程首次消息时）
    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    // 渲染 mentions 后得到用户可见文本
    const renderOutput = await this.messageAction(message, tag);
    const originalText = (renderOutput.content || "").trim();

    const activeOverride = await this.applyActiveOverrides(message, originalText);

    let sender = activeOverride?.senderBot || this.getSenderForChannel(message.channelId);
    if (!sender) {
      this.logger.debug(`跳过：未映射的源频道 channel=${message.channelId}`);
      return;
    }

    // 回复映射：若被回复消息存在映射，则在目标侧关联为引用
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    let components: any[] | undefined;
    const actionButtons: any[] = [...(activeOverride?.components ?? [])];
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
    let username =
      activeOverride?.username ||
      (message.author as any)?.globalName ||
      message.author.username ||
      message.author.tag;
    let avatarUrl: string | undefined = activeOverride?.avatarUrl;
    try {
      if (!avatarUrl) {
      const anyAuthor = message.author as any;
      if (typeof anyAuthor.displayAvatarURL === "function") {
        avatarUrl = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
      } else if (typeof anyAuthor.avatarURL === "function") {
        avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
        }
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

    let useEmbed = activeOverride?.useEmbed ?? true;
    let finalText = activeOverride?.content ?? originalText;
    const skipDefaultTranslation = Boolean(activeOverride);
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

    // 若源消息为"回复"，无论是否能建立真正引用，都在文本最前添加可见的回复头部，仅保留作者与可点击链接（不重复展示纯文本频道名）
    console.log(`[DEBUG] Processing message ${message.id}, has reference:`, !!message.reference?.messageId);
    let replyHeader = "";  // 保存回复头部,避免被翻译逻辑覆盖
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
      replyHeader = `↳ @${authorName}${link}`;
      console.log(`[DEBUG] Adding reply header:`, replyHeader);
      finalText = `${replyHeader}\n${finalText}`;
      console.log(`[DEBUG] Final text after header:`, finalText.substring(0, 100));
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
              // 保留回复头部,只替换消息内容部分
              if (replyHeader) {
                finalText = `${replyHeader}\n${a}\n-----------\n${b}`;
              } else {
                finalText = `${a}\n-----------\n${b}`;
              }
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
      safe = safe.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu, (m) => {
        const idx = placeholders.push(m) - 1;
        return `__EMJ_${idx}__`;
      });

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
