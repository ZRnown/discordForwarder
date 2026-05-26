import assert from "node:assert/strict";
import fs from "node:fs";

import { SenderBot } from "../dist/senderBot.js";

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const personas = Object.entries(config.activePersonas || {}).map(
  ([key, persona]) => ({
    keyword: persona.keyword || key,
    identityRoleId: persona.identityRoleId,
    jumpChannelId: persona.jumpChannelId
  })
);

const sender = new SenderBot({
  chatsToSend: [],
  webhookUrl: "https://discord.com/api/webhooks/1/token",
  clickableAliasPersonas: personas,
  clickableAliasChannels: [
    { keyword: "wg-trades", channelId: "1399730160202420305" },
    { keyword: "wg-trades", channelId: "1484167073939718404" }
  ]
});

sender.defaultChannelId = "1484167073939718404";

const payload = sender.buildWebhookBody({
  content:
    ":Long: Long: NIL | Entry: 0.08479 | SL: 0.0804 | Risk: 0.5% @🏌tareeq @🚀│wg-trades\n-----------\n:Long: 多头： 无 | 入场价： 0.08479 | 止损价： 0.0804 | 风险： 0.5% @🏌tareeq @🚀│wg-trades",
  useEmbed: true
});

assert.equal(
  payload.embeds[0].description,
  ":Long: Long: NIL | Entry: 0.08479 | SL: 0.0804 | Risk: 0.5% <#1399730222185713724> <#1484167073939718404>\n-----------\n:Long: 多头： 无 | 入场价： 0.08479 | 止损价： 0.0804 | 风险： 0.5% <#1399730222185713724> <#1484167073939718404>"
);

const astekzPayload = sender.buildWebhookBody({
  content:
    ":Long: Long: ZEC | Entry: 616.551 | SL: 604.017 | Risk: 2.5% @🧿astekz @🚀│wg-trades\n-----------\n:Long: 多头： ZEC | 入场价： 616.551 | 止损价： 604.017 | 风险： 2.5% @🧿astekz @🚀│wg-trades",
  useEmbed: true
});

assert.equal(
  astekzPayload.embeds[0].description,
  ":Long: Long: ZEC | Entry: 616.551 | SL: 604.017 | Risk: 2.5% <#1400070282701701120> <#1484167073939718404>\n-----------\n:Long: 多头： ZEC | 入场价： 616.551 | 止损价： 604.017 | 风险： 2.5% <#1400070282701701120> <#1484167073939718404>"
);

const muzzaginPayload = sender.buildWebhookBody({
  content:
    ":Long: Long: BTC | Entry: 74800 − 73900 − 72200 | SL: 2x 5m＜71800 | Risk: 2% @🍑muzzagin @🚀│wg-trades\n-----------\n:Long: 多头： BTC | 入场： 74800 − 73900 − 72200 | 止损： 2倍5分钟线＜71800 | 风险： 2% @🍑muzzagin @🚀│wg-trades",
  useEmbed: true
});

assert.equal(
  muzzaginPayload.embeds[0].description,
  ":Long: Long: BTC | Entry: 74800 − 73900 − 72200 | SL: 2x 5m＜71800 | Risk: 2% <#1399730231916363877> <#1484167073939718404>\n-----------\n:Long: 多头： BTC | 入场： 74800 − 73900 − 72200 | 止损： 2倍5分钟线＜71800 | 风险： 2% <#1399730231916363877> <#1484167073939718404>"
);

for (const persona of personas) {
  assert.ok(
    persona.keyword,
    `activePersona missing keyword: ${JSON.stringify(persona)}`
  );
  assert.ok(
    persona.jumpChannelId,
    `activePersona ${persona.keyword} missing jumpChannelId`
  );

  const aliasPayload = sender.buildWebhookBody({
    content: `:Long: Long: TEST | Entry: 1 | SL: 0.9 | Risk: 1% @🏷${persona.keyword} @🚀│wg-trades`,
    useEmbed: true
  });
  const description = aliasPayload.embeds[0].description;
  assert.ok(
    description.includes(`<#${persona.jumpChannelId}>`),
    `${persona.keyword} was not rewritten to <#${persona.jumpChannelId}>: ${description}`
  );
  assert.ok(
    description.includes("<#1484167073939718404>"),
    `wg-trades was not scoped to alerts channel for ${persona.keyword}: ${description}`
  );
  assert.ok(
    !description.includes(`@🏷${persona.keyword}`),
    `${persona.keyword} raw alias remained: ${description}`
  );
}

const spotSender = new SenderBot({
  chatsToSend: [],
  webhookUrl: "https://discord.com/api/webhooks/2/token",
  clickableAliasPersonas: personas,
  clickableAliasChannels: [
    { keyword: "wg-trades", channelId: "1484167073939718404" },
    { keyword: "wg-spot", channelId: "1399730181798629456" }
  ]
});
spotSender.defaultChannelId = "1399730181798629456";

const spotPayload = spotSender.buildWebhookBody({
  content:
    ":Spot: Long: LPT | Entry: 2.33 - 2.2 | SL: 1D<2.03 @🎯eli @🚀│wg-trades\n-----------\n:Spot: 多头： LPT | 入场： 2.33 - 2.2 | 止损： 1D<2.03 @🎯eli @🚀│wg-trades",
  useEmbed: true
});

assert.equal(
  spotPayload.embeds[0].description,
  ":Spot: Long: LPT | Entry: 2.33 - 2.2 | SL: 1D<2.03 <#1400070259414794341> <#1484167073939718404>\n-----------\n:Spot: 多头： LPT | 入场： 2.33 - 2.2 | 止损： 1D<2.03 <#1400070259414794341> <#1484167073939718404>"
);

const rolePayload = sender.buildWebhookBody({
  content:
    "<:Long:1446387197128212530>[**ZEC**](https://discord.com/channels/1392077606630981712/1400070271074828368): Stopped out • Realized R/R: -1.00 <@&913787442719498250>",
  useEmbed: true
});

assert.equal(
  rolePayload.embeds[0].description,
  "<:Long:1446387197128212530>[**ZEC**](https://discord.com/channels/1392077606630981712/1400070271074828368): Stopped out • Realized R/R: -1.00 <#1400070271074828368>"
);
