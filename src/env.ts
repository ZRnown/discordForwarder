import dotenv from "dotenv";

export enum BotBackend {
  Selfbot = "selfbot",
  Bot = "bot"
}

export interface Env {
  DISCORD_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_BOT_BACKEND?: BotBackend;
  PROXY_URL?: string;

  // Translation configs
  TRANSLATION_ENABLED?: string; // "true" | "false" (default true)
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_URL?: string; // default https://api.deepseek.com/v1/chat/completions

  // Debug output switch
  DEBUG_OUTPUT?: string; // "true" | "false" (default false)
}

export function getEnv(): Env {
  if (process.env.NODE_ENV != "production") dotenv.config();

  process.env.DISCORD_BOT_BACKEND =
    process.env.DISCORD_BOT_BACKEND ?? BotBackend.Selfbot;

  // Defaults for translation
  if (process.env.TRANSLATION_ENABLED === undefined)
    process.env.TRANSLATION_ENABLED = "true";
  if (!process.env.DEEPSEEK_API_URL)
    process.env.DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

  if (process.env.DEBUG_OUTPUT === undefined)
    process.env.DEBUG_OUTPUT = "false";

  return process.env as unknown as Env;
}
