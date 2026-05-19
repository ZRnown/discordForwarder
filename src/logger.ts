import { promises as fs } from "node:fs";
import path from "node:path";
import util from "node:util";

type FileLogLevel = "INFO" | "DEBUG" | "WARN" | "ERROR";

export class FileLogger {
  private dir: string;
  private filterRe?: RegExp;
  private lastCleanDate?: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dir: string = path.resolve(process.cwd(), "log")) {
    this.dir = dir;
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {}
  }

  private getDateKey(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  private getFilePath(level: FileLogLevel, date = new Date()) {
    const dateKey = this.getDateKey(date);
    const fileName = level.toLowerCase() + ".log";
    return path.join(this.dir, dateKey, fileName);
  }

  private formatLine(level: FileLogLevel, msg: string, date = new Date()) {
    const d = date;
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const pad3 = (n: number) => String(n).padStart(3, "0");
    const HH = pad2(d.getHours());
    const MM = pad2(d.getMinutes());
    const SS = pad2(d.getSeconds());
    const sss = pad3(d.getMilliseconds());
    const ts = `${HH}:${MM}:${SS}.${sss}`;
    const lines = String(msg).replace(/\r\n/g, "\n").split("\n");
    const [firstLine = "", ...restLines] = lines;
    const prefix = `[${ts}] [${level}] `;
    const indent = " ".repeat(prefix.length);
    const formattedRest = restLines
      .map((line) => `${indent}${line}`)
      .join("\n");
    return `${prefix}${firstLine}${formattedRest ? `\n${formattedRest}` : ""}\n`;
  }

  private async cleanOldLogsIfNeeded() {
    try {
      const todayKey = this.getDateKey();
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
          const cfg = JSON.parse(
            await (
              await import("node:fs/promises")
            ).readFile("./config.json", "utf-8")
          );
          const v = cfg?.logging?.keepDays;
          if (v !== undefined) keepDays = Math.max(0, Number(v));
        } catch {}
      }
      if (keepDays === undefined) {
        keepDays = 1;
      }
      if (!keepDays || keepDays <= 0) return;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - keepDays + 1);
      const cutoffKey = this.getDateKey(cutoff);

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
      for (const name of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        const dateKey = name;
        if (dateKey < cutoffKey) {
          try {
            await fs.rm(path.join(this.dir, name), {
              recursive: true,
              force: true
            });
          } catch {}
        }
      }
    } catch {}
  }

  private shouldWriteLevel(level: FileLogLevel) {
    // 控制写入到文件的最小级别：当 LOG_FILE_LEVEL 未设置时回退到 LOG_LEVEL，再回退到 "error"
    const configured = (
      process.env.LOG_FILE_LEVEL ||
      process.env.LOG_LEVEL ||
      "error"
    ).toLowerCase();
    const levelMap: Record<string, number> = { error: 0, info: 1, debug: 2 };
    const targetLevel = level === "ERROR" ? 0 : level === "DEBUG" ? 2 : 1;
    return (levelMap[configured] ?? 0) >= targetLevel;
  }

  private formatConsoleArgs(args: unknown[]) {
    return util.formatWithOptions(
      { depth: 4, breakLength: 120, colors: false },
      ...args
    );
  }

  private queueWrite(task: () => Promise<void>) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async flush() {
    await this.writeQueue;
  }

  async log(level: FileLogLevel, msg: string) {
    if (!this.shouldWriteLevel(level)) return;
    // 过滤：当配置了 filterRe 时，仅保留匹配的 DEBUG/INFO 日志；ERROR 始终保留
    try {
      if (this.filterRe && level !== "ERROR") {
        if (!this.filterRe.test(msg)) return;
      }
    } catch {}

    const now = new Date();
    const file = this.getFilePath(level, now);
    const line = this.formatLine(level, msg, now);

    await this.queueWrite(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await this.cleanOldLogsIfNeeded();
        await fs.appendFile(file, line, "utf-8");
      } catch {}
    });
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

  warn(msg: string) {
    return this.log("WARN", msg);
  }

  installConsoleCapture(options?: { mirrorToConsole?: boolean }) {
    const mirrorToConsole = options?.mirrorToConsole ?? true;
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };

    console.log = (...args: unknown[]) => {
      if (mirrorToConsole) {
        original.log(...args);
      }
      void this.info(this.formatConsoleArgs(args));
    };
    console.info = (...args: unknown[]) => {
      if (mirrorToConsole) {
        original.info(...args);
      }
      void this.info(this.formatConsoleArgs(args));
    };
    console.warn = (...args: unknown[]) => {
      if (mirrorToConsole) {
        original.warn(...args);
      }
      void this.warn(this.formatConsoleArgs(args));
    };
    console.error = (...args: unknown[]) => {
      if (mirrorToConsole) {
        original.error(...args);
      }
      void this.error(this.formatConsoleArgs(args));
    };

    return () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    };
  }

  // 允许外部设置日志过滤正则（例如只输出 special/unlock/tradeSignal 相关）
  setFilter(pattern?: string) {
    try {
      if (!pattern) {
        this.filterRe = undefined;
        return;
      }
      this.filterRe = new RegExp(pattern, "i");
    } catch {
      this.filterRe = undefined;
    }
  }
}
