import { promises as fs } from "node:fs";
import path from "node:path";

export class FileLogger {
  private dir: string;
  private filterRe?: RegExp;
  private lastCleanDate?: string;

  constructor(dir: string = path.resolve(process.cwd(), "logs")) {
    this.dir = dir;
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {}
  }

  private getFilePath(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const filename = `${yyyy}-${mm}-${dd}.log`;
    return path.join(this.dir, filename);
  }

  private formatLine(level: string, msg: string) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level}] ${msg}\n`;
  }

  private formatDateKey(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  private async cleanOldLogsIfNeeded() {
    try {
      const todayKey = this.formatDateKey();
      if (this.lastCleanDate === todayKey) return;
      this.lastCleanDate = todayKey;

      // Determine keepDays from env or config.json
      let keepDays: number | undefined;
      try {
        const envVal = process.env.LOG_KEEP_DAYS;
        if (envVal) keepDays = Math.max(0, Number(envVal));
      } catch {}
      if (keepDays === undefined) {
        try {
          const cfg = JSON.parse(await (await import("node:fs/promises")).readFile("./config.json", "utf-8"));
          const v = cfg?.logging?.keepDays;
          if (v !== undefined) keepDays = Math.max(0, Number(v));
        } catch {}
      }
      if (!keepDays || keepDays <= 0) return;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - keepDays + 1);
      const cutoffKey = this.formatDateKey(cutoff);

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
      for (const name of entries) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const dateKey = name.slice(0, 10);
        if (dateKey < cutoffKey) {
          try { await fs.unlink(path.join(this.dir, name)); } catch {}
        }
      }
    } catch {}
  }

  async log(level: "INFO" | "DEBUG" | "ERROR", msg: string) {
    // 过滤：当配置了 filterRe 时，仅保留匹配的 DEBUG/INFO 日志；ERROR 始终保留
    try {
      if (this.filterRe && level !== "ERROR") {
        if (!this.filterRe.test(msg)) return;
      }
    } catch {}
    await this.ensureDir();
    await this.cleanOldLogsIfNeeded();
    const file = this.getFilePath();
    const line = this.formatLine(level, msg);
    try {
      await fs.appendFile(file, line, "utf-8");
    } catch {}
  }

  info(msg: string) {
    return this.log("INFO", msg);
  }

  debug(msg: string) {
    return this.log("DEBUG", msg);
  }

  error(msg: string) {
    return this.log("ERROR", msg);
  }

  // 允许外部设置日志过滤正则（例如只输出 special/unlock/tradeSignal 相关）
  setFilter(pattern?: string) {
    try {
      if (!pattern) { this.filterRe = undefined; return; }
      this.filterRe = new RegExp(pattern, "i");
    } catch { this.filterRe = undefined; }
  }
}
