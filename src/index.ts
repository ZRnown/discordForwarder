import { Client as BotClient, GatewayIntentBits } from "discord.js";
import { Client as SelfBotClient } from "discord.js-selfbot-v13";

import { Bot, Client } from "./bot.js";
import { getConfig } from "./config.js";
import { BotBackend, getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { ProxyAgent } from "proxy-agent";

const env = getEnv();
const config = await getConfig();

const agent = env.PROXY_URL
  ? new ProxyAgent({
      getProxyForUrl: () => env.PROXY_URL
    })
  : undefined;

if (env.DISCORD_WEBHOOK_URL) {
  const match = env.DISCORD_WEBHOOK_URL.match(/webhooks\/(\d+)\//);
  if (match) config.mutedUsersIds?.push(match[1]);
}

const senderBot = new SenderBot({
  chatsToSend: [],
  replacementsDictionary: config.replacementsDictionary,
  webhookUrl: env.DISCORD_WEBHOOK_URL,
  httpAgent: agent
});

senderBot.prepare();

const client: Client = (() => {
  switch (env.DISCORD_BOT_BACKEND) {
    case BotBackend.Bot:
      return new BotClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMessages
        ]
      });
    case BotBackend.Selfbot:
      return new SelfBotClient(
        env.PROXY_URL !== undefined && agent !== undefined
          ? {
              ws: {
                agent
              },
              http: {
                agent: {
                  uri: env.PROXY_URL
                }
              }
            }
          : undefined
      );
  }
})();

const bot = new Bot(client, config, senderBot);

bot.client.login(env.DISCORD_TOKEN);
