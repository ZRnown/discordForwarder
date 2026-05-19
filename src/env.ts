import dotenv from "dotenv";

export interface Env {
  DISCORD_TOKEN: string;
  DISCORD_BOT_BACKEND?: string; // "selfbot" | "bot"
  // Translation configs
  TRANSLATION_ENABLED?: string; // "true" | "false" (default true)
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_URL?: string; // default https://api.deepseek.com/v1/chat/completions
  TOKEN_CHECK_INTERVAL_MINUTES?: string; // default 60
  // Logging / startup notification
  LOG_LEVEL?: string; // "error" | "info" | "debug"
  SEND_STARTUP_NOTIFICATION?: string; // "true" | "false"
  // Email notification configs
  EMAIL_ENABLED?: string; // "true" | "false" (default false)
  EMAIL_SMTP_HOST?: string;
  EMAIL_SMTP_PORT?: string;
  EMAIL_SMTP_SECURE?: string; // "true" | "false" (default true for port 465)
  EMAIL_SMTP_USER?: string;
  EMAIL_SMTP_PASS?: string;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
}

export function getEnv(): Env {
  if (process.env.NODE_ENV != "production") dotenv.config();

  // Defaults for translation
  if (process.env.TRANSLATION_ENABLED === undefined)
    process.env.TRANSLATION_ENABLED = "true";
  if (!process.env.DEEPSEEK_API_URL)
    process.env.DEEPSEEK_API_URL =
      "https://api.deepseek.com/v1/chat/completions";
  // Default minimal console logging (only errors) unless overridden
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";
  // By default do not send startup notification to webhook; set to "true" to enable
  if (!process.env.SEND_STARTUP_NOTIFICATION)
    process.env.SEND_STARTUP_NOTIFICATION = "false";

  return process.env as unknown as Env;
}
