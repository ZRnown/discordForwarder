import assert from "node:assert/strict";
import fs from "node:fs";

import { rewriteClickableAliases } from "../dist/clickableAliases.js";

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const futuresChannelId =
  process.env.TEST_FUTURES_CHANNEL_ID ||
  config.activeBlocks?.futures?.targetChannelId ||
  "1399730160202420305";
const alertsChannelId =
  process.env.TEST_ALERTS_CHANNEL_ID ||
  config.activeBlocks?.alerts?.targetChannelId ||
  "1484167073939718404";

const personas = [
  { keyword: "michele", jumpChannelId: "1399730201533087776" },
  { keyword: "Tareeq", jumpChannelId: "1399730222185713724" },
  { keyword: "astekz", jumpChannelId: "1400070282701701120" }
];

assert.equal(
  rewriteClickableAliases(":Short: BTC @🏹michele @🚀│wg-trades", {
    personas,
    channelAliases: [{ keyword: "wg-trades", channelId: futuresChannelId }]
  }),
  `:Short: BTC <#1399730201533087776> <#${futuresChannelId}>`
);

assert.equal(
  rewriteClickableAliases("Entry update @🏌｜Tareeq @🧿astekz", {
    personas
  }),
  "Entry update <#1399730222185713724> <#1400070282701701120>"
);

assert.equal(
  rewriteClickableAliases("Already linked <#1399730201533087776> @unknown", {
    personas
  }),
  "Already linked <#1399730201533087776> @unknown"
);

assert.equal(
  rewriteClickableAliases(
    ":Long: Long: XMR | Entry: 385 | SL: 363.92 | Risk: 2.5% @🧿astekz @🚀│wg-trades\n-----------\n:Long: 多头： 门罗币 | 入场价： 385 | 止损价： 363.92 | 风险： 2.5% @🧿astekz @🚀│wg-trades",
    {
      personas,
      channelAliases: [
        { keyword: "wg-trades", channelId: futuresChannelId }
      ]
    }
  ),
  `:Long: Long: XMR | Entry: 385 | SL: 363.92 | Risk: 2.5% <#1400070282701701120> <#${futuresChannelId}>\n-----------\n:Long: 多头： 门罗币 | 入场价： 385 | 止损价： 363.92 | 风险： 2.5% <#1400070282701701120> <#${futuresChannelId}>`
);

assert.equal(
  rewriteClickableAliases(
    ":Long: Long: BSB | Entry: 1.34565 | SL: 1.27 | Risk: 0.5% @🏌tareeq @🚀│wg-trades\n-----------\n:Long: 多头： BSB | 入场价： 1.34565 | 止损： 1.27 | 风险： 0.5% @🏌tareeq @🚀│wg-trades",
    {
      personas,
      channelAliases: [{ keyword: "wg-trades", channelId: alertsChannelId }]
    }
  ),
  `:Long: Long: BSB | Entry: 1.34565 | SL: 1.27 | Risk: 0.5% <#1399730222185713724> <#${alertsChannelId}>\n-----------\n:Long: 多头： BSB | 入场价： 1.34565 | 止损： 1.27 | 风险： 0.5% <#1399730222185713724> <#${alertsChannelId}>`
);
