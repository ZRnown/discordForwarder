import { Message, PartialMessage } from "discord.js-selfbot-v13";

import { ChannelId, Config } from "./config.js";

export function isAllowedByConfig(
  message: Message<boolean> | PartialMessage,
  config: Config
): boolean {
  const allowedUsers = [
    ...(config.allowedUsersIds ?? []),
    ...(config.channelConfigs?.[message.channel.id]?.allowed ?? [])
  ];

  const mutedUsers = [
    ...(config.mutedUsersIds ?? []),
    ...(config.channelConfigs?.[message.channel.id]?.muted ?? [])
  ];

  return (
    // Guild check
    (!message.guildId ||
      isInAllowedIds(message.guildId, config.allowedGuildsIds)) &&
    (!message.guildId ||
      isNotInMutedIds(message.guildId, config.mutedGuildsIds)) &&
    // Channel check
    isInAllowedIds(message.channelId, config.allowedChannelsIds) &&
    isNotInMutedIds(message.channelId, config.mutedChannelsIds) &&
    // Author check
    (!message.author || isInAllowedIds(message.author.id, allowedUsers)) &&
    (!message.author || isNotInMutedIds(message.author.id, mutedUsers))
  );
}

export function isNotInMutedIds(id: string, mutedIds: ChannelId[] = []) {
  return (
    mutedIds.length == 0 ||
    !(mutedIds.includes(id) || mutedIds.includes(Number(id)))
  );
}

export function isInAllowedIds(id: string, allowedIds: ChannelId[] = []) {
  return (
    allowedIds.length == 0 ||
    allowedIds.includes(id) ||
    allowedIds.includes(Number(id))
  );
}
