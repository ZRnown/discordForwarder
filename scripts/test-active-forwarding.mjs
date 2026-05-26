import assert from "node:assert/strict";

import {
  buildActiveDedupKey,
  buildActiveSlotSourceId,
  buildActiveSlotSourceIdsForScope,
  normalizeActiveDedupText,
  partitionActivePreparedMessagesForEdit,
  runActiveSourceQueued
} from "../dist/activeForwarding.js";

const senderA = { name: "main" };
const senderB = { name: "thread-a", threadName: "muzzagin" };
const senderC = { name: "thread-b", threadName: "woods" };
const senderD = { name: "upload" };
const targets = new Map([
  [
    "main",
    { channelId: "1400068611044802621", messageId: "1506579700074549248" }
  ],
  [
    "thread-a",
    { channelId: "1506590874589593620", messageId: "1507000000000000001" }
  ],
  [
    "upload",
    { channelId: "1506590915765211196", messageId: "1507000000000000002" }
  ]
]);

const plan = partitionActivePreparedMessagesForEdit(
  "1481016414331732039",
  [
    {
      sender: senderA,
      item: { content: "spot strategy", useEmbed: true, uploads: [] }
    },
    {
      sender: senderB,
      item: { content: "futures strategy", useEmbed: true, uploads: [] }
    },
    {
      sender: senderC,
      item: { content: "new thread target", useEmbed: true, uploads: [] }
    },
    {
      sender: senderD,
      item: {
        content: "upload must be sent again",
        useEmbed: false,
        uploads: [{ url: "https://example.com/a.png", filename: "a.png" }]
      }
    }
  ],
  (_sourceMessageId, sender) => targets.get(sender.name)
);

assert.deepEqual(
  plan.editable.map(({ prepared, target }) => [
    prepared.sender.name,
    target.channelId,
    target.messageId
  ]),
  [
    ["main", "1400068611044802621", "1506579700074549248"]
  ]
);
assert.deepEqual(
  plan.sendable.map(({ sender }) => sender.name),
  ["thread-a", "thread-b", "upload"]
);

const tooLong = partitionActivePreparedMessagesForEdit(
  "1481016414331732039",
  [
    {
      sender: senderA,
      item: { content: "x".repeat(4097), useEmbed: true, uploads: [] }
    }
  ],
  (_sourceMessageId, sender) => targets.get(sender.name)
);

assert.equal(tooLong.editable.length, 0);
assert.equal(tooLong.sendable.length, 1);

assert.equal(
  buildActiveSlotSourceId(
    "futures",
    "webhook:https://example.com/hook:thread:1506590874589593620"
  ),
  "active-slot:futures:webhook:https://example.com/hook:thread:1506590874589593620"
);

const muzzaginSlotIds = buildActiveSlotSourceIdsForScope("futures", {
  webhookUrl: "https://example.com/forum",
  threadName: "muzzagin",
  remark: "activeBlocks thread: muzzagin"
});
const woodsSlotIds = buildActiveSlotSourceIdsForScope("futures", {
  webhookUrl: "https://example.com/forum",
  threadName: "woods",
  remark: "activeBlocks thread: woods"
});

assert.equal(
  muzzaginSlotIds.includes(
    "active-slot:futures:webhook:https://example.com/forum"
  ),
  false
);
assert.equal(
  woodsSlotIds.includes(
    "active-slot:futures:webhook:https://example.com/forum"
  ),
  false
);
assert.deepEqual(
  muzzaginSlotIds.filter((slotId) => woodsSlotIds.includes(slotId)),
  []
);

const events = [];
let releaseFirst;
const first = runActiveSourceQueued("futures:1481016407201415179", async () => {
  events.push("first-start");
  await new Promise((resolve) => {
    releaseFirst = resolve;
  });
  events.push("first-end");
});
const second = runActiveSourceQueued(
  "futures:1481016407201415179",
  async () => {
    events.push("second-start");
  }
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(events, ["first-start"]);
releaseFirst();
await Promise.all([first, second]);
assert.deepEqual(events, ["first-start", "first-end", "second-start"]);

const activeTextWithNamedEmoji =
  "⁠🏌｜tareeq\n<:Long:1446387197128212530> HYPE | 入场价: 64.412 | 止损价: 63.01";
const activeTextWithRawEmoji =
  "⁠🏌｜tareeq\n:Long: HYPE | 入场价: 64.412 | 止损价: 63.01";

assert.equal(
  normalizeActiveDedupText(activeTextWithNamedEmoji),
  normalizeActiveDedupText(activeTextWithRawEmoji)
);

assert.notEqual(
  normalizeActiveDedupText(activeTextWithRawEmoji),
  normalizeActiveDedupText(
    "⁠🏌｜tareeq\n:Long: HYPE | 入场价: 64.5 | 止损价: 63.01"
  )
);

assert.equal(
  normalizeActiveDedupText(
    ":Long: HYPE | 入场价: 64.412 @🏌tareeq @🚀│wg-trades"
  ),
  normalizeActiveDedupText(
    "<:Long:1446387197128212530> HYPE | 入场价: 64.412 <#1400068692410110053> <#1400068611044802621>"
  )
);

assert.equal(
  buildActiveDedupKey("futures", ["Tareeq"], "1481016469004488797"),
  buildActiveDedupKey("futures", ["Tareeq"], "1481016470000000000")
);
assert.notEqual(
  buildActiveDedupKey("futures", ["Tareeq"], "1481016469004488797"),
  buildActiveDedupKey("spot", ["Tareeq"], "1481016469004488797")
);
