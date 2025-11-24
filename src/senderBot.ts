import https from "node:https";
import { URL } from "node:url";

import { ChannelId } from "./config.js";

export class SenderBot {
  // 保留以兼容旧接口，Webhook 模式不使用
  chatsToSend: ChannelId[];
  replacementsDictionary: Record<string, string> = {};

  webhookUrl: string;
  httpAgent?: unknown;
  webhookGuildId?: string;
  defaultChannelId?: string;

  constructor(options: {
    chatsToSend: ChannelId[];
    replacementsDictionary?: Record<string, string>;
    webhookUrl: string;
    httpAgent?: unknown; // 由 proxy-agent 创建的 Agent，可选
  }) {
    this.chatsToSend = options.chatsToSend;
    this.replacementsDictionary = options.replacementsDictionary || {};
    this.webhookUrl = options.webhookUrl;
    this.httpAgent = options.httpAgent;
  }

  private async postMultipart(body: Record<string, any>, files: Array<{ filename: string; buffer: Buffer }>, wait = false): Promise<any> {
    const url = new URL(this.webhookUrl);
    if (wait) url.searchParams.set("wait", "true");

    const boundary = "----cascadeform" + Math.random().toString(16).slice(2);

    const parts: Buffer[] = [];
    const push = (chunk: string | Buffer) => parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

    // payload_json part
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="payload_json"\r\n`);
    push(`Content-Type: application/json\r\n\r\n`);
    push(JSON.stringify(body));
    push(`\r\n`);

    // files
    files.forEach((f, idx) => {
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="files[${idx}]"; filename="${f.filename}"\r\n`);
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
            reject(new Error(`Webhook 多部分上传失败，状态码 ${res.statusCode}: ${res.statusMessage} ${body || ""}`));
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

  private async downloadUploads(uploads: Array<{ url: string; filename: string; isImage?: boolean }>): Promise<Array<{ filename: string; buffer: Buffer; isImage?: boolean }>> {
    const results: Array<{ filename: string; buffer: Buffer; isImage?: boolean }> = [];
    for (const u of uploads) {
      const buf = await this.downloadUrl(u.url);
      results.push({ filename: u.filename, buffer: buf, isImage: u.isImage });
    }
    return results;
  }

  private async downloadUrl(fileUrl: string): Promise<Buffer> {
    const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10MB
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
      const info = await this.getWebhookInfo();
      this.webhookGuildId = info.guild_id;
      this.defaultChannelId = info.channel_id;
    } catch {
      // 忽略失败，不影响基本发送
    }
  }

  async sendData(messagesToSend: Array<{
    content: string;
    sourceMessageId?: string;
    replyToSourceMessageId?: string;
    username?: string;
    avatarUrl?: string;
    replyToTarget?: { channelId: string; messageId: string };
    useEmbed?: boolean;
    extraEmbeds?: any[];
    uploads?: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }>;
    components?: any[];
  }>) {
    if (messagesToSend.length == 0) return;

    const results: Array<{
      sourceMessageId?: string;
      targetMessageId: string;
      targetChannelId: string;
    }> = [];

    for (const item of messagesToSend) {
      let text = item.content || "";
      for (const [a, b] of Object.entries(this.replacementsDictionary)) {
        text = text.replaceAll(a, b);
      }

      // Discord limits: content 2000, embed.description 4096
      const MESSAGE_CHUNK = item.useEmbed ? 4096 : 2000;
      const hasOnlyEmbeds = item.useEmbed === true && (item.extraEmbeds?.length || 0) > 0 && text.trim() === "";
      const hasUploads = (item.uploads?.length || 0) > 0;
      if (text.trim() === "" && !hasOnlyEmbeds && !hasUploads) continue;

      // 逐条发送（不分片回复映射会丢失），如超长则分段多条
      // If there are uploads, we will send exactly one message with multipart form.
      const loopCount = hasUploads ? 1 : Math.max(1, hasOnlyEmbeds ? 1 : Math.ceil(text.length / MESSAGE_CHUNK));
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
          }
          // Clamp description to 4096 to satisfy Discord limits
          desc = desc.slice(0, 4096);
          const embed: any = {};
          if (desc && desc.trim() !== "") embed.description = desc;
          const firstImage = files.find((f) => f.isImage);
          if (firstImage) {
            embed.image = { url: `attachment://${firstImage.filename}` };
          }
          const payload: any = {
            content: headerLine,
            username: item.username,
            avatar_url: item.avatarUrl,
            allowed_mentions: { parse: [], replied_user: false },
            // add embeds only if we actually have description or image
            ...(Object.keys(embed).length > 0 ? { embeds: [embed] } : {})
          };
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          // Provide attachments descriptors to map files indices for attachment://filename resolution
          if (files.length > 0) {
            payload.attachments = files.map((f, idx) => ({ id: idx, filename: f.filename }));
          }
          // If neither embed nor content provided, ensure a minimal content to satisfy API shape
          if (!payload.content && !payload.embeds && files.length > 0) {
            payload.content = " ";
          }
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          resp = await this.postMultipart(payload, files, true);
        } else {
          const payload: any = {
            allowed_mentions: { parse: [], replied_user: false }
          };
          if (item.useEmbed) {
            payload.content = "";
            const base = chunk ? [{ description: chunk }] : [];
            payload.embeds = [...base, ...((item.extraEmbeds as any[]) || [])];
          } else {
            payload.content = chunk;
          }
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          if (item.username) payload.username = item.username;
          if (item.avatarUrl) payload.avatar_url = item.avatarUrl;
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          resp = await this.postToWebhook(payload, true);
        }
        if (resp?.id && resp?.channel_id) {
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

  private async postToWebhook(body: Record<string, any>, wait = false): Promise<any> {
    const url = new URL(this.webhookUrl);
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
                const hasRef = (payload && JSON.parse(payload).message_reference) ? true : false;
                if (hasRef) {
                  const retryBody = JSON.parse(payload);
                  delete retryBody.message_reference;
                  this.postToWebhook(retryBody, wait).then(resolve).catch(reject);
                  return;
                }
              } catch (_) {
                // ignore parse errors
              }
            }
            reject(new Error(`Webhook 请求失败，状态码 ${res.statusCode}: ${res.statusMessage} ${body || ""}`));
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

  private async getWebhookInfo(): Promise<{ guild_id?: string; channel_id?: string }> {
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
}
