import { Telegraf } from "telegraf";
import { config } from "../config/config";
import { registerCommands } from "./commands";

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken);

  // Global error handler
  bot.catch((err, ctx) => {
    console.error(`[bot] Error for ${ctx.updateType}:`, err);
    ctx.reply("An internal error occurred. Please try again later.").catch(() => null);
  });

  registerCommands(bot);

  return bot;
}
