import assert from "node:assert/strict";
import { partitionActivePreparedMessagesForEdit } from "../dist/activeForwarding.js";

const threadSender = { threadName: "michele" };
const plainSender = {};
const preparedMessages = [
  { sender: threadSender, item: { content: "thread update", useEmbed: true } },
  { sender: plainSender, item: { content: "plain update", useEmbed: true } }
];

const plan = partitionActivePreparedMessagesForEdit(
  "source-message",
  preparedMessages,
  (_sourceMessageId, sender) => ({
    channelId: sender === threadSender ? "1506846697215623168" : "1399730160202420305",
    messageId: sender === threadSender ? "1509012893964832818" : "1508100262479270038"
  })
);

assert.equal(plan.editable.length, 2);
assert.equal(plan.sendable.length, 0);
assert.equal(plan.editable[0].target.messageId, "1509012893964832818");
