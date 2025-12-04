import { sendEmail } from "./email.js";
import { getEnv } from "./env.js";

interface TokenCheckRecord {
  lastCheck: number;
  lastStatus: "valid" | "invalid" | "expired";
  lastNotification: number;
}

export class TokenChecker {
  private db: any = null;
  private env = getEnv();
  private checkInterval: NodeJS.Timeout | null = null;
  private client: any; // Discord client
  private checkIntervalMs: number;

  constructor(client: any) {
    this.client = client;
    const minutes = Math.max(
      5,
      Number(this.env.TOKEN_CHECK_INTERVAL_MINUTES || "15")
    );
    this.checkIntervalMs = minutes * 60 * 1000;
    console.log(`[TokenChecker] interval set to ${minutes} minute(s)`);
  }

  async init(): Promise<void> {
    try {
      const Database = (await import("better-sqlite3")).default;
      const { mkdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const path = await import("node:path");

      const dbDir = path.resolve(process.cwd(), ".data");
      if (!existsSync(dbDir)) {
        await mkdir(dbDir, { recursive: true });
      }

      const dbPath = path.join(dbDir, "token_check.db");
      this.db = new Database(dbPath);

      // 创建表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS token_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          last_check INTEGER NOT NULL,
          last_status TEXT NOT NULL,
          last_notification INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // 启动定期检查
      this.startPeriodicCheck();
      console.log("[TokenChecker] Database initialized successfully");
    } catch (error) {
      console.warn("[TokenChecker] Failed to initialize database (will continue without persistence):", error instanceof Error ? error.message : String(error));
      console.warn("[TokenChecker] Token checking will still work, but notification cooldown won't be persisted");
      // 即使数据库初始化失败，也启动定期检查（使用内存状态）
      this.startPeriodicCheck();
    }
  }

  private lastCheckMemory: TokenCheckRecord | null = null;

  private getLastRecord(): TokenCheckRecord | null {
    if (this.db) {
      try {
        const result = this.db.prepare(
          "SELECT last_check, last_status, last_notification FROM token_checks ORDER BY id DESC LIMIT 1"
        ).get() as any;
        if (result) {
          const record = {
            lastCheck: result.last_check as number,
            lastStatus: result.last_status as "valid" | "invalid" | "expired",
            lastNotification: result.last_notification as number || 0
          };
          this.lastCheckMemory = record;
          return record;
        }
      } catch (error) {
        // 数据库错误时使用内存记录
        if (this.lastCheckMemory) return this.lastCheckMemory;
      }
    }
    // 如果没有数据库，使用内存记录
    return this.lastCheckMemory;
  }

  private saveRecord(status: "valid" | "invalid" | "expired", notificationSent: boolean): void {
    const now = Date.now();
    const lastNotification = notificationSent ? now : null;
    
    // 更新内存记录
    this.lastCheckMemory = {
      lastCheck: now,
      lastStatus: status,
      lastNotification: notificationSent ? now : (this.lastCheckMemory?.lastNotification || 0)
    };

    if (this.db) {
      try {
        this.db.prepare(
          "INSERT INTO token_checks (last_check, last_status, last_notification) VALUES (?, ?, ?)"
        ).run(now, status, lastNotification);
      } catch (error) {
        // 数据库错误时只使用内存记录，不阻止程序运行
      }
    }
  }

  async checkToken(): Promise<"valid" | "invalid" | "expired"> {
    if (!this.client || !this.client.user) {
      return "invalid";
    }

    try {
      // 尝试获取当前用户信息来验证 token
      const user = await this.client.user.fetch();
      if (user) {
        return "valid";
      }
    } catch (error: any) {
      // 检查是否是 token 相关的错误
      const errorMessage = error?.message || "";
      const errorCode = error?.code;

      // Discord API 错误码
      // 401: Unauthorized (token invalid/expired)
      // 403: Forbidden (token valid but no permission)
      if (errorCode === 401 || errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
        return "expired";
      }
      
      if (errorCode === 403 || errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
        return "invalid";
      }

      // 其他错误，可能是网络问题，返回上次状态或 valid
      const lastRecord = this.getLastRecord();
      return lastRecord?.lastStatus || "valid";
    }

    return "valid";
  }

  async checkAndNotify(): Promise<void> {
    const status = await this.checkToken();
    console.log(`[TokenChecker] ${new Date().toISOString()} status=${status}`);
    const lastRecord = this.getLastRecord();
    
    // 如果状态变为 expired 或 invalid，且距离上次通知超过 24 小时，则发送通知
    const now = Date.now();
    const shouldNotify = 
      (status === "expired" || status === "invalid") &&
      (!lastRecord || 
       lastRecord.lastStatus !== status ||
       (now - lastRecord.lastNotification) > 24 * 60 * 60 * 1000);

    if (shouldNotify) {
      const success = await this.sendNotification(status);
      this.saveRecord(status, success);
    } else {
      this.saveRecord(status, false);
    }
  }

  private async sendNotification(status: "expired" | "invalid"): Promise<boolean> {
    const subject = status === "expired" 
      ? "⚠️ Discord Token 已过期"
      : "⚠️ Discord Token 无效";

    const text = status === "expired"
      ? `您的 Discord Token 已过期，请尽快更新。

请在 .env 文件中更新 DISCORD_TOKEN 的值，然后重启应用程序。

当前时间: ${new Date().toLocaleString("zh-CN")}`
      : `您的 Discord Token 无效，请检查配置。

请在 .env 文件中检查 DISCORD_TOKEN 的值是否正确，然后重启应用程序。

当前时间: ${new Date().toLocaleString("zh-CN")}`;

    return await sendEmail({
      subject,
      text
    });
  }

  private startPeriodicCheck(): void {
    // 立即检查一次
    this.checkAndNotify().catch(console.error);

    // 然后每小时检查一次
    this.checkInterval = setInterval(() => {
      this.checkAndNotify().catch(console.error);
    }, this.checkIntervalMs);
  }

  async destroy(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

