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
  // 记录每个特殊源频道最近一次出现的交易员（用于“解锁占位→实内容”关联）
  private lastTraderByChannel = new Map<string, { trader: string; ts: number }>();
  private unlockWindowByChannel = new Map<string, number>();
  // 记录解锁占位消息中出现的角色ID（<@&ID>），用于在解锁窗口内将后续真实内容映射到交易员
  private lastRoleIdsByChannel = new Map<string, { roleIds: string[]; ts: number }>();
  // 记录特殊频道每个源消息最后一次发送的描述，避免重复发送
  private lastFormattedBySourceId = new Map<string, string>();

  constructor(client: Client, config: Config, senderBot: SenderBot, senderBotsBySource?: Map<string, SenderBot>) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;

    // 根据配置设置“特殊日志”过滤：仅输出特殊/解锁/交易信号相关日志（ERROR 始终保留）
    try {
      const logCfg = this.config.logging || {} as any;
      const pattern = logCfg.filterPattern
        || (logCfg.specialOnly
            ? String.raw`\b(?:specialChannel|tradeSignal|unlock|update\-(?:poll|scan|click)|messageUpdate\(special\)|multi\-trader|button)\b`
            : undefined);
      if (typeof (this.logger as any).setFilter === "function") {
        (this.logger as any).setFilter(pattern);
      }
    } catch {}

    (this.client as any).on("ready", (clientArg: Client<true>) => {
      const msg = `Logged into Discord as @${clientArg.user?.tag}!`;
      console.log(msg);
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
      this.logger.debug(`messageCreate: guild=${message.guildId || "DM"} channel=${message.channelId} id=${message.id} author=${message.author?.tag}`);
      try {
        // 对 specialChannels：在 messageCreate 阶段用于“自动点击 Unlock”；
        // 若本条并非占位（不含 Unlock 提示），则允许直接处理（有些源会以“新消息”而非“编辑”呈现解锁内容）
        const specials = (this.config.specialChannels || []).map((s) => s.sourceChannelId);
        if (specials.includes(message.channelId)) {
          try {
            const raw = (message.content || "");
            const unlockHint = /unlock\s*content|press\s*the\s*button\s*to\s*unlock|解锁/ig;
            const hasComponents = Array.isArray((message as any).components) && (message as any).components.length > 0;
            const isUnlockPlaceholder = unlockHint.test(raw) || ((raw.trim() === "") && hasComponents);
            if (isUnlockPlaceholder && hasComponents) {
              // 缓存交易员：从占位消息开头的 @Name 提取
              try {
                const m = (raw.match(/^@-?([A-Za-z0-9_\.]+)\b/) || [])[1];
                if (m) {
                  this.lastTraderByChannel.set(message.channelId, { trader: m, ts: Date.now() });
                  this.logger.debug(`cached trader '${m}' at auto-click stage for channel ${message.channelId}`);
                }
              } catch {}
              // 额外缓存占位消息中的角色ID数组（<@&ID>），用于后续解锁窗口内解析交易员
              try {
                const ids = Array.from((raw.matchAll(/<@&([0-9]{5,})>/g) || [])).map((x) => x[1]);
                if (ids.length > 0) {
                  this.lastRoleIdsByChannel.set(message.channelId, { roleIds: ids, ts: Date.now() });
                  this.logger.debug(`cached roleIds [${ids.join(',')}] at auto-click stage for channel ${message.channelId}`);
                }
              } catch {}
              // 扫描组件，寻找包含“Unlock/解锁”字样的按钮，提取 customId 后点击
              const rows: any[] = (message as any).components || [];
              let clicked = false;
              let clickResult: any = null;
              for (const row of rows) {
                const comps: any[] = row?.components || [];
                for (const comp of comps) {
                  const label: string = comp?.label || "";
                  const cid: string | undefined = comp?.customId || comp?.custom_id;
                  const isButton = comp?.type === 2 || typeof cid === "string";
                  if (!isButton || !cid) continue;
                  if (/unlock|解锁/i.test(label)) {
                    try {
                      this.logger.info(`auto-click Unlock button: customId=${cid} mid=${message.id}`);
                      clickResult = await (message as any).clickButton(cid);
                      clicked = true;
                      break;
                    } catch (e) {
                      this.logger.error(`auto-click Unlock failed: ${String(e)}`);
                    }
                  }
                }
                if (clicked) break;
              }
              if (!clicked) {
                // 若未匹配到含 Unlock 文案的按钮，则记录可用 customId 以便人工配置
                try {
                  const cids: string[] = [];
                  for (const row of rows) {
                    for (const comp of (row?.components || [])) {
                      if (comp?.customId || comp?.custom_id) cids.push(comp.customId || comp.custom_id);
                    }
                  }
                  this.logger.info(`auto-click Unlock: no matching label button, available customIds: ${cids.join(", ") || "<none>"}`);
                } catch {}
                // 兜底：尝试点击第一枚按钮
                try {
                  outer: for (const row of rows) {
                    for (const comp of (row?.components || [])) {
                      const cid: string | undefined = comp?.customId || comp?.custom_id;
                      const isButton = comp?.type === 2 || typeof cid === "string";
                      if (!isButton || !cid) continue;
                      try {
                        this.logger.info(`auto-click Unlock fallback click: customId=${cid} mid=${message.id}`);
                        clickResult = await (message as any).clickButton(cid);
                        clicked = true;
                        break outer;
                      } catch (e) {
                        this.logger.error(`auto-click Unlock fallback failed: ${String(e)}`);
                      }
                    }
                  }
                } catch {}
              } else {
                // 若 click 返回了新的消息（或编辑后的消息对象），尝试直接处理一次
                try {
                  const ret: any = clickResult;
                  if (ret && (ret.id || typeof ret.fetch === "function" || typeof ret.content === "string")) {
                    const full = typeof ret.fetch === "function" ? await ret.fetch() : ret;
                    this.logger.debug(`auto-click Unlock got message: channel=${full.channelId} id=${full.id || "(noid)"}`);
                    await this.processAndSend(full as any, "update-click");
                  }
                } catch (e) {
                  this.logger.error(`auto-click Unlock immediate process failed: ${String(e)}`);
                }
                // 兼容性：部分机器人不会返回消息对象或会延迟编辑，做两次补偿轮询
                try {
                  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
                  for (const delay of [1500, 3000]) {
                    await sleep(delay);
                    try {
                      const refreshed: any = typeof (message as any).fetch === "function" ? await (message as any).fetch() : message;
                      this.logger.debug(`auto-click Unlock poll(${delay}ms): channel=${refreshed.channelId} id=${refreshed.id}`);
                      await this.processAndSend(refreshed as any, "update-poll");
                    } catch (e) {
                      this.logger.error(`auto-click Unlock poll failed (${delay}ms): ${String(e)}`);
                    }
                  }
                } catch {}
                // 最后补偿：扫描频道最近消息，找到非占位的“真实内容”并处理
                try {
                  const ch: any = (message as any).channel || await (this.client as any).channels.fetch(message.channelId);
                  if (ch && ch.messages && typeof ch.messages.fetch === "function") {
                    const batch: any = await ch.messages.fetch({ limit: 6 }).catch(() => null);
                    if (batch) {
                      const arr: any[] = Array.from(batch.values());
                      for (const m of arr) {
                        try {
                          const raw = (m.content || "");
                          const isUnlock = /press\s*the\s*button\s*to\s*unlock|unlock\s*content|解锁/i.test(raw);
                          const hasComponents = Array.isArray((m as any).components) && (m as any).components.length > 0;
                          if (!isUnlock && (raw.trim() !== "" || ((m.embeds || []).length > 0))) {
                            this.logger.debug(`auto-click Unlock scan pick: channel=${m.channelId} id=${m.id} len=${raw.length}`);
                            await this.processAndSend(m as any, "update-scan");
                            break;
                          }
                        } catch {}
                      }
                    }
                  }
                } catch (e) {
                  this.logger.error(`auto-click Unlock scanLatest failed: ${String(e)}`);
                }
              }
              // 若未成功点击，同样执行一次扫描补偿
              if (!clicked) {
                try {
                  const ch: any = (message as any).channel || await (this.client as any).channels.fetch(message.channelId);
                  if (ch && ch.messages && typeof ch.messages.fetch === "function") {
                    const batch: any = await ch.messages.fetch({ limit: 6 }).catch(() => null);
                    if (batch) {
                      const arr: any[] = Array.from(batch.values());
                      for (const m of arr) {
                        try {
                          const raw2 = (m.content || "");
                          const isUnlock2 = /press\s*the\s*button\s*to\s*unlock|unlock\s*content|解锁/i.test(raw2);
                          if (!isUnlock2 && (raw2.trim() !== "" || ((m.embeds || []).length > 0))) {
                            this.logger.debug(`auto-click Unlock scan pick (no-click): channel=${m.channelId} id=${m.id} len=${raw2.length}`);
                            await this.processAndSend(m as any, "update-scan");
                            break;
                          }
                        } catch {}
                      }
                    }
                  }
                } catch (e) {
                  this.logger.error(`auto-click Unlock scanLatest(no-click) failed: ${String(e)}`);
                }
              }
              this.unlockWindowByChannel.set(message.channelId, Date.now() + 12000);
              this.logger.debug(`auto-click Unlock window started: channel=${message.channelId} ttlMs=12000`);
              return; // 占位消息不进入常规发送流程
            }
          } catch (e) {
            this.logger.error(`messageCreate(special) unlock auto-click error: ${String(e)}`);
          }
        }
      } catch (e) {
        // 外层 catch，防止未知错误中断
      }
      await this.processAndSend(message);
    });

    // 仅对 specialChannels 源频道监听更新事件（用于“解锁后内容”）
    (this.client as any).on("messageUpdate", async (_oldMsg: any, newMsg: any) => {
      try {
        const chId = newMsg?.channelId || _oldMsg?.channelId;
        if (!chId) return;
        const specials = (this.config.specialChannels || []).map((s) => s.sourceChannelId);
        if (!specials.includes(chId)) return;
        const full = typeof newMsg.fetch === "function" ? await newMsg.fetch() : newMsg;
        this.logger.debug(`messageUpdate(special): guild=${full.guildId || "DM"} channel=${chId} id=${full.id}`);
        await this.processAndSend(full, "update");
      } catch (e) {
        this.logger.error(`messageUpdate handler failed: ${String(e)}`);
      }
    });

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

  private async processAndSend(message: Message, tag?: string) {
    // 懒加载历史映射（进程首次消息时）
    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    const renderOutput = await this.messageAction(message, tag);

    // DeepSeek 翻译：有文本即可（不再要求“纯文本”），开关启用且存在内容
    const rawContent = (message.content || "").trim();
    const hasText = rawContent !== "";
    let originalContent = (renderOutput.content || "").trim();
    let translatedText: string | undefined;
    let forceNoTranslate = false;
    let useEmbed = true;

    // 若整条仅为 :alias: 表情（允许多个），在顶层直接跳过翻译与嵌入
    try {
      const rawContentCleanedTop = (rawContent || "").replace(/\p{Cf}/gu, "");
      const aliasFilterRawTop = rawContentCleanedTop.replace(/[^:\sA-Za-z0-9_~+\.-]/gu, "");
      const isOnlyAliasEmotesTop = /^(?:\s*:[A-Za-z0-9_~+\.-]+:\s*)+$/u.test(aliasFilterRawTop);
      // 严格模式：若整条消息首字符为 ':' 且末字符为 ':'，也视为表情别名消息
      const strictAlias = (() => {
        const t = rawContent.replace(/\p{Cf}/gu, "").trim();
        return t.startsWith(":") && t.endsWith(":") && !/[\n\r]/.test(t);
      })();
      if (isOnlyAliasEmotesTop || strictAlias) {
        originalContent = rawContent; // 保持原样
        translatedText = undefined;
        useEmbed = false;
        forceNoTranslate = true; // 后续彻底跳过翻译判定
      }
    } catch {}

    // 特殊频道规则处理（如交易信号格式化）
    const specialRule = (this.config.specialChannels || []).find((r) => r.sourceChannelId === message.channelId && r.rule === "tradeSignal");
    let forceUseEmbed = false;
    let disableAttachments = false;
    let components: any[] | undefined;
    let overrideName: string | undefined;
    let overrideAvatarUrl: string | undefined;
    if (specialRule) {
      // 对部分频道会先发“解锁”占位消息：缓存交易员并跳过发送
      const unlockHint = /unlock\s*content|press\s*the\s*button\s*to\s*unlock/i;
      const hasComponentsNow = Array.isArray((message as any)?.components) && ((message as any).components.length > 0);
      // 视为空内容+按钮为占位
      if (unlockHint.test(rawContent) || ((rawContent.trim() === "") && hasComponentsNow)) {
        // 尝试从占位消息中抓取 @Name 作为 trader
        const m = (rawContent.match(/^@-?([A-Za-z0-9_\.]+)\b/) || [])[1];
        if (m) {
          this.lastTraderByChannel.set(message.channelId, { trader: m, ts: Date.now() });
          this.logger.debug(`cached trader '${m}' for channel ${message.channelId}`);
        }
        // 尝试从占位中抓取 <@&ROLE_ID>
        try {
          const ids = Array.from((rawContent.matchAll(/<@&([0-9]{5,})>/g) || [])).map((x) => x[1]);
          if (ids.length > 0) {
            this.lastRoleIdsByChannel.set(message.channelId, { roleIds: ids, ts: Date.now() });
            this.logger.debug(`cached roleIds [${ids.join(',')}] for channel ${message.channelId}`);
          }
        } catch {}
        // 开启解锁捕获窗口（12 秒），用于捕获下一条真实内容
        this.unlockWindowByChannel.set(message.channelId, Date.now() + 12000);
        this.logger.debug(`specialChannel unlock window started: channel=${message.channelId} ttlMs=12000`);
        this.logger.debug("specialChannel unlock placeholder skipped");
        return;
      }

      // 若本条未带 @Name，则尝试使用缓存的 trader（延长至 24 小时）
      let overrideTrader: string | undefined;
      try {
        const cached = this.lastTraderByChannel.get(message.channelId);
        if (cached && Date.now() - cached.ts <= 24 * 60 * 60 * 1000) {
          // 仅当本条没有 @Name 时才使用缓存
          if (!/^@-?[A-Za-z0-9_\.]+\b/.test(rawContent)) {
            overrideTrader = cached.trader;
            this.logger.debug(`specialChannel trader fallback from cache: channel=${message.channelId} trader=${overrideTrader}`);
          }
        }
      } catch {}

      // 非解锁窗口：短时复用缓存的 roleIds（例如 2 分钟内的占位），用于处理“手动点击”后的真实内容
      try {
        if (!overrideTrader) {
          const cache = this.lastRoleIdsByChannel.get(message.channelId);
          if (cache && (Date.now() - cache.ts <= 2 * 60 * 1000)) {
            const ids = cache.roleIds || [];
            const tMap = specialRule.traderToTarget || {};
            const keys = Object.keys(tMap || {});
            let hit: string | undefined;
            for (const id of ids) {
              for (const k of keys) {
                const arr = (tMap[k] as any)?.roleIds as string[] | undefined;
                if (Array.isArray(arr) && arr.map(String).includes(String(id))) { hit = k; break; }
              }
              if (hit) break;
            }
            if (hit) {
              overrideTrader = hit;
              this.logger.debug(`specialChannel trader via cached roleIds (post-manual) channel=${message.channelId} trader=${overrideTrader}`);
            }
          }
        }
      } catch {}

      // 若仍未知且疑似来自解锁（当前消息空内容/无 embed 或最近出现 unlock 占位），回退扫描近期消息以反向定位交易员
      try {
        if (!overrideTrader) {
          const looksLikeUnlockFollowup = ((message.content || "").trim() === "" && ((message.embeds || []).length === 0));
          const hasRecentWindow = (this.unlockWindowByChannel.get(message.channelId) || 0) > (Date.now() - 5000);
          if (looksLikeUnlockFollowup || hasRecentWindow) {
            const ch: any = await (this.client as any).channels.fetch(message.channelId).catch(() => null);
            if (ch && ch.messages) {
              const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
              if (recent) {
                // 找到最近一条包含 unlock 提示或 <@&ROLE_ID> 的占位
                const unlockRe = /unlock\s*content|press\s*the\s*button\s*to\s*unlock/i;
                let roleIds: string[] = [];
                for (const m of recent.values()) {
                  const text = (m.content || "").replace(/\p{Cf}/gu, "");
                  if (unlockRe.test(text) || /<@&[0-9]{5,}>/.test(text)) {
                    roleIds = Array.from(text.matchAll(/<@&([0-9]{5,})>/g)).map(x => x[1]);
                    if (roleIds.length > 0) break;
                  }
                }
                if (roleIds.length > 0) {
                  const tMap = specialRule.traderToTarget || {};
                  const keys = Object.keys(tMap || {});
                  let hit: string | undefined;
                  for (const id of roleIds) {
                    for (const k of keys) {
                      const arr = (tMap[k] as any)?.roleIds as string[] | undefined;
                      if (Array.isArray(arr) && arr.map(String).includes(String(id))) { hit = k; break; }
                    }
                    if (hit) break;
                  }
                  if (hit) {
                    overrideTrader = hit;
                    this.logger.debug(`specialChannel trader via recent-scan roleIds: channel=${message.channelId} trader=${overrideTrader}`);
                  }
                }
              }
            }
          }
        }
      } catch {}

      // 解锁窗口内：若缓存了角色ID，优先通过 roleIds → traderToTarget 解析为交易员
      try {
        const until = this.unlockWindowByChannel.get(message.channelId) || 0;
        const cache = this.lastRoleIdsByChannel.get(message.channelId);
        if (!overrideTrader && until > Date.now() && cache && (Date.now() - cache.ts <= 24 * 60 * 60 * 1000)) {
          const ids = cache.roleIds || [];
          const tMap = specialRule.traderToTarget || {};
          const keys = Object.keys(tMap || {});
          let hit: string | undefined;
          for (const id of ids) {
            for (const k of keys) {
              const arr = (tMap[k] as any)?.roleIds as string[] | undefined;
              if (Array.isArray(arr) && arr.map(String).includes(String(id))) {
                hit = k; break;
              }
            }
            if (hit) break;
          }
          if (hit) {
            overrideTrader = hit;
            this.logger.debug(`specialChannel trader via cached roleIds in unlock window: channel=${message.channelId} trader=${overrideTrader}`);
          }
        }
      } catch {}

      // 若仍未确定 trader，尝试从角色提及ID/名称与嵌入元信息中匹配 special.traderToTarget 的键
      try {
        if (!overrideTrader) {
          const tMap = specialRule.traderToTarget || {};
          const keys = Object.keys(tMap || {});
          const norm = (s: string) => (s || "").replace(/\p{Cf}/gu, "").trim();
          // 打印本条消息涉及到的角色
          try {
            const rolesInfo: string[] = [];
            for (const role of message.mentions.roles.values()) {
              rolesInfo.push(`${role.id}=${norm(role.name)}`);
            }
            this.logger.debug(`specialChannel roles mentioned: [${rolesInfo.join(", ")}]`);
          } catch {}
          // 0) 先按 roleIds 精确匹配
          try {
            let hit = false;
            for (const role of message.mentions.roles.values()) {
              const rid = String(role.id);
              for (const k of keys) {
                const ids = (tMap[k] as any)?.roleIds as string[] | undefined;
                if (Array.isArray(ids) && ids.map(String).includes(rid)) {
                  overrideTrader = k;
                  this.logger.debug(`specialChannel trader detect via roleId: roleId='${rid}' -> trader='${k}'`);
                  hit = true;
                  break;
                }
              }
              if (hit) break;
            }
          } catch {}
          // 1) 从角色提及名称匹配
          try {
            for (const role of message.mentions.roles.values()) {
              const name = norm(role.name);
              for (const k of keys) {
                if (name.toLowerCase().includes(k.toLowerCase())) {
                  overrideTrader = k;
                  this.logger.debug(`specialChannel trader detect via role mention: role='${name}' -> trader='${k}'`);
                  break;
                }
              }
              if (overrideTrader) break;
            }
          } catch {}
          // 2) 从嵌入 author/title/description/footer 与 content 匹配
          if (!overrideTrader) {
            const embedPieces: string[] = [];
            try {
              for (const e of (message.embeds || [])) {
                if ((e as any)?.author?.name) embedPieces.push(String((e as any).author.name));
                if (e.title) embedPieces.push(String(e.title));
                if (e.description) embedPieces.push(String(e.description));
                if ((e as any)?.footer?.text) embedPieces.push(String((e as any).footer.text));
              }
            } catch {}
            const hay = norm([rawContent, ...embedPieces].join("\n"));
            for (const k of keys) {
              if (hay.toLowerCase().includes(k.toLowerCase())) {
                overrideTrader = k;
                this.logger.debug(`specialChannel trader detect via embed/content: trader='${k}'`);
                break;
              }
            }
          }
          // 3) 从文本中的 role mention 语法或纯数字ID匹配 roleIds
          if (!overrideTrader) {
            try {
              const pieces: string[] = [];
              pieces.push(rawContent || "");
              try { for (const e of (message.embeds || [])) { if (e.description) pieces.push(String(e.description)); } } catch {}
              const textAll = norm(pieces.join("\n"));
              const mentionIds = Array.from(textAll.matchAll(/<@&([0-9]{5,})>/g)).map(m => m[1]);
              const plainIds = Array.from(textAll.matchAll(/\b([0-9]{10,20})\b/g)).map(m => m[1]);
              const candidates = Array.from(new Set([...mentionIds, ...plainIds]));
              if (candidates.length > 0) this.logger.debug(`specialChannel roleId candidates from text: [${candidates.join(",")}]`);
              let hit = false;
              for (const id of candidates) {
                for (const k of keys) {
                  const ids = (tMap[k] as any)?.roleIds as string[] | undefined;
                  if (Array.isArray(ids) && ids.map(String).includes(String(id))) {
                    overrideTrader = k;
                    this.logger.debug(`specialChannel trader detect via text roleId: id='${id}' -> trader='${k}'`);
                    hit = true;
                    break;
                  }
                }
                if (hit) break;
              }
            } catch {}
          }
        }
      } catch {}

      // 过期消息保护：避免几天前旧消息被编辑时误发（点击/轮询触发的更新允许）
      try {
        const created = (message as any).createdTimestamp as number | undefined;
        const edited = (message as any).editedTimestamp as number | undefined;
        const createdTs = Number.isFinite(created) ? (created as number) : 0;
        const maxAgeMs = 60 * 60 * 1000; // 1h
        const isClickFlow = tag === "update-click" || tag === "update-poll" || tag === "update-scan";
        const now = Date.now();
        const createdAge = createdTs > 0 ? (now - createdTs) : -1;
        const editedTs = (message as any).editedTimestamp as number | undefined;
        const freshnessTs = Math.max(editedTs || 0, createdTs || 0);
        const freshAge = freshnessTs > 0 ? (now - freshnessTs) : -1;
        const clickWindowMs = 30000; // 解锁点击后的“编辑新鲜度”允许窗口
        if (isClickFlow) {
          // 解锁流程内：按“编辑时间”判断新鲜，避免旧创建时间导致丢弃
          if (freshAge >= 0 && freshAge > clickWindowMs) {
            this.logger.debug(`specialChannel stale skip (edited-based): channel=${message.channelId} mid=${message.id} created=${createdTs} edited=${editedTs || "-"} tag=${tag || "-"} freshAgeMs=${freshAge}`);
            return;
          }
        } else {
          // 普通路径：允许按最大年龄过滤，但优先使用“编辑时间”若存在
          const basisAge = (freshnessTs > 0 ? freshAge : createdAge);
          if (basisAge >= 0 && basisAge > maxAgeMs) {
            this.logger.debug(`specialChannel stale skip (age-based): channel=${message.channelId} mid=${message.id} created=${createdTs} edited=${editedTs || "-"} tag=${tag || "-"} ageMs=${basisAge}`);
            return;
          }
        }
      } catch {}

      // 有些解锁后的真实内容在 Embed.description 中，不在 content（优先使用嵌入内容）
      const embedText = (() => {
        try {
          return (message.embeds || []).map((e: any) => e?.description || "").filter((s: string) => s && s.trim() !== "").join("\n");
        } catch { return ""; }
      })();
      const composedRaw = (embedText && embedText.trim() !== "")
        ? embedText.trim()
        : ((message.content || "").trim());
      try {
        const c0 = (message.content || "");
        const e0 = embedText || "";
        this.logger.debug(`specialChannel source content len=${c0.length} preview=${c0.slice(0,200).replace(/\n/g,"\\n")}`);
        this.logger.debug(`specialChannel source embed len=${e0.length} preview=${e0.slice(0,200).replace(/\n/g,"\\n")}`);
      } catch {}
      this.logger.debug(`specialChannel composedRaw origin=${embedText && embedText.trim() !== "" ? "embed" : "content"} length=${composedRaw.length}`);

      const formatted = this.formatTradeSignal(
        composedRaw,
        specialRule,
        this.getSenderForChannel(message.channelId)?.webhookGuildId,
        overrideTrader
      );
      this.logger.debug(`tradeSignal formatted: trader=${formatted.trader || ""} entry=${formatted.entry || ""} sl=${formatted.sl || ""}`);
      // 检测多交易员：来自（1）已检测主交易员，（2）消息中的角色提及映射，（3）协作方在映射中的名字
      try {
        const tMap = specialRule.traderToTarget || {};
        const keys = Object.keys(tMap || {});
        const order: string[] = [];
        const seen = new Set<string>();
        const add = (name?: string) => {
          if (!name) return;
          if (!tMap[name]) return;
          if (!seen.has(name)) { seen.add(name); order.push(name); }
        };
        // 角色提及顺序
        try {
          for (const role of message.mentions.roles.values()) {
            for (const k of keys) {
              const ids = (tMap[k] as any)?.roleIds as string[] | undefined;
              if (Array.isArray(ids) && ids.map(String).includes(String(role.id))) add(k);
            }
          }
        } catch {}
        // 从 composedRaw 文本中解析 <@&roleId>（容错缺失 >），不再接受纯数字 ID，避免把表情/其它ID误判为角色ID
        try {
          const textAll = composedRaw;
          const mentionIds = Array.from(textAll.matchAll(/<@&([0-9]{5,})>?/g)).map(m => m[1]);
          if (mentionIds.length > 0) this.logger.debug(`multi-trader candidates from text: [${mentionIds.join(",")}]`);
          for (const id of mentionIds) {
            for (const k of keys) {
              const ids = (tMap[k] as any)?.roleIds as string[] | undefined;
              if (Array.isArray(ids) && ids.map(String).includes(String(id))) add(k);
            }
          }
        } catch {}
        // 已检测主交易员
        add(formatted.trader);
        // 协作方
        try { for (const c of (formatted.collaborators || [])) add(c); } catch {}

        if (order.length > 1) {
          this.logger.debug(`tradeSignal multi-trader split: [${order.join(", ")}]`);
          // 多人情况下：分别为每位交易员构建并发送
          const senderForThis = this.getSenderForChannel(message.channelId);
          if (!senderForThis) {
            this.logger.debug(`skip: channel ${message.channelId} not mapped in channelWebhooks`);
            return;
          }
          for (const name of order) {
            try {
              const fmt2 = this.formatTradeSignal(
                composedRaw,
                specialRule,
                senderForThis.webhookGuildId,
                name
              );
              if (!fmt2.entry || fmt2.entry.trim() === "") continue;
              const nextDesc2 = (fmt2.description || "").trim();
              // 头像/昵称覆盖：按当前交易员
              let overrideName2: string | undefined;
              let overrideAvatarUrl2: string | undefined;
              try {
                const conf = (specialRule.traderToTarget || {})[name];
                const uid = (conf as any)?.sourceUserId as string | undefined;
                const tryFetch = async (): Promise<boolean> => {
                  if (!uid) return false;
                  try {
                    const u: any = await (this.client as any).users.fetch(uid);
                    if (u) {
                      overrideName2 = u.globalName || u.displayName || u.username || u.tag;
                      if (typeof u.displayAvatarURL === "function") {
                        overrideAvatarUrl2 = u.displayAvatarURL({ size: 128, format: "png" });
                      } else if (typeof u.avatarURL === "function") {
                        overrideAvatarUrl2 = u.avatarURL({ size: 128, format: "png" });
                      }
                      this.logger.debug(`tradeSignal display override via sourceUserId (split) '${name}': '${overrideName2 || ""}'`);
                      return true;
                    }
                  } catch (e) {
                    this.logger.debug(`tradeSignal users.fetch failed (split) for uid=${uid}: ${String(e)}`);
                  }
                  // message.guild
                  try {
                    const g = (message as any).guild;
                    if (g && g.members && typeof g.members.fetch === "function") {
                      const m: any = await g.members.fetch(uid).catch(() => null);
                      if (m && m.user) {
                        overrideName2 = m.nickname || m.user.globalName || m.user.username || overrideName2;
                        if (typeof m.displayAvatarURL === "function") {
                          overrideAvatarUrl2 = m.displayAvatarURL({ size: 128, format: "png" });
                        } else if (typeof m.user.displayAvatarURL === "function") {
                          overrideAvatarUrl2 = m.user.displayAvatarURL({ size: 128, format: "png" });
                        }
                        this.logger.debug(`tradeSignal display override via message.guild member (split): name='${overrideName2 || ""}' guild='${g.id}'`);
                        return true;
                      }
                    }
                  } catch {}
                  // scan guilds
                  try {
                    const guilds: any = (this.client as any).guilds?.cache;
                    if (guilds && typeof guilds.forEach === "function") {
                      for (const g of guilds.values()) {
                        try {
                          const m: any = await g.members.fetch(uid).catch(() => null);
                          if (m && m.user) {
                            overrideName2 = m.nickname || m.user.globalName || m.user.username || overrideName2;
                            if (typeof m.displayAvatarURL === "function") {
                              overrideAvatarUrl2 = m.displayAvatarURL({ size: 128, format: "png" });
                            } else if (typeof m.user.displayAvatarURL === "function") {
                              overrideAvatarUrl2 = m.user.displayAvatarURL({ size: 128, format: "png" });
                            }
                            this.logger.debug(`tradeSignal display override via guild member (split): name='${overrideName2 || ""}' guild='${g.id}'`);
                            return true;
                          }
                        } catch {}
                      }
                    }
                  } catch {}
                  return false;
                };
                await tryFetch();
              } catch {}

              // 覆盖失败兜底：使用映射键名（name）作为显示名，确保稳定
              try {
                if (!overrideName2 && name) {
                  overrideName2 = name;
                  this.logger.debug(`tradeSignal display fallback to trader key (split): '${overrideName2}'`);
                }
              } catch {}

              // 组件按钮：跳转到该交易员的频道（跨服退化为 URL 按钮）
              let components2: any[] | undefined;
              try {
                const tgt = fmt2.target;
                if (tgt && tgt.channelId) {
                  const webhookGuildId = senderForThis.webhookGuildId;
                  const gid = tgt.guildId || webhookGuildId;
                  if (gid) {
                    const url = `https://discord.com/channels/${gid}/${tgt.channelId}`;
                    const label = tgt.label || `#${name}`;
                    components2 = [
                      { type: 1, components: [{ type: 2, style: 5, label, url }] }
                    ];
                  }
                }
              } catch {}

              // 发送（不翻译，强制 embed），附件沿用当前消息的附件（本地收集，避免作用域问题）
              let username2 = (message.member as any)?.displayName || message.author.username || message.author.tag;
              let avatarUrl2: string | undefined;
              try {
                const anyAuthor = message.author as any;
                if (typeof anyAuthor.displayAvatarURL === "function") {
                  avatarUrl2 = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
                } else if (typeof anyAuthor.avatarURL === "function") {
                  avatarUrl2 = anyAuthor.avatarURL({ size: 128, format: "png" });
                }
              } catch {}
              if (overrideName2) username2 = overrideName2;
              if (overrideAvatarUrl2) avatarUrl2 = overrideAvatarUrl2;
              // 本地附件收集
              const uploads2: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
              try {
                for (const att of message.attachments.values()) {
                  const url = att.url;
                  const filename = att.name || "file";
                  const ct = (att.contentType || "").toLowerCase();
                  const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
                  const isVideo = ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(url);
                  uploads2.push({ url, filename, isImage, isVideo });
                }
              } catch {}
              // 拆分发送：移除已有的 w/ 片段与尾部 traderPart，并重建包含所有交易员的 w/ 列表（尽量可点击）
              let baseDesc = nextDesc2
                .replace(/\s+w\/\s+[^\n]+$/i, "")       // 去掉尾部 "w/ ..."
                .replace(/\s+(?:<#\d+>|#[^\s#]+)\s*$/i, ""); // 去掉尾部 traderPart（频道 mention 或 #Name）
              let finalDesc2 = baseDesc;
              try {
                const tMap2 = specialRule.traderToTarget || {};
                const wItems: string[] = [];
                for (const o of order) {
                  const tgtO = tMap2[o];
                  const gid = (tgtO?.guildId || senderForThis.webhookGuildId);
                  if (tgtO?.channelId && (gid === senderForThis.webhookGuildId || (!tgtO.guildId && senderForThis.webhookGuildId))) {
                    wItems.push(`<#${tgtO.channelId}>`);
                  } else if (tgtO?.channelId) {
                    // 跨服退化为文本名
                    wItems.push(`#${o}`);
                  } else {
                    wItems.push(`#${o}`);
                  }
                }
                if (wItems.length > 0) finalDesc2 = `${baseDesc} w/ ${wItems.join(" ")}`;
              } catch {}
              const finalContent2 = [finalDesc2].join("\n");
              const toSend2 = [{
                content: `${finalContent2}`.trim(),
                sourceMessageId: message.id,
                replyToSourceMessageId: message.reference?.messageId,
                replyToTarget: undefined,
                username: username2,
                avatarUrl: avatarUrl2,
                useEmbed: true,
                uploads: uploads2,
                ...(components2 ? { components: components2 } : {})
              }];

              const results2 = await senderForThis.sendData(toSend2);
              if (results2 && results2.length > 0) {
                const first = results2[0];
                if (first.sourceMessageId) {
                  this.sourceToTarget.set(first.sourceMessageId, {
                    channelId: first.targetChannelId,
                    messageId: first.targetMessageId
                  });
                  await this.saveMapping();
                  this.logger.info(`sent message mapped (split '${name}'): source=${first.sourceMessageId} -> target=${first.targetChannelId}/${first.targetMessageId}`);
                }
              }
            } catch (e) {
              this.logger.error(`multi-trader split send failed for '${name}': ${String(e)}`);
            }
          }
          // 分发完成，避免走单人路径重复发送
          return;
        }
      } catch {}
      // 对特殊频道：要求至少解析到入场价后再发送，避免仅输出“止损: 手动”
      if (!formatted.entry || formatted.entry.trim() === "") {
        this.logger.debug(`specialChannel skip (no entry yet): channel=${message.channelId} mid=${message.id}`);
        return;
      }
      // 去重：若与上次发送内容相同，则跳过
      const prev = this.lastFormattedBySourceId.get(message.id);
      const nextDesc = formatted.description.trim();
      if (prev && prev === nextDesc) {
        this.logger.debug(`specialChannel dedup: channel=${message.channelId} mid=${message.id}`);
        return;
      }
      // 将特殊格式化的文本作为最终内容，强制使用 embed
      originalContent = nextDesc;
      forceUseEmbed = specialRule.useEmbed !== false; // 默认启用 embed
      useEmbed = forceUseEmbed;
      disableAttachments = !!specialRule.disableAttachments;
      // 始终提供 URL 跳转按钮：跨服也允许（以链接形式），guildId 优先用映射提供，否则回退到 webhookGuildId
      if (formatted.target && formatted.target.channelId) {
        try {
          const webhookGuildId = this.getSenderForChannel(message.channelId)?.webhookGuildId;
          const gid = formatted.target.guildId || webhookGuildId;
          if (gid) {
            this.logger.debug(`tradeSignal button: webhookGuildId=${webhookGuildId} targetGuildId=${formatted.target.guildId || "(fallback)"} channelId=${formatted.target.channelId}`);
            const url = `https://discord.com/channels/${gid}/${formatted.target.channelId}`;
            const label = formatted.target.label || "跳转频道";
            components = [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label,
                    url
                  }
                ]
              }
            ];
          }
        } catch {}
      }
      // 跳过翻译（如配置）
      if (specialRule.skipTranslation) {
        translatedText = undefined;
      }

      // 若配置了 trader 的 sourceUserId，则以该用户的头像与名字展示 webhook（覆盖作者）；
      // 若拉取失败或未配置，则尝试使用配置中的 displayName/avatarUrl 作为回退；
      // 否则回退到首位协作人（若其在映射中配置了 sourceUserId/displayName/avatarUrl）。
      try {
        const tName = formatted.trader || "";
        const tMap = specialRule.traderToTarget || {};
        const tryFetchByName = async (name?: string) => {
          if (!name) return false;
          const conf = tMap[name];
          if (!conf) {
            this.logger.debug(`tradeSignal display: no config for trader='${name}'`);
          }
          const uid = conf?.sourceUserId;
          if (!uid) {
            this.logger.debug(`tradeSignal display: no sourceUserId for trader='${name}'`);
            return false;
          }
          try {
            const u: any = await (this.client as any).users.fetch(uid);
            if (u) {
              overrideName = u.globalName || u.displayName || u.username || u.tag;
              if (typeof u.displayAvatarURL === "function") {
                overrideAvatarUrl = u.displayAvatarURL({ size: 128, format: "png" });
              } else if (typeof u.avatarURL === "function") {
                overrideAvatarUrl = u.avatarURL({ size: 128, format: "png" });
              }
              this.logger.debug(`tradeSignal display override via sourceUserId: name='${overrideName || ""}'`);
              return true;
            }
          } catch (e) {
            this.logger.debug(`tradeSignal users.fetch failed for uid=${uid}: ${String(e)}`);
          }
          // 1) Try current message.guild first
          try {
            const g = (message as any).guild;
            if (g && g.members && typeof g.members.fetch === "function") {
              const m: any = await g.members.fetch(uid).catch(() => null);
              if (m && m.user) {
                // 使用稳定名称：globalName 或 username（避免昵称变动）
                overrideName = m.user.globalName || m.user.username || overrideName;
                if (typeof m.displayAvatarURL === "function") {
                  overrideAvatarUrl = m.displayAvatarURL({ size: 128, format: "png" });
                } else if (typeof m.user.displayAvatarURL === "function") {
                  overrideAvatarUrl = m.user.displayAvatarURL({ size: 128, format: "png" });
                }
                this.logger.debug(`tradeSignal display override via message.guild member: name='${overrideName || ""}' guild='${g.id}'`);
                return true;
              }
            }
          } catch {}
          // 2) Scan cached guilds sequentially
          try {
            const guilds: any = (this.client as any).guilds?.cache;
            if (guilds && typeof guilds.forEach === "function") {
              for (const g of guilds.values()) {
                try {
                  const m: any = await g.members.fetch(uid).catch(() => null);
                  if (m && m.user) {
                    overrideName = m.user.globalName || m.user.username || overrideName;
                    if (typeof m.displayAvatarURL === "function") {
                      overrideAvatarUrl = m.displayAvatarURL({ size: 128, format: "png" });
                    } else if (typeof m.user.displayAvatarURL === "function") {
                      overrideAvatarUrl = m.user.displayAvatarURL({ size: 128, format: "png" });
                    }
                    this.logger.debug(`tradeSignal display override via guild member: name='${overrideName || ""}' guild='${g.id}'`);
                    return true;
                  }
                } catch {}
              }
            }
          } catch {}
          // 3) 配置中的显示信息回退（displayName/avatarUrl）
          try {
            const conf = (tMap as any)[name];
            const dName = conf?.displayName as string | undefined;
            const aUrl = conf?.avatarUrl as string | undefined;
            if (dName || aUrl) {
              overrideName = dName || overrideName;
              overrideAvatarUrl = aUrl || overrideAvatarUrl;
              this.logger.debug(`tradeSignal display override via mapping display fields: name='${overrideName || ""}' avatarUrl=${overrideAvatarUrl ? "yes" : "no"}`);
              return true;
            }
          } catch {}
          this.logger.debug(`tradeSignal display override failed for uid=${uid}`);
          return false;
        };

        let fetched = await tryFetchByName(tName);
        if (!fetched) {
          const collabs = (formatted as any).collaborators as string[] | undefined;
          if (collabs && collabs.length > 0) {
            for (const c of collabs) {
              fetched = await tryFetchByName(c);
              if (fetched) break;
            }
          }
        }
      } catch (e) {
        this.logger.error(`fetch trader sourceUserId failed: ${String(e)}`);
      }

      // 覆盖失败兜底：使用映射键名（trader）作为显示名，确保稳定
      try {
        if (!overrideName && formatted.trader) {
          overrideName = formatted.trader;
          this.logger.debug(`tradeSignal display fallback to trader key: '${overrideName}'`);
        }
      } catch {}

      // 成功构造并准备发送，若有解锁窗口则关闭
      try {
        if (this.unlockWindowByChannel.has(message.channelId)) {
          this.unlockWindowByChannel.delete(message.channelId);
          this.logger.debug(`specialChannel unlock window closed: channel=${message.channelId}`);
        }
      } catch {}
    }

    // Twitter/X 单链接：以纯文本发送，触发 Discord 原生预览
    try {
      const isTwitterOnly = /^<?https?:\/\/(?:x\.com|twitter\.com)\/\S+>?$/i.test(rawContent);
      if (isTwitterOnly) {
        originalContent = rawContent.replace(/[<>]/g, "");
        translatedText = undefined;
        useEmbed = false;
      }
    } catch {}

    // GIF 链接的处理移动到附件收集之后

    // 路由：仅当该源频道在映射中时才转发；未映射则跳过
    const senderForThis = this.getSenderForChannel(message.channelId);
    if (!senderForThis) {
      this.logger.debug(`skip: channel ${message.channelId} not mapped in channelWebhooks`);
      return;
    }
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    let ctaLine: string | undefined;
    if (message.reference && !specialRule) {
      try {
        const ref = await message.fetchReference();
        let mapped = this.sourceToTarget.get(ref.id);
        // 不重发，改为：若无映射，尝试在目标历史中扫描已有消息并建立映射
        if (!mapped) {
          try {
            mapped = await this.tryResolveMappingFromTarget(ref.id, senderForThis);
          } catch (e) {
            console.error("scan target for mapping failed", e);
            this.logger.error(`scan target for mapping failed: ${String(e)}`);
          }
        }
        if (mapped) {
          replyToTarget = { channelId: mapped.channelId, messageId: mapped.messageId };
          // 无论是否有附件/Embed，都生成 CTA 行；有资产时用“查看附件”，否则用“查看消息”
          if (senderForThis.webhookGuildId) {
            const link = `https://discord.com/channels/${senderForThis.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
            const display = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
            const hasAssets = (ref.attachments?.size ?? 0) > 0 || (ref.embeds?.length ?? 0) > 0;
            const label = hasAssets ? "查看附件" : "查看消息";
            ctaLine = `↳ @${display}: [${label}](${link})`;
          }
        }
      } catch (err) {
        console.error(err);
        this.logger.error(`fetchReference failed: ${String(err)}`);
      }
    }

    // 翻译：仅当文本为“英文为主”（含拉丁字母且不含中文）时才触发；
    // 并在此再次拦截纯链接/仅 :alias:/仅 Unicode 表情的情况。
    // 若整条仅为 :alias: 表情（可多个），则明确不翻译
    const rawContentCleaned = (rawContent || "").replace(/\p{Cf}/gu, "");
    // 更宽松：去除与 alias 无关的标点/符号后再判定，仅保留 : 和 alias 字符集
    const aliasFilterRaw = rawContentCleaned.replace(/[^:\sA-Za-z0-9_~+.-]/gu, "");
    const isOnlyAliasEmotesRaw = /^(?:\s*:[A-Za-z0-9_~+.-]+:\s*)+$/u.test(aliasFilterRaw);
    if (!forceNoTranslate && this.env.TRANSLATION_ENABLED !== "false" && hasText && this.env.DEEPSEEK_API_KEY && !isOnlyAliasEmotesRaw) {
      const raw = originalContent.trim();
      const hasLatin = /[A-Za-z]/.test(raw);
      const hasCJK = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(raw);
      const urlRe = /^(<?https?:\/\/\S+>?)$/i;
      const allTokens = raw.split(/\s+/);
      const isAllUrls = allTokens.length > 0 && allTokens.every((t) => urlRe.test(t));
      const cleanedForAlias = raw.replace(/\p{Cf}/gu, "");
      const aliasFilter = cleanedForAlias.replace(/[^:\sA-Za-z0-9_~+.-]/gu, "");
      const isOnlyAliasEmotes = /^(?:\s*:[A-Za-z0-9_~+.-]+:\s*)+$/u.test(aliasFilter);
      const compact = raw.replace(/[\s\n\r\t]+/g, "");
      const emojiOnly = compact.length > 0 && compact.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu, "") === "";
      const shouldTranslate = hasLatin && !hasCJK && !isAllUrls && !isOnlyAliasEmotes && !emojiOnly;
      if (shouldTranslate) {
        try {
          translatedText = await this.translateText(originalContent);
        } catch (e) {
          console.error(e);
        }
      }
    }

    // 拼装最终内容：CTA 在顶部；译文段不重复 CTA
    const parts: string[] = [];
    if (ctaLine) parts.push(ctaLine);
    if (originalContent) parts.push(originalContent);
    if (translatedText) {
      const normA = originalContent.trim();
      const normB = translatedText.trim();
      if (normB && normB.toLowerCase() !== normA.toLowerCase()) {
        parts.push("-----------");
        parts.push(translatedText);
      }
    }
    const finalContent = parts.join("\n");

    // 伪装作者：使用源作者的昵称/用户名和头像
    let username = (message.author as any)?.globalName || message.author.username || message.author.tag;
    let avatarUrl: string | undefined;
    try {
      const anyAuthor = message.author as any;
      if (typeof anyAuthor.displayAvatarURL === "function") {
        avatarUrl = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
      } else if (typeof anyAuthor.avatarURL === "function") {
        avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
      }
    } catch {}

    // 覆盖为交易员的头像与名字（如已配置）
    if (overrideName) username = overrideName;
    if (overrideAvatarUrl) avatarUrl = overrideAvatarUrl;

    // 收集需要上传的附件：首张图片将内嵌到同一个 Embed，视频/其他作为同条消息的附件（可直接播放）
    const uploads: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
    let hasCurrentImage = false;
    try {
      if (!disableAttachments) {
        for (const att of message.attachments.values()) {
          const url = att.url;
          const filename = att.name || "file";
          const ct = (att.contentType || "").toLowerCase();
          const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
          const isVideo = ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(url);
          if (isImage) hasCurrentImage = true;
          uploads.push({ url, filename, isImage, isVideo });
        }
      }
    } catch {}

    // Tenor/Giphy：恢复为仅发送链接文本以触发 Discord 原生展开（不做直链抓取、不发送附件）
    try {
      const gifOnly = /^<?https?:\/\/(?:tenor\.com|giphy\.com)\/\S+>?$/i.test(rawContent);
      if (gifOnly) {
        const pageUrl = rawContent.replace(/[<>]/g, "");
        originalContent = pageUrl;
        translatedText = undefined;
        useEmbed = false;
      }
    } catch (e) {
      this.logger.error(`tenor/giphy handling failed: ${String(e)}`);
    }

    // 不借用被回复消息的图片：仅转发当前消息自身的附件到同一 Embed

    const toSend = [{
      content: `${finalContent}`.trim(),
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed,
      uploads,
      ...(components ? { components } : {})
    }];

    // 在发送前写入去重缓存，避免特殊频道同一源消息在快速多次更新时重复发送
    try {
      const specials = (this.config.specialChannels || []).map((s) => s.sourceChannelId);
      if (specials.includes(message.channelId)) {
        this.lastFormattedBySourceId.set(message.id, (originalContent || "").trim());
      }
    } catch {}

    const results = await senderForThis.sendData(toSend);
    if (results && results.length > 0) {
      const first = results[0];
      if (first.sourceMessageId) {
        this.sourceToTarget.set(first.sourceMessageId, {
          channelId: first.targetChannelId,
          messageId: first.targetMessageId
        });
        await this.saveMapping();
        this.logger.info(`sent message mapped: source=${first.sourceMessageId} -> target=${first.targetChannelId}/${first.targetMessageId}`);
        // 记录已发送的描述用于去重（仅针对特殊频道）
        try {
          const specials = (this.config.specialChannels || []).map((s) => s.sourceChannelId);
          if (specials.includes(message.channelId)) {
            this.lastFormattedBySourceId.set(first.sourceMessageId, (originalContent || "").trim());
          }
        } catch {}
      }
    }
  }

  // 在目标频道历史消息中尝试解析出某个 sourceId 的映射
  private async tryResolveMappingFromTarget(sourceId: string, senderForThis?: SenderBot): Promise<{ channelId: string; messageId: string } | undefined> {
    try {
      let configured: string[] = [];
      if (this.config.historyScan?.channels && this.config.historyScan.channels.length > 0) {
        configured = this.config.historyScan.channels;
      } else {
        // Auto collect: all known target channels
        const set = new Set<string>();
        try {
          // from all sender bots defaultChannelId
          for (const sb of (this.senderBotsBySource?.values() || [])) {
            const id = (sb as any).defaultChannelId as string | undefined;
            if (id) set.add(id);
          }
        } catch {}
        try {
          // from specialChannels traderToTarget.channelId
          for (const sc of (this.config.specialChannels || [])) {
            const map = sc.traderToTarget || {};
            for (const v of Object.values(map)) {
              if (v?.channelId) set.add(String(v.channelId));
            }
          }
        } catch {}
        if (set.size > 0) configured = Array.from(set);
        // final fallback: senderForThis.defaultChannelId
        if (configured.length === 0 && senderForThis?.defaultChannelId) configured = [senderForThis.defaultChannelId];
      }
      const unlimited = !this.config.historyScan || this.config.historyScan.limit === undefined || (Number(this.config.historyScan.limit) <= 0);
      const hardCap = unlimited ? Number.POSITIVE_INFINITY : Math.max(1, Number(this.config.historyScan!.limit));

      for (const channelId of configured) {
        try {
          const ch: any = await (this.client as any).channels.fetch(channelId);
          if (!ch || !ch.messages) continue;
          let lastId: string | undefined = undefined;
          let scanned = 0;
          while (unlimited || scanned < hardCap) {
            const step = unlimited ? 100 : Math.min(100, hardCap - scanned);
            const batch: any = await ch.messages.fetch({ limit: step, ...(lastId ? { before: lastId } : {}) });
            const arr = Array.from(batch.values()) as any[];
            if (arr.length === 0) break;
            for (const m of arr) {
              scanned++;
              lastId = m.id;
              const embeds: any[] = (m.embeds || []) as any[];
              for (const e of embeds) {
                const footerText: string | undefined = e?.footer?.text;
                if (footerText && footerText.trim() === `sid:${sourceId}`) {
                  const found = { channelId, messageId: m.id };
                  this.sourceToTarget.set(sourceId, found);
                  await this.saveMapping();
                  this.logger.debug(`historyScan hit by footer: source=${sourceId} target=${channelId}/${m.id}`);
                  return found;
                }
              }
              const content: string = (m.content || "") as string;
              if (content.includes(sourceId)) {
                const found = { channelId, messageId: m.id };
                this.sourceToTarget.set(sourceId, found);
                await this.saveMapping();
                this.logger.debug(`historyScan hit by content: source=${sourceId} target=${channelId}/${m.id}`);
                return found;
              }
            }
            if (arr.length < (unlimited ? 100 : Math.min(100, hardCap - scanned))) break;
          }
        } catch (e: any) {
          // 跳过无权限的频道
          this.logger.error(`historyScan channel skipped (no access?): ${channelId} error=${String(e)}`);
          continue;
        }
      }
    } catch (e) {
      console.error(e);
      this.logger.error(`tryResolveMappingFromTarget failed: ${String(e)}`);
    }
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
    } catch {}

    return { content: render } as RenderOutput;
  }

  private async translateText(text: string): Promise<string | null> {
    try {
      // Skip translation for pure links or pure :alias: style emojis
      const raw = (text || "").trim();
      if (!raw) return null;
      const urlRe = /^(<?https?:\/\/\S+>?)$/i;
      const isAllUrls = raw.split(/\s+/).length > 0 && raw.split(/\s+/).every((t) => urlRe.test(t));
      const isOnlyAliasEmotes = /^(?:\s*:[A-Za-z0-9_~+.-]+:\s*)+$/u.test(raw);
      // Heuristic: message contains only Unicode emojis (with optional spaces/ZWJ/VS/sex signs/skin tones)
      const compact = raw.replace(/[\s\n\r\t]+/g, "");
      const emojiOnly = compact.length > 0 && compact.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u2640\u2642\u{1F3FB}-\u{1F3FF}]+/gu, "") === "";
      if (isAllUrls || isOnlyAliasEmotes || emojiOnly) return null;

      const url = this.env.DEEPSEEK_API_URL as string;
      const payload = JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "You are a deterministic translation engine. Task: translate input to Simplified Chinese. Rules: 1) Output ONLY the translated text, no explanations, no apologies, no pre/post text, no quotes, no code fences. 2) Preserve original formatting where reasonable, keep markdown and URLs unchanged. 3) If the input is already Chinese, return it as-is. 4) Never say you cannot answer; just translate the content."
          },
          {
            role: "user",
            content: `<<INPUT>>\n${text}\n<<END>>\nTranslate the content between <<INPUT>> and <<END>>. Reply with translation only.`
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
          Authorization: `Bearer ${this.env.DEEPSEEK_API_KEY}`,
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
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });

      let content = result?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;
      // 轻量后处理：去除常见的道歉/解释性冗余与包裹符号
      content = content.trim()
        .replace(/^```[a-zA-Z]*\n?|```$/g, "")
        .replace(/^\s*["'`]+|["'`]+\s*$/g, "");
      const lines = content.split(/\r?\n/).filter((ln) => {
        const l = ln.trim();
        if (!l) return true;
        const bad = [
          "对不起",
          "抱歉",
          "我还没有学会",
          "作为一个",
          "无法回答",
          "如果你有其他问题"
        ];
        return !bad.some((k) => l.startsWith(k));
      });
      const cleaned = lines.join("\n").trim();
      return cleaned || null;
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
      } catch (e) {
        this.logger.error(`renderMentions failed to fetch channel: ${String(e)}`);
      }
    }

    for (const role of roles) {
      text = text.replace(`<@&${role.id}>`, `@${role.name}`);
    }

    return text;
  }

  private formatTradeSignal(
    raw: string,
    specialRule: {
      title?: string;
      traderToTarget?: Record<string, { channelId: string; guildId?: string }>;
      fallbackTraderLink?: "mention" | "url" | "text";
    },
    webhookGuildId?: string,
    overrideTrader?: string
  ): { description: string; trader?: string; target?: { sameGuild: boolean; guildId?: string; channelId?: string; label?: string }, collaborators?: string[], entry?: string, sl?: string } {
    // 预清洗：去掉不可见格式控制字符（如 ZWSP、VS 等）
    const cleanedRaw = (raw || "").replace(/\p{Cf}/gu, "");
    const lines = cleanedRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const first = lines[0] || "";
    let trader = "";
    // Extract trader from leading @Name or @-Name
    const mTrader = first.match(/^@-?([A-Za-z0-9_\.]+)\b/);
    if (mTrader) trader = mTrader[1];
    if (!trader && overrideTrader) trader = overrideTrader;
    try { this.logger.debug(`tradeSignal detect trader: fromLine=${mTrader ? mTrader[1] : ""} override=${overrideTrader || ""} final=${trader || ""}`); } catch {}

    // Extract symbol with enhanced rules
    const allText = lines.join(" \n ");
    // 去除常见 Markdown 与自定义表情以用于鲁棒提取（不用于最终输出，仅用于解析）
    const allTextNoMd = allText
      .replace(/<:[A-Za-z0-9_]+:[0-9]+>/g, " ") // <:Long:123>
      .replace(/[\*`_~]+/g, " ") // **bold**, _it_, `code`, ~~
      .replace(/\s{2,}/g, " ")
      .trim();
    // Detect position side (long/short)（基于去Markdown/自定义表情文本，避免把 <:Long:ID> 误识别为 Long）
    let side = "";
    const mSide = allTextNoMd.match(/\b(long|short)\b/i);
    if (mSide) side = mSide[1].toLowerCase() === "long" ? "Long:" : "Short:";
    const stopwords = new Set(["LIMIT","SPOT","LONG","SHORT","EXIT","ENTRY","SL","TP","BUY","SELL","WITH","COLLAB"]);
    let symbol = "";
    // 优先从 “… Entry” 前的最近 token 提取
    const entryIdx = allText.search(/\bEntry\b/i);
    if (entryIdx >= 0) {
      const before = allText.slice(0, entryIdx).split(/\s+/).filter(Boolean);
      for (let i = before.length - 1; i >= 0; i--) {
        const tok = before[i].replace(/[^A-Za-z0-9_\-]/g, "");
        if (!/^[A-Za-z][A-Za-z0-9_\-]*$/.test(tok)) continue;
        const up = tok.toUpperCase();
        if (stopwords.has(up)) continue;
        symbol = up;
        break;
      }
    }
    if (!symbol) {
      // 回退：已知列表 + pumpfun 关键字
      const mSym = allText.match(/\b(BTC|ETH|ZEC|JCT|SOL|BNB|ADA|XRP|DOGE|DOT|MATIC|AVAX|LTC|LINK|OP|ARB|SUI|APT|ATOM|FIL|NEAR|ETC|BCH|PEPE|ORDI|ENA|WIF|TAO)\b/i);
      symbol = (mSym ? mSym[1] : "").toUpperCase();
      if (!symbol && /\bpump\s*fun\b|\bpumpfun\b/i.test(allText)) {
        symbol = "PUMPFUN";
      }
    }
    if (!symbol) {
      // 再回退：首行显著英文 token（长度>=3且非停用词）
      const candidates = first.split(/\s+/).map((t) => t.replace(/[^A-Za-z0-9_\-]/g, "")).filter((t) => /^[A-Za-z][A-Za-z0-9_\-]*$/.test(t));
      const chosen = candidates.find((t) => t.length >= 3 && !stopwords.has(t.toUpperCase()));
      symbol = (chosen || "").toUpperCase();
    }
    if (!symbol) {
      // 最终回退：从全文扫描英文 token（长度>=3且非停用词）
      const tokens = allText.split(/[^A-Za-z0-9_\-]+/).filter(Boolean);
      const pick = tokens.find((t) => /^[A-Za-z][A-Za-z0-9_\-]*$/.test(t) && t.length >= 3 && !stopwords.has(t.toUpperCase()));
      if (pick) symbol = pick.toUpperCase();
    }
    if (!symbol) {
      // 最后兜底
      const token = (first.split(/\s+/).find((t) => /^[A-Za-z][A-Za-z0-9_\-]*$/.test(t)) || "").toUpperCase();
      symbol = token;
    }

    // Extract entry: prefer "Entry:" line, fallback to number ranges like a-b/a-b-c or slash-separated (with optional commas)
    let entry = "";
    const entryLine = lines.find((l) => /\bEntry\b/i.test(l)) || "";
    if (entryLine) {
      const mm = entryLine.match(/Entry\s*:?\s*([0-9.,\/\- ]+)/i);
      if (mm) {
        const rawEnt = mm[1].trim();
        entry = rawEnt.replace(/,/g, "").replace(/\s*/g, "").replace(/\//g, "-");
      }
    }
    if (!entry) {
      // Markdown 形式：如 **Entry:** 0.688 / **Entry:** 0.688-0.655
      const mmMd = allTextNoMd.match(/\bEntry\b[^0-9]{0,20}([0-9][0-9.,\/\- ]{0,50})/i);
      if (mmMd) {
        const rawEnt = mmMd[1].trim();
        entry = rawEnt.replace(/,/g, "").replace(/\s*/g, "").replace(/\//g, "-");
      }
    }
    if (!entry) {
      // 支持：
      //  - 带逗号：88,772/86,967 或 88,772 - 86,967 - 85,500
      //  - 不带逗号的多位数字：93300 - 93500 或 93300/93500
      //  - 小数（含前导 0）：0.05297 - 0.04961 或 0.05297/0.04961
      const num = String.raw`(?:\d{1,3}(?:,\d{3})+|\d*\.\d+|\d{4,})`;
      const rangeRe = new RegExp(String.raw`\b(${num}(?:\s*[-\/]\s*${num}){1,2})\b`);
      const mm2 = allText.match(rangeRe);
      if (mm2) {
        entry = mm2[1].replace(/,/g, "").replace(/\s*/g, "").replace(/\//g, "-");
      }
    }

    // Extract SL: variants SL:, stop, and normalize timeframe close above/below；先尝试直接数值（含逗号）
    let sl = "";
    const slMatchNum = allText.match(/\b(?:SL|stop)\s*:?\s*([0-9,]+(?:\.\d+)?)/i);
    if (slMatchNum) {
      sl = slMatchNum[1].replace(/,/g, "");
    } else {
      const slMatch = allText.match(/\bSL\s*:?\s*([A-Za-z0-9.,<>=\-+ %]+)\b/i) || allText.match(/\bstop\s*:?\s*([A-Za-z0-9.,<>=\-+ %]+)\b/i);
      if (slMatch) sl = slMatch[1].trim().replace(/,/g, "");
    }
    if (!sl) {
      // Markdown 形式：如 **SL:** 0.6242 或 **SL:** 4h close below 0.6242
      const slMdNum = allTextNoMd.match(/\b(?:SL|stop)\b[^0-9]{0,20}([0-9][0-9.,]*)/i);
      if (slMdNum) sl = slMdNum[1].replace(/,/g, "");
      if (!sl) {
        const slMdCond = allTextNoMd.match(/\b(?:SL|stop)\b[^A-Za-z0-9]{0,20}((?:\d+\s*[MHWD]|\d*\.?\d+\s*[MHWD]|\d+H|\d+M|\d+W|\d+D)\s*(?:close\s*)?(above|below)\s*([0-9]+(?:\.[0-9]+)?))/i);
        if (slMdCond) sl = slMdCond[1].replace(/\s+close\s*/i, " ");
      }
    }
    // 规范化诸如 "4h close below 1.09" / "h4 close below 1.09" / "4H close above 2.5" / "daily close below 2.5" 等
    const tfMap = (s: string) => s.replace(/\b(\d+\s*[mhwd])\b/ig, (m) => {
      const u = m.replace(/\s+/g, "").toUpperCase();
      return u.replace("M","M").replace("H","H").replace("D","D").replace("W","W");
    });
    const allTextTF = allText
      .replace(/\bdaily\b/ig, "1D")
      .replace(/\bweekly\b/ig, "1W")
      .replace(/\bmonthly\b/ig, "1M");
    // 支持可选倍率前缀，例如 '2x 5m close below 86500'
    const tfNorm = allTextTF.replace(/\b((\d+)x\s*)?(h?\d+|\d+\s*[mhwd])\s*close\s*(below|above)\s*([0-9]+(?:\.[0-9]+)?)\b/ig, (_m, multRaw, multNum, tf, dir, num) => {
      let tfStr = String(tf).toUpperCase().replace(/^H(\d+)/, "$1H");
      if (/^\d+$/.test(tfStr)) tfStr = tfStr + "H"; // 裸数字视为小时
      tfStr = tfStr.replace(/\s+/g, "");
      const cmp = String(dir).toLowerCase() === "below" ? "<" : ">";
      const mult = multNum ? `${multNum}x ` : "";
      return `${mult}${tfStr} ${cmp} ${num}`;
    });
    if (!sl) {
      const mTf = tfNorm.match(/\b((\d+)x\s*)?(\d+H|\d+M|\d+D|\d+W)\s*[<>]\s*[0-9]+(?:\.[0-9]+)?\b/);
      if (mTf) sl = mTf[0];
    } else {
      const mTf2 = tfNorm.match(/\b((\d+)x\s*)?(\d+H|\d+M|\d+W|\d+D)\s*[<>]\s*[0-9]+(?:\.[0-9]+)?\b/);
      if (mTf2) sl = mTf2[0];
    }
    try { this.logger.debug(`tradeSignal extract side='${side || ""}' sl='${sl || ""}'`); } catch {}

    // Build trader link part
    let traderPart = "";
    const map = specialRule.traderToTarget || {};
    const t = trader || "";
    const target = t ? map[t] : undefined;
    let targetInfo: { sameGuild: boolean; guildId?: string; channelId?: string; label?: string } | undefined;
    if (t && target?.channelId) {
      // Only allow same-server clickable mention; cross-server becomes plain text with log.
      if (target.guildId && webhookGuildId) {
        if (target.guildId === webhookGuildId) {
          traderPart = `<#${target.channelId}>`;
          targetInfo = { sameGuild: true, guildId: target.guildId, channelId: target.channelId, label: `#${t}` };
        } else {
          traderPart = `#${t}`;
          this.logger.info(`tradeSignal: trader '${t}' guildId mismatch (target=${target.guildId} webhook=${webhookGuildId}); using plain text only`);
          targetInfo = { sameGuild: false, guildId: target.guildId, channelId: target.channelId, label: `#${t}` };
        }
      } else if (webhookGuildId) {
        // guildId not provided in mapping; assume same guild as webhook for mention
        traderPart = `<#${target.channelId}>`;
        targetInfo = { sameGuild: true, guildId: webhookGuildId, channelId: target.channelId, label: `#${t}` };
      } else {
        traderPart = `#${t}`;
      }
    } else if (t) {
      // Unknown trader or missing channelId: plain text and log reminder to add mapping
      traderPart = `#${t}`;
      this.logger.info(`tradeSignal: unknown trader mapping for '${t}', outputting plain text. Please add to specialChannels.traderToTarget with channelId.`);
    }

    // 协作人解析：collab/with/w/ 变体，提取 @-Name 序列（不再用于输出 'w/' 片段，仅保留以备将来需求）
    const collabNames: string[] = [];
    try {
      const collabRe = /(?:\(\s*collab\s+|\bcollab\b|\bwith\b|\bw\/\b)[^\n]*?(@-?[A-Za-z0-9_.]+)(?:[^\n]*?(@-?[A-Za-z0-9_.]+))*/ig;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((m = collabRe.exec(allText))) {
        for (let i = 1; i < m.length; i++) {
          const grp = m[i];
          if (!grp) continue;
          const name = grp.replace(/^@-?/, "");
          if (!seen.has(name)) { seen.add(name); collabNames.push(name); }
        }
      }
    } catch {}
    // 构建 w/ 片段
    const wParts: string[] = [];

    const chunks: string[] = [];
    if (specialRule.title && specialRule.title.trim() !== "") chunks.push(`🚀│${specialRule.title.trim()}`);
    const sidePart = side ? `${side} ` : "";
    const symPart = `📈 ${symbol ? `${symbol} ` : ""}`;
    const entryPart = entry ? `入场: ${entry}` : "";
    const slPart = `止损: ${sl || "手动"}`;
    const mainLine = [(sidePart + symPart + entryPart).trim(), slPart, traderPart].filter((s) => s && s.trim() !== "").join(" ");
    if (mainLine) chunks.push(mainLine);
    const description = chunks.join("\n");
    return { description, trader, target: targetInfo, collaborators: collabNames, entry, sl };
  }

  // 解析 Tenor/Giphy 页面，提取直链媒体（优先视频，其次 GIF 图片）
  private async resolveDirectMediaFromPage(pageUrl: string): Promise<{ url: string; isImage?: boolean; isVideo?: boolean; filename?: string } | null> {
    try {
      const https = await import("node:https");
      const { URL } = await import("node:url");
      const u = new URL(pageUrl);
      const options: import("node:https").RequestOptions = {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + (u.search || "")
      };
      const html: string = await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        });
        req.on("error", (e) => reject(e));
        req.end();
      });

      // 优先 og:video
      const videoMatch = html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["'][^>]*>/i);
      if (videoMatch && videoMatch[1]) {
        const vurl = videoMatch[1];
        const filename = vurl.split("/").pop() || "video.mp4";
        return { url: vurl, isVideo: true, filename };
      }

      // 其次 og:image（通常为 gif）
      const imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i);
      if (imageMatch && imageMatch[1]) {
        const iurl = imageMatch[1];
        const filename = iurl.split("/").pop() || "image.gif";
        return { url: iurl, isImage: true, filename };
      }

      // 兼容 JSON-LD 的 contentUrl
      const ldMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (ldMatch && ldMatch[1]) {
        try {
          const json = JSON.parse(ldMatch[1]);
          const contentUrl = json?.contentUrl || (Array.isArray(json) ? json.find((x: any) => x?.contentUrl)?.contentUrl : undefined);
          if (contentUrl) {
            const furl = String(contentUrl);
            const isGif = /\.gif($|\?)/i.test(furl);
            const filename = furl.split("/").pop() || (isGif ? "image.gif" : "media.bin");
            return { url: furl, isImage: isGif, isVideo: !isGif, filename };
          }
        } catch {}
      }

      return null;
    } catch (e) {
      this.logger.error(`resolveDirectMediaFromPage exception: ${String(e)}`);
      return null;
    }
  }
}