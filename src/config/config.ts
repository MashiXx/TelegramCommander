import dotenv from "dotenv";
import path from "path";

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  databasePath: process.env.DATABASE_PATH ?? "./data/bot.db",
  commandTimeoutMs: parseInt(process.env.COMMAND_TIMEOUT_MS ?? "30000", 10),
  dataDir: path.dirname(process.env.DATABASE_PATH ?? "./data/bot.db"),
  webPort: parseInt(process.env.WEB_PORT ?? "3000", 10),
  webEnabled: process.env.WEB_ENABLED !== "false",
  webUser: process.env.WEB_USER ?? "admin",
  webPass: process.env.WEB_PASS ?? "",
  botConfigEnabled: process.env.BOT_CONFIG_ENABLED !== "false",
};
