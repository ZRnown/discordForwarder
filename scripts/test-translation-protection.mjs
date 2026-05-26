import assert from "node:assert/strict";

import { protectMentionLikeTokensForTranslation } from "../dist/translationProtection.js";

const protectedTokens = protectMentionLikeTokensForTranslation(
  ":Long: Long: XMR | Risk: 2.5% @🧿astekz @🚀│wg-trades"
);

assert.equal(
  protectedTokens.text,
  ":Long: Long: XMR | Risk: 2.5% __MENTION_0__ __MENTION_1__"
);

assert.equal(
  protectedTokens.restore(":Long: 多头： 门罗币 | 风险： 2.5% __MENTION_0__ __MENTION_1__"),
  ":Long: 多头： 门罗币 | 风险： 2.5% @🧿astekz @🚀│wg-trades"
);
