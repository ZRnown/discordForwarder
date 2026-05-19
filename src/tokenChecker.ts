import { sendEmail } from "./email.js";
import { getEnv } from "./env.js";

interface TokenCheckRecord {
  lastCheck: number;
  lastStatus: "valid" | "invalid" | "expired";
  lastNotification: number;
}

export class TokenChecker {
  private data: TokenCheckRecord = {
    lastCheck: 0,
    lastStatus: "valid",
    lastNotification: 0
  };
  private env = getEnv();
  private checkInterval: NodeJS.Timeout | null = null;
  private client: any; // Discord client
  private checkIntervalMs: number;

  constructor(client: any) {
    this.client = client;
    const minutes = Math.max(
      5,
      Number(this.env.TOKEN_CHECK_INTERVAL_MINUTES || "1")
    );
    this.checkIntervalMs = minutes * 60 * 1000;
    if (process.env.LOG_LEVEL !== "error")
      console.log(`[TokenChecker] interval set to ${minutes} minute(s)`);
  }

  async init(): Promise<void> {
    // 使用内存存储，启动定期检查
    this.startPeriodicCheck();
    if (process.env.LOG_LEVEL !== "error")
      console.log("[TokenChecker] Initialized with memory storage");
  }

  private getLastRecord(): TokenCheckRecord {
    return this.data;
  }

  private saveRecord(
    status: "valid" | "invalid" | "expired",
    notificationSent: boolean
  ): void {
    const now = Date.now();
    this.data = {
      lastCheck: now,
      lastStatus: status,
      lastNotification: notificationSent ? now : this.data.lastNotification
    };
  }

  async checkToken(): Promise<"valid" | "invalid" | "expired"> {
    const token = this.env.DISCORD_TOKEN;
    if (!token) {
      if (process.env.LOG_LEVEL !== "error")
        console.warn("[TokenChecker] DISCORD_TOKEN 未配置，跳过检查");
      return "valid";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const authHeader =
        this.env.DISCORD_BOT_BACKEND === "bot" ? `Bot ${token}` : token;
      const res = await fetch("https://discord.com/api/v9/users/@me", {
        method: "GET",
        headers: {
          authorization: authHeader,
          "user-agent": "discord-forwarder token-check/1.0"
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.status === 200) return "valid";
      if (res.status === 401) {
        console.log(
          "[TokenChecker] 401 Unauthorized detected, token expired/invalid"
        );
        return "expired";
      }
      if (res.status === 429) {
        console.log(
          "[TokenChecker] Rate limited during token check; treating as valid to avoid false alarm"
        );
        return "valid";
      }

      // 其他状态视为暂时有效，避免误报，同时记录
      console.log(
        `[TokenChecker] Unexpected status during check: ${res.status}`
      );
      return "valid";
    } catch (error: any) {
      clearTimeout(timeout);
      if (error?.name === "AbortError") {
        if (process.env.LOG_LEVEL !== "error")
          console.log(
            "[TokenChecker] Token check timeout, treating as valid to avoid false alarm"
          );
        return "valid";
      }

      const errorMessage = error?.message || "";
      if (process.env.LOG_LEVEL !== "error")
        console.log(
          `[TokenChecker] Token check failed: ${errorMessage.substring(0, 120)}`
        );
      // 网络等错误，视为暂时有效
      return "valid";
    }
  }

  async checkAndNotify(): Promise<void> {
    const status = await this.checkToken();
    if (process.env.LOG_LEVEL !== "error")
      console.log(
        `[TokenChecker] ${new Date().toISOString()} status=${status}`
      );
    const lastRecord = this.getLastRecord();

    // 如果状态变为 expired 或 invalid，且距离上次通知超过 24 小时，则发送通知
    const now = Date.now();
    const shouldNotify =
      (status === "expired" || status === "invalid") &&
      (!lastRecord ||
        lastRecord.lastStatus !== status ||
        now - lastRecord.lastNotification > 24 * 60 * 60 * 1000);

    if (shouldNotify) {
      const success = await this.sendNotification(status);
      this.saveRecord(status, success);
    } else {
      this.saveRecord(status, false);
    }
  }

  private async sendNotification(
    status: "expired" | "invalid"
  ): Promise<boolean> {
    const subject =
      status === "expired"
        ? "⚠️ Discord Token 已过期"
        : "⚠️ Discord Token 无效";

    const text =
      status === "expired"
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
  }

  /**
   * 立即发送 token 失效/过期通知（用于登录失败时的即时提醒）
   */
  async notifyInvalidNow(status: "expired" | "invalid"): Promise<void> {
    try {
      const success = await this.sendNotification(status);
      this.saveRecord(status, success);
    } catch (error) {
      console.error("[TokenChecker] 发送立即通知失败:", error);
    }
  }
}
