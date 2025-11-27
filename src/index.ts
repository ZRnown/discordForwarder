import { Client as SelfBotClient } from "discord.js-selfbot-v13";

import { Bot, Client } from "./bot.js";
import { getConfig } from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";

const env = getEnv();
const config = await getConfig();

// Build mapping from source channel IDs to webhook URLs
const senderBotsBySource = new Map<string, SenderBot>();
const senderBotsByWebhook = new Map<string, SenderBot>();
let defaultSenderBot: SenderBot | undefined;
const prepares: Promise<any>[] = [];

const ensureSenderBot = (webhookUrl: string) => {
  let existing = senderBotsByWebhook.get(webhookUrl);
  if (existing) return existing;
  const sb = new SenderBot({
    chatsToSend: [],
    replacementsDictionary: config.replacementsDictionary,
    webhookUrl
  });
  senderBotsByWebhook.set(webhookUrl, sb);
  prepares.push(sb.prepare());
  return sb;
};

// 1) Base mapping from channelWebhooks
if (config.channelWebhooks && Object.keys(config.channelWebhooks).length > 0) {
  for (const [channelId, webhookUrl] of Object.entries(config.channelWebhooks)) {
    const sb = ensureSenderBot(webhookUrl);
    senderBotsBySource.set(channelId, sb);
    if (!defaultSenderBot) defaultSenderBot = sb;
  }
}

// 2) Pre-warm SenderBot instances defined via active blocks
const activeBlocks = Object.values(config.activeBlocks ?? {});
for (const block of activeBlocks) {
  if (!block?.targetWebhook) continue;
  ensureSenderBot(block.targetWebhook);
}

if (!defaultSenderBot) {
  throw new Error("At least one webhook must be configured via channelWebhooks.");
}

await Promise.all(prepares);

// Output webhook info to help configure historyScan.channels
{
  const seen = new Set<SenderBot>();
  for (const sb of senderBotsBySource.values()) {
    if (seen.has(sb)) continue;
    seen.add(sb);
    try {
      console.log(`[webhook] guild_id=${sb.webhookGuildId || "-"} channel_id=${sb.defaultChannelId || "-"}`);
    } catch {}
  }
}

const client: Client = new SelfBotClient();

const bot = new Bot(client, config, defaultSenderBot!, senderBotsBySource, senderBotsByWebhook);

bot.client.login(env.DISCORD_TOKEN);
