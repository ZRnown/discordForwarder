import assert from "node:assert/strict";

import { rewriteClickableAliases } from "../dist/clickableAliases.js";

const personas = [
  { keyword: "michele", jumpChannelId: "1399730201533087776" },
  { keyword: "Tareeq", jumpChannelId: "1399730222185713724" },
  { keyword: "astekz", jumpChannelId: "1400070282701701120" }
];

assert.equal(
  rewriteClickableAliases(":Short: BTC @🏹michele @🚀│wg-trades", {
    personas,
    channelAliases: [{ keyword: "wg-trades", channelId: "1400068634151485440" }]
  }),
  ":Short: BTC <#1399730201533087776> <#1400068634151485440>"
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
