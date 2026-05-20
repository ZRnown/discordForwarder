import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

export type ChannelId = number | string;
export type ChatId = ChannelId;

export interface ChannelConfig {
  muted: ChannelId[];
  allowed: ChannelId[];
}

export type ActiveCategory = "spot" | "futures" | "alerts";

export interface ActivePersonaConfig {
  userId: ChannelId;
  identityRoleId?: ChannelId;
  jumpChannelId: ChannelId;
  jumpGuildId?: ChannelId; // 跳转频道所属的服务器ID，可选，默认为源消息的服务器
  sourceChannelId?: ChannelId;
  keyword?: string;
  channelButtonLabel?: string;
}

export interface ActiveCategoryConfig {
  sourceChannelIds?: ChannelId[];
  sourceChannelId?: ChannelId;
  targetWebhook: string;
  threadWebhook?: string;
  matchStrategy?: "keyword" | "role" | "auto" | "channel";
}

export interface WebhookEntry {
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

export interface Config {
  // 映射：源频道ID -> 目标Webhook（可直接写 url 字符串、对象 `{ url, remark?, displayName?, avatarUrl?, emojiMap? }` 或数组）
  // 支持：
  // "src": "https://..."
  // "src": { url: "...", remark?: "...", displayName?: "...", avatarUrl?: "...", emojiMap?: {...} }
  // "src": [ "https://...", { url: "...", displayName: "...", avatarUrl: "...", emojiMap: {...} } ]
  channelWebhooks?: Record<
    string,
    string | WebhookEntry | Array<string | WebhookEntry>
  >;
  mutedGuildsIds?: ChannelId[];
  allowedGuildsIds?: ChannelId[];
  mutedChannelsIds?: ChannelId[];
  allowedChannelsIds?: ChannelId[];
  allowedUsersIds?: ChannelId[];
  mutedUsersIds?: ChannelId[];
  channelConfigs?: Record<string, ChannelConfig>;
  showDate?: boolean;
  showChat?: boolean;
  stackMessages?: boolean;
  showMessageDeletions?: boolean;
  showMessageUpdates?: boolean;
  replacementsDictionary?: Record<string, string>;
  historyScan?: {
    enabled?: boolean;
    limit?: number;
    channels?: string[];
  };
  logging?: {
    filterPattern?: string; // optional custom regex, overrides specialOnly default pattern
    keepDays?: number; // 保留最近 N 天日志
  };
  antiAbuse?: {
    // 全局随机抖动毫秒（对频繁请求增加随机延迟，降低判定风险）
    requestJitterMs?: { min?: number; max?: number };
    // 自动点击 Unlock 限流
    unlock?: {
      enabled?: boolean; // 允许自动点击（默认 true）
      maxClicksPerMinute?: number; // 每分钟最大点击次数（默认 6）
      jitterMs?: { min?: number; max?: number }; // 点击前随机延迟（默认 150~450ms）
      postClickScanLimit?: number; // 点击后扫描的最近消息条数上限（默认 20）
    };
    // 降低历史扫描风险
    historyScan?: {
      enabled?: boolean; // 默认为继承顶层 historyScan.enabled，可单独关闭
      missingAccessCooldownMs?: number; // 某目标频道 Missing Access 后的冷却时间（默认 3600000 = 1h）
    };
  };
  activeBlocks?: Partial<Record<ActiveCategory, ActiveCategoryConfig>>;
  activePersonas?: Record<string, ActivePersonaConfig>;
  // webhook 消息的非真实 reply 回退策略。
  // 默认 body_embed_only：
  // - 只有“正文 + embed”的 webhook 消息会转成伪回复样式
  // - 先按正文匹配当前目标频道里更早的同正文消息
  // - 如果正文找不到，再按 embed 描述匹配更早的同内容消息
  // - 如果两者都找不到，则按普通正文 + embed 转发，不补锚点
  // real_reply_only：只有 Discord 原生 reply 才渲染为两层回复样式。
  // legacy：保留旧行为，允许把“embed 作为被回复内容、正文作为回复内容”的老式伪回复继续发出去。
  webhookReplyFallbackMode?: "real_reply_only" | "body_embed_only" | "legacy";
  // 表情符号映射：将 :Long:, :Short: 等转换为 Discord 自定义表情符号格式
  // 格式: { "long": "1234567890123456789", "short": "9876543210987654321" }
  // 如果配置了 ID，会转换为 <:Long:1234567890123456789> 格式
  // 如果没有配置，则保持 :Long: 格式
  //
  // ⚠️ 重要提示：
  // - 表情符号 ID 必须来自 webhook 目标所在的服务器
  // - 如果使用其他服务器的表情符号 ID，消息会发送成功但表情符号无法显示（会显示为 :name: 文本）
  // - 获取方法：在目标服务器中找到表情符号，右键复制，会得到 <:name:id> 格式，提取其中的 ID
  emojiIds?: Record<string, string>;
}

export async function getConfig(): Promise<Config> {
  if (!existsSync("./config.json")) {
    const defaultConfig = JSON.stringify({
      channelWebhooks: {},
      allowedGuildsIds: [],
      mutedGuildsIds: [],
      allowedChannelsIds: [],
      mutedChannelsIds: [],
      allowedUsersIds: [],
      mutedUsersIds: [],
      channelConfigs: {},
      showDate: false,
      showChat: true,
      stackMessages: false,
      showMessageUpdates: false,
      showMessageDeletions: false,
      replacementsDictionary: {},
      historyScan: { enabled: true },
      activeBlocks: {},
      activePersonas: {}
    } satisfies Config);

    // Simple JSON formatting (2 spaces indent)
    const formattedDefaultConfig =
      JSON.stringify(JSON.parse(defaultConfig), null, 2) + "\n";

    await writeFile("./config.json", formattedDefaultConfig);
  }

  const configString = await readFile("./config.json");
  const config: Config = JSON.parse(configString.toString());

  const idTypes = [
    config.mutedGuildsIds,
    config.allowedGuildsIds,
    config.mutedChannelsIds,
    config.allowedChannelsIds,
    config.allowedUsersIds,
    config.mutedUsersIds,
    ...(config.channelConfigs
      ? Object.keys(config.channelConfigs).flatMap((key) => [
          config.channelConfigs![key].allowed,
          config.channelConfigs![key].muted
        ])
      : [])
  ];

  const activeBlocks = Object.values(config.activeBlocks ?? {});
  const activePersonas = Object.values(config.activePersonas ?? {});
  for (const block of activeBlocks) {
    if (!block) continue;
    const ids =
      block.sourceChannelIds ??
      (block.sourceChannelId ? [block.sourceChannelId] : []);
    idTypes.push(ids);
  }
  for (const persona of activePersonas) {
    idTypes.push(
      [
        persona.userId,
        persona.identityRoleId,
        persona.jumpChannelId,
        persona.sourceChannelId
      ].filter((id): id is ChannelId => Boolean(id))
    );
  }

  testIDsType(idTypes.filter((ids) => ids != undefined).flat());

  return config;
}

export function testIDsType(ids: ChannelId[]) {
  for (const id of ids) {
    if (typeof id != "string") {
      console.warn(
        `${id} is not a string! This could lead to errors when matching ids. Please input strings in "${id}" format (with quotes)`
      );
    }
  }
}
