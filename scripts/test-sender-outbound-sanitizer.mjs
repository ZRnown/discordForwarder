import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";

import { SenderBot } from "../dist/senderBot.js";

const originalRequest = https.request;
const capturedWrites = [];

https.request = (options, callback) => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = (chunk) => {
    capturedWrites.push(String(chunk));
  };
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.statusMessage = "OK";
    callback(res);
    queueMicrotask(() => {
      res.emit("data", Buffer.from('{"id":"150","channel_id":"1484167073939718404"}'));
      res.emit("end");
    });
  };
  req.destroy = (err) => req.emit("error", err);
  return req;
};

try {
  const sender = new SenderBot({
    chatsToSend: [],
    webhookUrl: "https://discord.com/api/webhooks/1/token",
    clickableAliasPersonas: [
      { keyword: "michele", jumpChannelId: "1399730201533087776" }
    ],
    clickableAliasChannels: [
      { keyword: "wg-trades", channelId: "1484167073939718404" }
    ]
  });
  sender.defaultChannelId = "1484167073939718404";

  const raw =
    ":Spot: Long: ZEC | Entry: 662.71 | SL: 617.64 @🏹michele @🚀│wg-trades\n-----------\n:Spot: 多头： ZEC | 入场价： 662.71 | 止损价： 617.64 @🏹michele @🚀│wg-trades";

  await sender.editWebhookMessage("1500000000000000000", {
    allowed_mentions: { parse: [], replied_user: false },
    content: "",
    embeds: [{ description: raw }]
  });

  const sentBody = JSON.parse(capturedWrites.at(-1));
  assert.equal(
    sentBody.embeds[0].description,
    ":Spot: Long: ZEC | Entry: 662.71 | SL: 617.64 <#1399730201533087776> <#1484167073939718404>\n-----------\n:Spot: 多头： ZEC | 入场价： 662.71 | 止损价： 617.64 <#1399730201533087776> <#1484167073939718404>"
  );
} finally {
  https.request = originalRequest;
}
