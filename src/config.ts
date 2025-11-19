import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import prettier from "prettier";

export type ChannelId = number | string;
export type ChatId = ChannelId;

export interface ChannelConfig {
  muted: ChannelId[];
  allowed: ChannelId[];
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
  specialChannels?: Array<{
    sourceChannelId: string;
    rule: "tradeSignal";
    title?: string;
    skipTranslation?: boolean;
    disableAttachments?: boolean;
    useEmbed?: boolean;
    webhookUrl?: string;
    traderToTarget?: Record<string, { channelId: string; guildId?: string; sourceUserId?: string; roleIds?: string[] }>;
    fallbackTraderLink?: "mention" | "url" | "text";
  }>;
  historyScan?: {
    enabled?: boolean;
    limit?: number;
    channels?: string[];
  };
  logging?: {
    specialOnly?: boolean;
    filterPattern?: string; // optional custom regex, overrides specialOnly default pattern
  };
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
      historyScan: { enabled: true }
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
