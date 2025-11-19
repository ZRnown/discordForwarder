import dotenv from "dotenv";

export interface Env {
  DISCORD_TOKEN: string;
  // Translation configs
  TRANSLATION_ENABLED?: string; // "true" | "false" (default true)
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_URL?: string; // default https://api.deepseek.com/v1/chat/completions
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
