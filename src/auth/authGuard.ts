import { Context, MiddlewareFn } from "telegraf";
import { findUser, Role } from "../db/db";

export function requireAuth(minRole: Role = "viewer"): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await ctx.reply("Cannot identify user.");
      return;
    }

    const user = findUser(telegramId);
    if (!user) {
      await ctx.reply("Access denied. You are not authorized to use this bot.");
      return;
    }

    if (minRole === "admin" && user.role !== "admin") {
      await ctx.reply("Access denied. Admin role required.");
      return;
    }

    return next();
  };
}

export function isAdmin(telegramId: number): boolean {
  const user = findUser(telegramId);
  return user?.role === "admin";
}
