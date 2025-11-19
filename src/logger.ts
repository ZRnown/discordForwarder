import { promises as fs } from "node:fs";
import path from "node:path";

export class FileLogger {
  private dir: string;
  private filterRe?: RegExp;

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

  async log(level: "INFO" | "DEBUG" | "ERROR", msg: string) {
    // 过滤：当配置了 filterRe 时，仅保留匹配的 DEBUG/INFO 日志；ERROR 始终保留
    try {
      if (this.filterRe && level !== "ERROR") {
        if (!this.filterRe.test(msg)) return;
      }
    } catch {}
    await this.ensureDir();
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
