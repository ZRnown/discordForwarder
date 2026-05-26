import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { Bot } from "../dist/bot.js";
import { SenderBot } from "../dist/senderBot.js";

const editCalls = [];
const sender = new SenderBot({
  chatsToSend: [],
  webhookUrl: "https://discord.com/api/webhooks/1484167152188526623/token",
  clickableAliasPersonas: [
    { keyword: "tareeq", jumpChannelId: "1399730222185713724" },
    { keyword: "woods", jumpChannelId: "1400070271074828368" }
  ],
  clickableAliasChannels: [
    { keyword: "wg-trades", channelId: "1484167073939718404" }
  ]
});
sender.defaultChannelId = "1484167073939718404";
sender.editWebhookMessage = async (messageId, body) => {
  editCalls.push({ messageId, body });
  return {};
};

const senderBotsByWebhook = new Map([[sender.webhookUrl, sender]]);
const client = new EventEmitter();
client.on = client.on.bind(client);
client.onAny = undefined;

const bot = new Bot(
  client,
  {
    channelWebhooks: {},
    activeBlocks: {
      alerts: {
        sourceChannelId: "995298955942441000",
        targetWebhook: sender.webhookUrl,
        matchStrategy: "role"
      }
    },
    activePersonas: {}
  },
  sender,
  new Map(),
  senderBotsByWebhook
);

const message = {
  id: "1508835469096517684",
  channelId: "1484167073939718404",
  webhookId: "1484167152188526623",
  content: "",
  embeds: [
    {
      description:
        ":Long: Long: HYPE | Entry: 64.412 | SL: 63.01 | Risk: 1% @🏌tareeq @🚀│wg-trades\n-----------\n:Long: 多头： HYPE | 入场价： 64.412 | 止损价： 63.01 | 风险： 1% @🏌tareeq @🚀│wg-trades",
      toJSON() {
        return { description: this.description };
      }
    }
  ]
};

const handled = await bot.tryRewriteWebhookAliasMessage(message);
assert.equal(handled, true);
assert.equal(editCalls.length, 1);
assert.equal(editCalls[0].messageId, "1508835469096517684");
assert.equal(
  editCalls[0].body.embeds[0].description,
  ":Long: Long: HYPE | Entry: 64.412 | SL: 63.01 | Risk: 1% <#1399730222185713724> <#1484167073939718404>\n-----------\n:Long: 多头： HYPE | 入场价： 64.412 | 止损价： 63.01 | 风险： 1% <#1399730222185713724> <#1484167073939718404>"
);

const untouched = await bot.tryRewriteWebhookAliasMessage({
  ...message,
  id: "no-change",
  embeds: [{ description: "already <#1399730222185713724>" }]
});
assert.equal(untouched, false);
assert.equal(editCalls.length, 1);

bot.rememberRawGatewayMessage({
  id: "1508861213168111761",
  webhook_id: "1484167152188526623"
});

const handledFromRawWebhookId = await bot.tryRewriteWebhookAliasMessage({
  id: "1508861213168111761",
  channelId: "1484167073939718404",
  content: "",
  embeds: [
    {
      description:
        ":Long: Long: BTC | Entry: 75500 - 75100 | SL: 73500 | Risk: 2.5% @💨woods @🚀│wg-trades\n-----------\n:Long: 多头： BTC | 入场： 75500 - 75100 | 止损： 73500 | 风险： 2.5% @💨woods @🚀│wg-trades",
      toJSON() {
        return { description: this.description };
      }
    }
  ]
});
assert.equal(handledFromRawWebhookId, true);
assert.equal(editCalls.length, 2);
assert.equal(editCalls[1].messageId, "1508861213168111761");
assert.equal(
  editCalls[1].body.embeds[0].description,
  ":Long: Long: BTC | Entry: 75500 - 75100 | SL: 73500 | Risk: 2.5% <#1400070271074828368> <#1484167073939718404>\n-----------\n:Long: 多头： BTC | 入场： 75500 - 75100 | 止损： 73500 | 风险： 2.5% <#1400070271074828368> <#1484167073939718404>"
);

const fetchedMessages = [
  {
    id: "scan-change",
    channelId: "1484167073939718404",
    webhookId: "1484167152188526623",
    content: "",
    embeds: [
      {
        description:
          ":Long: Long: UB | Entry: 0.20622 | SL: 0.2006 | Risk: 0.5% @🏌tareeq @🚀│wg-trades\n-----------\n:Long: 多头： UB | 入场价： 0.20622 | 止损： 0.2006 | 风险： 0.5% @🏌tareeq @🚀│wg-trades",
        toJSON() {
          return { description: this.description };
        }
      }
    ]
  },
  {
    id: "scan-unchanged",
    channelId: "1484167073939718404",
    webhookId: "1484167152188526623",
    content: "",
    embeds: [{ description: "already <#1399730222185713724>" }]
  }
];

client.channels = {
  fetch: async (channelId) => {
    assert.equal(channelId, "1484167073939718404");
    return {
      messages: {
        fetch: async ({ limit }) => {
          assert.equal(limit, 20);
          return new Map(fetchedMessages.map((item) => [item.id, item]));
        }
      }
    };
  }
};

await bot.scanWebhookAliasTargetsOnce();
assert.equal(editCalls.length, 3);
assert.equal(editCalls[2].messageId, "scan-change");
assert.equal(
  editCalls[2].body.embeds[0].description,
  ":Long: Long: UB | Entry: 0.20622 | SL: 0.2006 | Risk: 0.5% <#1399730222185713724> <#1484167073939718404>\n-----------\n:Long: 多头： UB | 入场价： 0.20622 | 止损： 0.2006 | 风险： 0.5% <#1399730222185713724> <#1484167073939718404>"
);
