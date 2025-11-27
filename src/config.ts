import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import prettier from "prettier";

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
  keyword?: string;
  channelButtonLabel?: string;
}

export interface ActiveCategoryConfig {
  sourceChannelIds?: ChannelId[];
  sourceChannelId?: ChannelId;
  targetWebhook: string;
  matchStrategy?: "keyword" | "role" | "auto";
}

export interface Config {
  // 映射：源频道ID -> 目标Webhook URL（一对一）
  channelWebhooks?: Record<string, string>;
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
      enabled?: boolean;             // 允许自动点击（默认 true）
      maxClicksPerMinute?: number;   // 每分钟最大点击次数（默认 6）
      jitterMs?: { min?: number; max?: number }; // 点击前随机延迟（默认 150~450ms）
      postClickScanLimit?: number;   // 点击后扫描的最近消息条数上限（默认 20）
    };
    // 降低历史扫描风险
    historyScan?: {
      enabled?: boolean;             // 默认为继承顶层 historyScan.enabled，可单独关闭
      missingAccessCooldownMs?: number; // 某目标频道 Missing Access 后的冷却时间（默认 3600000 = 1h）
    };
  };
  activeBlocks?: Partial<Record<ActiveCategory, ActiveCategoryConfig>>;
  activePersonas?: Record<string, ActivePersonaConfig>;
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

    const formattedDefaultConfig = await prettier.format(defaultConfig, {
      parser: "json"
    });

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
    ...Object.keys(config.channelConfigs ?? {}).flatMap((key) => [
      config.channelConfigs[key].allowed,
      config.channelConfigs[key].muted
    ])
  ];

  const activeBlocks = Object.values(config.activeBlocks ?? {});
  const activePersonas = Object.values(config.activePersonas ?? {});
  for (const block of activeBlocks) {
    if (!block) continue;
    const ids = block.sourceChannelIds ?? (block.sourceChannelId ? [block.sourceChannelId] : []);
    idTypes.push(ids);
  }
  for (const persona of activePersonas) {
    idTypes.push(
      [persona.userId, persona.identityRoleId, persona.jumpChannelId].filter(
        (id): id is ChannelId => Boolean(id)
      )
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
