import { createBot } from "./bot/bot";
import { getDb } from "./db/db";
import { config } from "./config/config";
import { startWebServer } from "./web/server";

async function main(): Promise<void> {
  // Initialize DB on startup
  getDb();
  console.log("[db] Database initialized.");

  const bot = createBot();

  // Start web admin panel
  if (config.webEnabled) {
    startWebServer();
  }

  // Graceful shutdown
  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  console.log("[bot] Starting…");
  await bot.launch();
  console.log("[bot] Bot is running.");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
