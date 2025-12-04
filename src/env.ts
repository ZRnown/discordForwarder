import dotenv from "dotenv";

export interface Env {
  DISCORD_TOKEN: string;
  // Translation configs
  TRANSLATION_ENABLED?: string; // "true" | "false" (default true)
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_URL?: string; // default https://api.deepseek.com/v1/chat/completions
  TOKEN_CHECK_INTERVAL_MINUTES?: string; // default 60
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
    process.env.DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

  return process.env as unknown as Env;
}
