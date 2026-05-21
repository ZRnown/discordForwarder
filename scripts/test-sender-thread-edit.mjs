import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const { SenderBot } = await import("../dist/senderBot.js");

const originalRequest = https.request;
const originalCwd = process.cwd();
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sender-thread-edit-"));
const capturedPaths = [];

function createMockResponse(callback) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.statusMessage = "OK";
  res.headers = {};
  process.nextTick(() => {
    callback(res);
    res.emit("data", Buffer.from("{}"));
    res.emit("end");
  });
}

https.request = function mockRequest(options, callback) {
  capturedPaths.push(options.path);
  createMockResponse(callback);

  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => true;
  req.end = () => req;
  req.destroy = (err) => {
    if (err) req.emit("error", err);
  };
  return req;
};

try {
  process.chdir(tmpDir);
  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/webhook_threads.json",
    JSON.stringify({ "1234567890123456789:michele": "1506691482910986342" }),
    "utf8"
  );

  const sender = new SenderBot({
    chatsToSend: [],
    webhookUrl:
      "https://discord.com/api/webhooks/1234567890123456789/test-token",
    threadName: "michele"
  });

  await sender.editWebhookMessage("1506843057201479840", {
    content: "updated"
  });
  await sender.deleteWebhookMessage("1506843057201479840");

  assert.equal(capturedPaths.length, 2);
  assert.match(capturedPaths[0], /\/messages\/1506843057201479840\?/);
  assert.match(capturedPaths[0], /thread_id=1506691482910986342/);
  assert.match(capturedPaths[1], /\/messages\/1506843057201479840\?/);
  assert.match(capturedPaths[1], /thread_id=1506691482910986342/);
} finally {
  https.request = originalRequest;
  process.chdir(originalCwd);
}
