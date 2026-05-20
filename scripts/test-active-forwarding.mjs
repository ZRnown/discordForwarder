import assert from "node:assert/strict";

import {
  buildActiveSlotSourceId,
  partitionActivePreparedMessagesForEdit
} from "../dist/activeForwarding.js";

const senderA = { name: "main" };
const senderB = { name: "thread-a" };
const senderC = { name: "thread-b" };
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
    ["main", "1400068611044802621", "1506579700074549248"],
    ["thread-a", "1506590874589593620", "1507000000000000001"]
  ]
);
assert.deepEqual(
  plan.sendable.map(({ sender }) => sender.name),
  ["thread-b", "upload"]
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
