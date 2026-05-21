import https from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import { ChannelId } from "./config.js";

const webhookInfoCache = new Map<
  string,
  Promise<{ guild_id?: string; channel_id?: string }>
>();
const webhookThreadCreateQueues = new Map<string, Promise<void>>();

export class SenderBot {
  // 保留以兼容旧接口，Webhook 模式不使用
  chatsToSend: ChannelId[];
  replacementsDictionary: Record<string, string> = {};
  emojiMap: Record<
    string,
    string | { id: string; name?: string; animated?: boolean }
  > = {};

  webhookUrl: string;
  httpAgent?: unknown;
  webhookGuildId?: string;
  defaultChannelId?: string;
  // Optional human-readable remark and avatar override for messages sent through this webhook
  remark?: string;
  displayName?: string;
  avatarUrl?: string;
  threadId?: string;
  threadName?: string;
  private threadIdLoaded = false;
  private webhookRequestQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    chatsToSend: ChannelId[];
    replacementsDictionary?: Record<string, string>;
    webhookUrl: string;
    httpAgent?: unknown; // 由 proxy-agent 创建的 Agent，可选
    remark?: string;
    displayName?: string;
    avatarUrl?: string;
    threadId?: string;
    threadName?: string;
    emojiMap?: Record<
      string,
      string | { id: string; name?: string; animated?: boolean }
    >;
  }) {
    this.chatsToSend = options.chatsToSend;
    this.replacementsDictionary = options.replacementsDictionary || {};
    this.emojiMap = options.emojiMap || {};
    this.webhookUrl = options.webhookUrl;
    this.httpAgent = options.httpAgent;
    this.remark = options.remark;
    this.displayName = options.displayName;
    this.avatarUrl = options.avatarUrl;
    this.threadId = options.threadId;
    this.threadName = options.threadName;
  }

  private rewriteOutgoingText(text: string): string {
    let rewritten = text || "";
    for (const [a, b] of Object.entries(this.replacementsDictionary)) {
      rewritten = rewritten.replaceAll(a, b);
    }
    return this.rewriteCustomEmojisInText(rewritten);
  }

  private resolveEmojiReplacement(
    mapping: string | { id: string; name?: string; animated?: boolean },
    fallback: { name: string; animated: boolean }
  ): string | undefined {
    if (typeof mapping === "string") {
      const trimmed = mapping.trim();
      if (!trimmed) {
        return undefined;
      }
      if (/^<a?:[A-Za-z0-9_~+.-]+:\d+>$/.test(trimmed)) {
        return trimmed;
      }
      if (/^\d+$/.test(trimmed)) {
        return `<${fallback.animated ? "a" : ""}:${fallback.name}:${trimmed}>`;
      }
      return undefined;
    }

    const id = String(mapping.id || "").trim();
    if (!/^\d+$/.test(id)) {
      return undefined;
    }
    const name = String(mapping.name || fallback.name || "").trim();
    if (!name) {
      return undefined;
    }
    const animated =
      typeof mapping.animated === "boolean"
        ? mapping.animated
        : fallback.animated;
    return `<${animated ? "a" : ""}:${name}:${id}>`;
  }

  private findEmojiMappingValue(candidates: string[]) {
    for (const candidate of candidates) {
      const mapping = this.emojiMap[candidate];
      if (mapping) {
        return mapping;
      }
    }
    return undefined;
  }

  private rewriteCustomEmojisInText(text: string): string {
    let rewritten = text || "";
    if (!rewritten || Object.keys(this.emojiMap).length === 0) {
      return rewritten;
    }

    rewritten = rewritten.replace(
      /<a?:([A-Za-z0-9_~+.-]+):(\d+)>/g,
      (fullMatch, name, sourceId) => {
        const animated = fullMatch.startsWith("<a:");
        const mapping = this.findEmojiMappingValue([
          fullMatch,
          sourceId,
          `:${name}:`,
          name
        ]);
        if (!mapping) {
          return fullMatch;
        }
        return (
          this.resolveEmojiReplacement(mapping, { name, animated }) || fullMatch
        );
      }
    );

    rewritten = rewritten.replace(
      /(^|[^<\w])(:[A-Za-z0-9_~+.-]+:)(?!\d+>)/g,
      (fullMatch, prefix, alias) => {
        const name = alias.slice(1, -1);
        const mapping = this.findEmojiMappingValue([alias, name]);
        if (!mapping) {
          return fullMatch;
        }
        const replacement = this.resolveEmojiReplacement(mapping, {
          name,
          animated: false
        });
        if (!replacement) {
          return fullMatch;
        }
        return `${prefix}${replacement}`;
      }
    );

    return rewritten;
  }

  private rewriteOutgoingEmbeds(embeds?: any[]) {
    if (!Array.isArray(embeds)) {
      return embeds;
    }

    return embeds.map((embed) => {
      if (!embed || typeof embed !== "object") {
        return embed;
      }

      const next = { ...embed };
      if (typeof next.title === "string") {
        next.title = this.rewriteOutgoingText(next.title);
      }
      if (typeof next.description === "string") {
        next.description = this.rewriteOutgoingText(next.description);
      }
      if (
        next.footer &&
        typeof next.footer === "object" &&
        typeof next.footer.text === "string"
      ) {
        next.footer = {
          ...next.footer,
          text: this.rewriteOutgoingText(next.footer.text)
        };
      }
      if (
        next.author &&
        typeof next.author === "object" &&
        typeof next.author.name === "string"
      ) {
        next.author = {
          ...next.author,
          name: this.rewriteOutgoingText(next.author.name)
        };
      }
      if (Array.isArray(next.fields)) {
        next.fields = next.fields.map((field: any) => {
          if (!field || typeof field !== "object") {
            return field;
          }
          return {
            ...field,
            ...(typeof field.name === "string"
              ? { name: this.rewriteOutgoingText(field.name) }
              : {}),
            ...(typeof field.value === "string"
              ? { value: this.rewriteOutgoingText(field.value) }
              : {})
          };
        });
      }
      return next;
    });
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private enqueueWebhookRequest<T>(operation: () => Promise<T>) {
    const run = this.webhookRequestQueue.then(operation, operation);
    this.webhookRequestQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private parseRetryAfterMs(value: unknown) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    return Math.max(50, Math.ceil(numeric * 1000));
  }

  private buildWebhookRequestError(
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: string;
      headers?: Record<string, string | string[] | undefined>;
    }
  ) {
    const error = new Error(message) as Error & {
      statusCode?: number;
      retryAfterMs?: number;
      responseBody?: string;
    };
    error.statusCode = options?.statusCode;
    error.responseBody = options?.responseBody;

    let retryAfterMs =
      this.parseRetryAfterMs(options?.headers?.["retry-after"]) ||
      this.parseRetryAfterMs(options?.headers?.["x-ratelimit-reset-after"]);
    if (!retryAfterMs && options?.responseBody) {
      try {
        const parsed = JSON.parse(options.responseBody);
        retryAfterMs = this.parseRetryAfterMs(parsed?.retry_after);
      } catch {}
    }
    if (retryAfterMs) {
      error.retryAfterMs = retryAfterMs;
    }

    return error;
  }

  private async executeWebhookRequest<T>(
    label: string,
    operation: () => Promise<T>
  ) {
    return await this.enqueueWebhookRequest(async () => {
      let attempt = 0;
      while (true) {
        try {
          return await operation();
        } catch (err) {
          const statusCode =
            typeof (err as any)?.statusCode === "number"
              ? (err as any).statusCode
              : undefined;
          const retryAfterMs =
            typeof (err as any)?.retryAfterMs === "number"
              ? (err as any).retryAfterMs
              : undefined;
          if (statusCode !== 429 || attempt >= 4) {
            throw err;
          }

          attempt += 1;
          const delayMs = retryAfterMs ?? 1000 * attempt;
          if (process.env.LOG_LEVEL !== "error") {
            console.log(
              `[SENDER-RETRY] ${label} hit 429, retrying in ${delayMs}ms (attempt ${attempt})`
            );
          }
          await this.sleep(delayMs);
        }
      }
    });
  }

  private async postMultipart(
    body: Record<string, any>,
    files: Array<{ filename: string; buffer: Buffer }>,
    wait = false
  ): Promise<any> {
    return await this.executeWebhookRequest("postMultipart", () =>
      this.postMultipartOnce(body, files, wait)
    );
  }

  private async postMultipartOnce(
    body: Record<string, any>,
    files: Array<{ filename: string; buffer: Buffer }>,
    wait = false
  ): Promise<any> {
    const url = new URL(this.webhookUrl);
    await this.loadStoredThreadId();
    this.applyThreadParams(url);
    this.applyThreadBodyParam(body);
    if (wait) url.searchParams.set("wait", "true");

    const boundary = "----cascadeform" + Math.random().toString(16).slice(2);

    const parts: Buffer[] = [];
    const push = (chunk: string | Buffer) =>
      parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

    // payload_json part
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="payload_json"\r\n`);
    push(`Content-Type: application/json\r\n\r\n`);
    push(JSON.stringify(body));
    push(`\r\n`);

    // files
    files.forEach((f, idx) => {
      push(`--${boundary}\r\n`);
      push(
        `Content-Disposition: form-data; name="files[${idx}]"; filename="${f.filename}"\r\n`
      );
      push(`Content-Type: application/octet-stream\r\n\r\n`);
      push(f.buffer);
      push(`\r\n`);
    });

    // end boundary
    push(`--${boundary}--\r\n`);

    const payload = Buffer.concat(parts);

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.byteLength
      },
      agent: this.httpAgent as any
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(body ? JSON.parse(body) : null);
            } catch {
              resolve(null);
            }
          } else {
            reject(
              this.buildWebhookRequestError(
                `Webhook 多部分上传失败，状态码 ${res.statusCode}: ${res.statusMessage} ${body || ""}`,
                {
                  statusCode: res.statusCode,
                  responseBody: body,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >
                }
              )
            );
          }
        });
      });
      req.setTimeout(15000, () => {
        req.destroy(new Error("Webhook 多部分请求超时"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async downloadUploads(
    uploads: Array<{ url: string; filename: string; isImage?: boolean }>
  ): Promise<Array<{ filename: string; buffer: Buffer; isImage?: boolean }>> {
    const results: Array<{
      filename: string;
      buffer: Buffer;
      isImage?: boolean;
    }> = [];
    for (const u of uploads) {
      const buf = await this.downloadUrl(u.url);
      results.push({ filename: u.filename, buffer: buf, isImage: u.isImage });
    }
    return results;
  }

  private async downloadUrl(fileUrl: string): Promise<Buffer> {
    const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024; // ~24MB to fit under Discord 25MB webhook cap
    const DOWNLOAD_TIMEOUT_MS = 20000; // 20s
    const u = new URL(fileUrl);
    const options: https.RequestOptions = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + u.search,
      agent: this.httpAgent as any
    };
    return await new Promise<Buffer>((resolve, reject) => {
      const req = https.request(options, (res) => {
        const lenHeader = res.headers["content-length"];
        const declared = lenHeader ? Number(lenHeader) : undefined;
        if (declared && declared > MAX_DOWNLOAD_BYTES) {
          res.resume();
          return reject(new Error("下载超过大小限制"));
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // discard
          return reject(new Error(`下载失败，状态码 ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (d) => {
          const b = d as Buffer;
          total += b.length;
          if (total > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error("下载超过大小限制"));
            return;
          }
          chunks.push(b);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error("下载超时"));
      });
      req.on("error", (e) => reject(e));
      req.end();
    });
  }

  async prepare() {
    // 读取 webhook 元信息，拿到 guild_id 与默认 channel_id（有些实现会返回）
    try {
      const info = await this.getCachedWebhookInfo();
      this.webhookGuildId = info.guild_id;
      this.defaultChannelId = info.channel_id;
    } catch {
      // 忽略失败，不影响基本发送
    }
  }

  async sendData(
    messagesToSend: Array<{
      content: string;
      sourceMessageId?: string;
      replyToSourceMessageId?: string;
      username?: string;
      avatarUrl?: string;
      replyToTarget?: { channelId: string; messageId: string };
      useEmbed?: boolean;
      extraEmbeds?: any[];
      uploads?: Array<{
        url: string;
        filename: string;
        isImage?: boolean;
        isVideo?: boolean;
      }>;
      components?: any[];
    }>
  ) {
    if (messagesToSend.length == 0) return;

    const results: Array<{
      sourceMessageId?: string;
      targetMessageId: string;
      targetChannelId: string;
    }> = [];

    for (const item of messagesToSend) {
      const text = this.rewriteOutgoingText(item.content || "");

      // Discord limits: content 2000, embed.description 4096
      const MESSAGE_CHUNK = item.useEmbed ? 4096 : 2000;
      const hasOnlyEmbeds =
        item.useEmbed === true &&
        (item.extraEmbeds?.length || 0) > 0 &&
        text.trim() === "";
      const hasUploads = (item.uploads?.length || 0) > 0;
      if (text.trim() === "" && !hasOnlyEmbeds && !hasUploads) continue;

      // 逐条发送（不分片回复映射会丢失），如超长则分段多条
      // If there are uploads, we will send exactly one message with multipart form.
      const loopCount = hasUploads
        ? 1
        : Math.max(
            1,
            hasOnlyEmbeds ? 1 : Math.ceil(text.length / MESSAGE_CHUNK)
          );
      for (let idx = 0; idx < loopCount; idx++) {
        const i = idx * MESSAGE_CHUNK;
        const chunk = text.substring(i, i + MESSAGE_CHUNK);
        let resp: any = null;
        if (hasUploads) {
          // Build multipart form with files and payload_json
          const files = await this.downloadUploads(item.uploads!);
          // Extract reply header to show as normal content above embed
          let headerLine = "";
          let desc = chunk || "";
          if (desc.startsWith("↳ ")) {
            const nl = desc.indexOf("\n");
            if (nl > 0) {
              headerLine = desc.slice(0, nl);
              desc = desc.slice(nl + 1);
            } else {
              headerLine = desc;
              desc = "";
            }
            if (process.env.LOG_LEVEL !== "error") {
              console.log(`[SENDER] Extracted reply header: "${headerLine}"`);
              console.log(
                `[SENDER] Remaining desc: "${desc.substring(0, 50)}"`
              );
            }
          }
          // Clamp description to 4096 to satisfy Discord limits
          desc = desc.slice(0, 4096);
          const embeds: any[] = Array.isArray(item.extraEmbeds)
            ? [...(this.rewriteOutgoingEmbeds(item.extraEmbeds) || [])]
            : [];
          const firstImage = files.find((f) => f.isImage);
          const canInlineReplyImage =
            Boolean(firstImage) &&
            embeds.length === 1 &&
            !desc.trim() &&
            !headerLine &&
            Boolean(item.replyToTarget?.messageId);
          if (canInlineReplyImage) {
            embeds[0] = {
              ...embeds[0],
              image: { url: `attachment://${firstImage!.filename}` }
            };
          } else {
            const uploadEmbed: any = {};
            if (desc && desc.trim() !== "") uploadEmbed.description = desc;
            if (firstImage) {
              uploadEmbed.image = {
                url: `attachment://${firstImage.filename}`
              };
            }
            if (Object.keys(uploadEmbed).length > 0) {
              embeds.push(uploadEmbed);
            }
          }
          const avatarToUse = item.avatarUrl ?? this.avatarUrl;
          const payload: any = {
            content: headerLine,
            username: item.username,
            ...(avatarToUse ? { avatar_url: avatarToUse } : {}),
            allowed_mentions: { parse: [], replied_user: false },
            ...(embeds.length > 0 ? { embeds } : {})
          };
          // remark is stored in SenderBot.remark for user reference only; do not include in payload
          // persist payload metadata (avatar_url) to .data/sent_payloads.log for auditing
          try {
            const { mkdir, appendFile } = await import("node:fs/promises");
            const path = await import("node:path");
            const dataDir = path.resolve(process.cwd(), ".data");
            await mkdir(dataDir, { recursive: true });
            const meta = {
              ts: new Date().toISOString(),
              webhook: this.webhookUrl,
              avatar_url: avatarToUse || null,
              content_preview: String(payload.content || "").slice(0, 200)
            };
            await appendFile(
              path.join(dataDir, "sent_payloads.log"),
              JSON.stringify(meta) + "\n",
              "utf-8"
            );
          } catch {}
          if (process.env.LOG_LEVEL !== "error")
            console.log(
              "[SENDER-META] multipart payload:",
              JSON.stringify(payload).slice(0, 800)
            );
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          // Provide attachments descriptors to map files indices for attachment://filename resolution
          if (files.length > 0) {
            payload.attachments = files.map((f, idx) => ({
              id: idx,
              filename: f.filename
            }));
          }
          // If neither embed nor content provided, ensure a minimal content to satisfy API shape
          if (!payload.content && !payload.embeds && files.length > 0) {
            payload.content = " ";
          }
          if (item.replyToTarget?.messageId) {
            payload.message_reference = {
              message_id: item.replyToTarget.messageId,
              fail_if_not_exists: false
            };
          }
          if (process.env.LOG_LEVEL !== "error") {
            console.log(
              `[SENDER] Sending multipart with content: "${payload.content}"`
            );
            console.log(
              `[SENDER] Has embeds: ${!!payload.embeds}, Has message_reference: ${!!payload.message_reference}`
            );
          }
          resp = await this.postMultipart(payload, files, true);
        } else {
          const payload: any = {
            allowed_mentions: { parse: [], replied_user: false }
          };
          if (item.useEmbed) {
            // Extract header line to show as normal content
            let headerLine = "";
            let body = chunk || "";
            if (body.startsWith("↳ ")) {
              const nl = body.indexOf("\n");
              if (nl > 0) {
                headerLine = body.slice(0, nl);
                body = body.slice(nl + 1);
              } else {
                headerLine = body;
                body = "";
              }
              if (process.env.LOG_LEVEL !== "error") {
                console.log(
                  `[SENDER-EMBED] Extracted reply header: "${headerLine}"`
                );
                console.log(
                  `[SENDER-EMBED] Remaining body: "${body.substring(0, 50)}"`
                );
              }
            }
            payload.content = headerLine;
            const base = body ? [{ description: body }] : [];
            const rewrittenExtraEmbeds =
              this.rewriteOutgoingEmbeds(item.extraEmbeds as any[]) || [];
            payload.embeds = [...base, ...rewrittenExtraEmbeds];
            // remark is stored in SenderBot.remark for user reference only; do not include in payload
            // determine avatar to use for this message
            const avatarToUse2 = item.avatarUrl ?? this.avatarUrl;
            // persist payload metadata
            try {
              const { mkdir, appendFile } = await import("node:fs/promises");
              const path = await import("node:path");
              const dataDir = path.resolve(process.cwd(), ".data");
              await mkdir(dataDir, { recursive: true });
              const avatarMeta = {
                ts: new Date().toISOString(),
                webhook: this.webhookUrl,
                avatar_url: avatarToUse2 || null,
                content_preview: String(payload.content || "").slice(0, 200)
              };
              await appendFile(
                path.join(dataDir, "sent_payloads.log"),
                JSON.stringify(avatarMeta) + "\n",
                "utf-8"
              );
            } catch {}
            if (process.env.LOG_LEVEL !== "error")
              console.log(
                "[SENDER-META] embed payload:",
                JSON.stringify(payload).slice(0, 800)
              );
            if (process.env.LOG_LEVEL !== "error") {
              console.log(`[SENDER-EMBED] Final content: "${payload.content}"`);
              console.log(
                `[SENDER-EMBED] Embeds count: ${payload.embeds.length}`
              );
            }
          } else {
            payload.content = chunk;
            if (item.extraEmbeds?.length) {
              payload.embeds = [
                ...(this.rewriteOutgoingEmbeds(item.extraEmbeds) || [])
              ];
            }
            if (process.env.LOG_LEVEL !== "error") {
              console.log(
                `[SENDER-NO-EMBED] Content: "${chunk?.substring(0, 50)}"`
              );
            }
          }
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          if (item.username) payload.username = item.username;
          const avatarToUse2 = item.avatarUrl ?? this.avatarUrl;
          if (avatarToUse2) payload.avatar_url = avatarToUse2;
          // remark is stored in SenderBot.remark for user reference only; do not include in payload
          // persist metadata for non-multipart
          try {
            const { mkdir, appendFile } = await import("node:fs/promises");
            const path = await import("node:path");
            const dataDir = path.resolve(process.cwd(), ".data");
            await mkdir(dataDir, { recursive: true });
            const avatarMeta = {
              ts: new Date().toISOString(),
              webhook: this.webhookUrl,
              avatar_url: avatarToUse2 || null,
              content_preview: String(payload.content || "").slice(0, 200)
            };
            await appendFile(
              path.join(dataDir, "sent_payloads.log"),
              JSON.stringify(avatarMeta) + "\n",
              "utf-8"
            );
          } catch {}
          if (process.env.LOG_LEVEL !== "error")
            console.log(
              "[SENDER-META] payload:",
              JSON.stringify(payload).slice(0, 800)
            );
          if (item.replyToTarget?.messageId) {
            payload.message_reference = {
              message_id: item.replyToTarget.messageId,
              fail_if_not_exists: false
            };
            if (process.env.LOG_LEVEL !== "error") {
              console.log(
                `[SENDER] Adding message_reference: ${item.replyToTarget.messageId}`
              );
            }
          }
          resp = await this.postToWebhook(payload, true);
        }
        if (resp?.id && resp?.channel_id) {
          await this.rememberThreadId(String(resp.channel_id));
          results.push({
            sourceMessageId: i === 0 ? item.sourceMessageId : undefined,
            targetMessageId: String(resp.id),
            targetChannelId: String(resp.channel_id)
          });
        }
      }
    }

    return results;
  }

  buildWebhookBody(
    item: {
      content: string;
      replyToSourceMessageId?: string;
      username?: string;
      avatarUrl?: string;
      replyToTarget?: { channelId: string; messageId: string };
      useEmbed?: boolean;
      extraEmbeds?: any[];
      uploads?: Array<{
        url: string;
        filename: string;
        isImage?: boolean;
        isVideo?: boolean;
      }>;
      components?: any[];
    },
    options?: {
      includeReplyReference?: boolean;
    }
  ) {
    const includeReplyReference = options?.includeReplyReference ?? false;
    const text = this.rewriteOutgoingText(item.content || "");

    const hasUploads = (item.uploads?.length || 0) > 0;
    if (hasUploads) {
      return null;
    }

    const payload: any = {
      allowed_mentions: { parse: [], replied_user: false }
    };

    if (item.useEmbed) {
      let headerLine = "";
      let body = text;
      if (body.startsWith("↳ ")) {
        const nl = body.indexOf("\n");
        if (nl > 0) {
          headerLine = body.slice(0, nl);
          body = body.slice(nl + 1);
        } else {
          headerLine = body;
          body = "";
        }
      }
      payload.content = headerLine;
      const base = body ? [{ description: body }] : [];
      const rewrittenExtraEmbeds =
        this.rewriteOutgoingEmbeds(item.extraEmbeds as any[]) || [];
      payload.embeds = [...base, ...rewrittenExtraEmbeds];
    } else {
      payload.content = text;
      if (item.extraEmbeds?.length) {
        payload.embeds = [
          ...(this.rewriteOutgoingEmbeds(item.extraEmbeds) || [])
        ];
      }
    }

    if (item.components && item.components.length > 0) {
      payload.components = item.components;
    }
    if (includeReplyReference && item.replyToTarget?.messageId) {
      payload.message_reference = {
        message_id: item.replyToTarget.messageId,
        fail_if_not_exists: false
      };
    }

    return payload;
  }

  private async postToWebhook(
    body: Record<string, any>,
    wait = false
  ): Promise<any> {
    if (this.threadName && !this.threadId) {
      return await this.runWithThreadCreateLock(() =>
        this.executeWebhookRequest("postToWebhook", () =>
          this.postToWebhookOnce(body, wait)
        )
      );
    }

    return await this.executeWebhookRequest("postToWebhook", () =>
      this.postToWebhookOnce(body, wait)
    );
  }

  private async runWithThreadCreateLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.getThreadStoreKey();
    const previous = webhookThreadCreateQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    webhookThreadCreateQueues.set(
      key,
      previous.then(() => current)
    );

    await previous;
    try {
      await this.loadStoredThreadId();
      return await fn();
    } finally {
      release();
      if (webhookThreadCreateQueues.get(key) === current) {
        webhookThreadCreateQueues.delete(key);
      }
    }
  }

  private async postToWebhookOnce(
    body: Record<string, any>,
    wait = false
  ): Promise<any> {
    const url = new URL(this.webhookUrl);
    await this.loadStoredThreadId();
    this.applyThreadParams(url);
    this.applyThreadBodyParam(body);
    if (wait) {
      // 让服务端返回消息对象
      url.searchParams.set("wait", "true");
    }

    const payload = JSON.stringify(body);

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      agent: this.httpAgent as any
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        // Drain response data to free up memory
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = body ? JSON.parse(body) : null;
              resolve(json);
            } catch {
              resolve(null);
            }
          } else {
            // 若 400 且包含 message_reference 可能不被支持，尝试去掉后重试一次
            if (res.statusCode === 400) {
              try {
                const parsed = JSON.parse(body || "{}");
                const hasRef =
                  payload && JSON.parse(payload).message_reference
                    ? true
                    : false;
                if (hasRef) {
                  const retryBody = JSON.parse(payload);
                  delete retryBody.message_reference;
                  this.postToWebhookOnce(retryBody, wait)
                    .then(resolve)
                    .catch(reject);
                  return;
                }
              } catch (_) {
                // ignore parse errors
              }
            }
            reject(
              this.buildWebhookRequestError(
                `Webhook 请求失败，状态码 ${res.statusCode}: ${res.statusMessage} ${body || ""}`,
                {
                  statusCode: res.statusCode,
                  responseBody: body,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >
                }
              )
            );
          }
        });
      });
      req.setTimeout(15000, () => {
        req.destroy(new Error("Webhook 请求超时"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  /**
   * 编辑已发送的 webhook 消息（PATCH /messages/{messageId}）
   */
  async editWebhookMessage(
    messageId: string,
    body: Record<string, any>
  ): Promise<any> {
    return await this.executeWebhookRequest("editWebhookMessage", () =>
      this.editWebhookMessageOnce(messageId, body)
    );
  }

  private async editWebhookMessageOnce(
    messageId: string,
    body: Record<string, any>
  ): Promise<any> {
    try {
      const url = new URL(this.webhookUrl);
      await this.loadStoredThreadId();
      this.applyThreadParams(url);
      const path = `${url.pathname}/messages/${messageId}${url.search || ""}`;
      const options: https.RequestOptions = {
        method: "PATCH",
        hostname: url.hostname,
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(JSON.stringify(body))
        },
        agent: this.httpAgent as any
      };

      return await new Promise<any>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let resp = "";
          res.on("data", (chunk) => (resp += chunk));
          res.on("end", () => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              try {
                resolve(resp ? JSON.parse(resp) : null);
              } catch {
                resolve(null);
              }
            } else {
              reject(
                this.buildWebhookRequestError(
                  `编辑 webhook 消息失败，状态码 ${res.statusCode}: ${res.statusMessage} ${resp || ""}`,
                  {
                    statusCode: res.statusCode,
                    responseBody: resp,
                    headers: res.headers as Record<
                      string,
                      string | string[] | undefined
                    >
                  }
                )
              );
            }
          });
        });
        req.setTimeout(15000, () => req.destroy(new Error("Webhook 编辑超时")));
        req.on("error", (e) => reject(e));
        req.write(JSON.stringify(body));
        req.end();
      });
    } catch (e) {
      throw e;
    }
  }

  async deleteWebhookMessage(messageId: string): Promise<void> {
    return await this.executeWebhookRequest("deleteWebhookMessage", () =>
      this.deleteWebhookMessageOnce(messageId)
    );
  }

  private async deleteWebhookMessageOnce(messageId: string): Promise<void> {
    const url = new URL(this.webhookUrl);
    await this.loadStoredThreadId();
    this.applyThreadParams(url);
    const path = `${url.pathname}/messages/${messageId}${url.search || ""}`;
    const options: https.RequestOptions = {
      method: "DELETE",
      hostname: url.hostname,
      path,
      agent: this.httpAgent as any
    };

    await new Promise<void>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let resp = "";
        res.on("data", (chunk) => (resp += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              this.buildWebhookRequestError(
                `删除 webhook 消息失败，状态码 ${res.statusCode}: ${res.statusMessage} ${resp || ""}`,
                {
                  statusCode: res.statusCode,
                  responseBody: resp,
                  headers: res.headers as Record<
                    string,
                    string | string[] | undefined
                  >
                }
              )
            );
          }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error("Webhook 删除超时")));
      req.on("error", (e) => reject(e));
      req.end();
    });
  }

  private async getWebhookInfo(): Promise<{
    guild_id?: string;
    channel_id?: string;
  }> {
    const url = new URL(this.webhookUrl);
    const options: https.RequestOptions = {
      method: "GET",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Content-Type": "application/json"
      },
      agent: this.httpAgent as any
    };

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const json = body ? JSON.parse(body) : {};
            resolve(json);
          } catch (e) {
            resolve({});
          }
        });
      });
      req.on("error", (err) => reject(err));
      req.end();
    });
  }

  private async getCachedWebhookInfo(): Promise<{
    guild_id?: string;
    channel_id?: string;
  }> {
    let cached = webhookInfoCache.get(this.webhookUrl);
    if (!cached) {
      cached = this.getWebhookInfo();
      webhookInfoCache.set(this.webhookUrl, cached);
    }
    return await cached;
  }

  private applyThreadParams(url: URL) {
    if (this.threadId) {
      url.searchParams.set("thread_id", this.threadId);
    }
  }

  private applyThreadBodyParam(body: Record<string, any>) {
    if (!this.threadId && this.threadName) {
      body.thread_name = this.threadName;
    }
  }

  private getThreadStorePath() {
    return path.resolve(process.cwd(), ".data", "webhook_threads.json");
  }

  private getThreadStoreKey() {
    const url = new URL(this.webhookUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const webhookId = parts[parts.indexOf("webhooks") + 1] || url.pathname;
    return `${webhookId}:${this.threadName || ""}`;
  }

  private async readThreadStore(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.getThreadStorePath(), "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async loadStoredThreadId() {
    if (this.threadId || !this.threadName || this.threadIdLoaded) {
      return;
    }
    this.threadIdLoaded = true;
    const store = await this.readThreadStore();
    const stored = store[this.getThreadStoreKey()];
    if (stored) {
      this.threadId = String(stored);
    }
  }

  private async rememberThreadId(channelId?: string) {
    if (!channelId || !this.threadName || this.threadId) {
      return;
    }
    this.threadId = String(channelId);
    const storePath = this.getThreadStorePath();
    const store = await this.readThreadStore();
    store[this.getThreadStoreKey()] = this.threadId;
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
  }
}
