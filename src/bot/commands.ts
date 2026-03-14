import { Telegraf, Context, Markup } from "telegraf";
import { CallbackQuery } from "telegraf/types";
import { requireAuth } from "../auth/authGuard";
import {
  findUser, findCommand, listCommands, listApps, findApp, listServers, findServer,
  addUser, upsertApp, upsertServer, deleteServer, logExecution, getRecentLogs,
  Server,
} from "../db/db";
import { sshExec, truncateOutput } from "../executor/sshExecutor";
import { getSystemStatus, getProcessList, getPm2Logs } from "../services/systemService";
import { deployApp } from "../services/deployService";

// ---------- helpers ----------

async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(truncateOutput(text), { parse_mode: "Markdown" });
}

function userId(ctx: Context): number {
  return findUser(ctx.from!.id)!.id;
}

/** Build inline keyboard from server list */
function serverKeyboard(servers: Server[], action: string) {
  const buttons = servers.map((s) =>
    Markup.button.callback(`🖥 ${s.name} (${s.host})`, `${action}:${s.name}`)
  );
  return Markup.inlineKeyboard(buttons, { columns: 1 });
}

/** Resolve server: if only 1 exists, return it; else send picker and return null */
async function pickServer(
  ctx: Context, action: string, label: string
): Promise<Server | null> {
  const servers = listServers();
  if (servers.length === 0) {
    await ctx.reply("No servers registered. Use /addserver to add one.");
    return null;
  }
  if (servers.length === 1) return servers[0];

  await ctx.reply(
    `Select a server for *${label}*:`,
    { parse_mode: "Markdown", ...serverKeyboard(servers, action) }
  );
  return null; // response handled by callback_query
}

// ---------- command registration ----------

export function registerCommands(bot: Telegraf): void {

  // /start
  bot.command("start", async (ctx) => {
    const user = findUser(ctx.from.id);
    if (!user) {
      await ctx.reply("Welcome! You are not authorized.\nAsk an admin to add you with /adduser.");
      return;
    }
    await ctx.reply(
      `Hello *${user.username ?? "user"}*! Role: \`${user.role}\`\nUse /help to see commands.`,
      { parse_mode: "Markdown" }
    );
  });

  // /help
  bot.command("help", requireAuth(), async (ctx) => {
    const cmds = [
      "/status        — System status",
      "/process       — Running processes",
      "/apps [server] — Managed applications",
      "/logs [lines]  — View PM2 logs",
      "/servers       — List servers",
      "/deploy <app>  — Deploy app (admin)",
      "/run <cmd> <server> — Run whitelisted command (admin)",
      "/addserver     — Register server (admin)",
      "/addapp        — Register application (admin)",
      "/adduser <id> [role] — Add user (admin)",
      "/audit [n]     — Audit log (admin)",
    ];
    await ctx.reply("*Commands:*\n" + cmds.join("\n"), { parse_mode: "Markdown" });
  });

  // /servers
  bot.command("servers", requireAuth(), async (ctx) => {
    const servers = listServers();
    if (servers.length === 0) {
      await ctx.reply("No servers registered.");
      return;
    }
    const lines = servers.map(
      (s) => `*${s.name}*  \`${s.username}@${s.host}:${s.port}\`${s.description ? `  — ${s.description}` : ""}`
    );
    await replyMd(ctx, lines.join("\n"));
  });

  // /status — inline keyboard if >1 server
  bot.command("status", requireAuth(), async (ctx) => {
    const server = await pickServer(ctx, "status", "status");
    if (!server) return;
    await runStatus(ctx, server);
  });

  bot.action(/^status:(.+)$/, requireAuth(), async (ctx) => {
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.split(":")[1];
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runStatus(ctx, server);
  });

  async function runStatus(ctx: Context, server: Server): Promise<void> {
    const msg = await ctx.reply(`Fetching status from *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await getSystemStatus(server);
    const output = result.stdout || result.stderr || "No output";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `*${server.name}* status:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), "status", output, result.exitCode === 0 ? "success" : "failure", server.id);
  }

  // /process
  bot.command("process", requireAuth(), async (ctx) => {
    const server = await pickServer(ctx, "process", "process");
    if (!server) return;
    await runProcess(ctx, server);
  });

  bot.action(/^process:(.+)$/, requireAuth(), async (ctx) => {
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.split(":")[1];
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runProcess(ctx, server);
  });

  async function runProcess(ctx: Context, server: Server): Promise<void> {
    const msg = await ctx.reply(`Fetching processes from *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await getProcessList(server);
    const output = result.stdout || result.stderr || "No output";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `*${server.name}* processes:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), "process", output, result.exitCode === 0 ? "success" : "failure", server.id);
  }

  // /apps [server]
  bot.command("apps", requireAuth(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    let apps;
    if (args[0]) {
      const server = findServer(args[0]);
      if (!server) { await ctx.reply(`Unknown server: ${args[0]}`); return; }
      apps = listApps(server.id);
    } else {
      apps = listApps();
    }
    if (apps.length === 0) {
      await ctx.reply("No applications registered.");
      return;
    }
    const lines = apps.map((a) => {
      const server = findServer(a.server_id);
      return `*${a.name}*  server: \`${server?.name ?? a.server_id}\`  branch: \`${a.deploy_branch}\`  path: \`${a.path}\``;
    });
    await replyMd(ctx, lines.join("\n"));
  });

  // /logs [lines]
  bot.command("logs", requireAuth(), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const lines = Math.min(parseInt(args[0] ?? "50", 10) || 50, 200);
    const server = await pickServer(ctx, `logs_${lines}`, "logs");
    if (!server) return;
    await runLogs(ctx, server, lines);
  });

  bot.action(/^logs_(\d+):(.+)$/, requireAuth(), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const [, linesStr, serverName] = data.match(/^logs_(\d+):(.+)$/) ?? [];
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runLogs(ctx, server, parseInt(linesStr, 10) || 50);
  });

  async function runLogs(ctx: Context, server: Server, lines: number): Promise<void> {
    const msg = await ctx.reply(`Fetching logs from *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await getPm2Logs(server, lines);
    const output = result.stdout || result.stderr || "No output";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `*${server.name}* logs:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), "logs", output, result.exitCode === 0 ? "success" : "failure", server.id);
  }

  // /deploy <app>
  bot.command("deploy", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const appName = args[0];
    if (!appName) { await ctx.reply("Usage: /deploy <app_name>"); return; }
    const app = findApp(appName);
    if (!app) { await ctx.reply(`Unknown app: \`${appName}\`\n\nUse /apps to list.`, { parse_mode: "Markdown" }); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.reply("Server for this app not found."); return; }

    const msg = await ctx.reply(`Deploying *${app.name}* on *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await deployApp(server, app);
    const output = result.stdout || result.stderr || "No output";
    const status = result.exitCode === 0 ? "success" : "failure";
    const icon = status === "success" ? "✅" : "❌";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `${icon} Deploy *${app.name}* on *${server.name}*:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), `deploy:${app.name}`, output, status, server.id);
  });

  // /run <cmd_name> <server_name>
  bot.command("run", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      const all = listCommands().map((c) => `\`${c.name}\` — ${c.description}`).join("\n");
      await ctx.reply(`Usage: /run <command> <server>\n\n*Commands:*\n${all}`, { parse_mode: "Markdown" });
      return;
    }
    const [cmdName, serverName] = args;
    const cmd = findCommand(cmdName);
    if (!cmd) { await ctx.reply(`Unknown command: \`${cmdName}\``, { parse_mode: "Markdown" }); return; }
    const server = findServer(serverName);
    if (!server) { await ctx.reply(`Unknown server: \`${serverName}\``, { parse_mode: "Markdown" }); return; }

    const user = findUser(ctx.from.id)!;
    if (!cmd.allowed_roles.split(",").includes(user.role)) {
      await ctx.reply("You do not have permission to run this command.");
      return;
    }

    const msg = await ctx.reply(`Running \`${cmd.name}\` on *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await sshExec(server, cmd.script);
    const output = result.stdout || result.stderr || "No output";
    const status = result.exitCode === 0 ? "success" : "failure";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), `run:${cmd.name}`, output, status, server.id);
  });

  // /addserver name|host|port|user|/path/to/key|description
  bot.command("addserver", requireAuth("admin"), async (ctx) => {
    const raw = ctx.message.text.replace(/^\/addserver\s+/, "").trim();
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await ctx.reply(
        "Usage: `/addserver name|host|port|user|/path/to/key|description`\n" +
        "Example: `/addserver prod|192.168.1.10|22|ubuntu|/home/bot/.ssh/id_rsa|Production`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    const [name, host, portStr, username, sshKeyPath, description] = parts;
    const port = parseInt(portStr, 10) || 22;
    upsertServer(name, host, port, username, sshKeyPath, description);
    await ctx.reply(`Server \`${name}\` saved.`, { parse_mode: "Markdown" });
  });

  // /delserver <name>
  bot.command("delserver", requireAuth("admin"), async (ctx) => {
    const name = ctx.message.text.split(/\s+/)[1];
    if (!name) { await ctx.reply("Usage: /delserver <name>"); return; }
    deleteServer(name);
    await ctx.reply(`Server \`${name}\` removed.`, { parse_mode: "Markdown" });
  });

  // /addapp name|server|path|start_cmd|branch|build_cmd
  bot.command("addapp", requireAuth("admin"), async (ctx) => {
    const raw = ctx.message.text.replace(/^\/addapp\s+/, "").trim();
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await ctx.reply(
        "Usage: `/addapp name|server|path|start_cmd|branch|build_cmd`\n" +
        "Example: `/addapp myapp|prod|/srv/myapp|pm2 restart myapp|main|npm run build`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    const [name, serverName, appPath, startCmd, branch, buildCmd] = parts;
    const server = findServer(serverName);
    if (!server) { await ctx.reply(`Unknown server: \`${serverName}\``, { parse_mode: "Markdown" }); return; }
    upsertApp(name, server.id, appPath, startCmd, buildCmd ?? null, branch);
    await ctx.reply(`App \`${name}\` saved on server \`${serverName}\`.`, { parse_mode: "Markdown" });
  });

  // /adduser <telegram_id> [role]
  bot.command("adduser", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const rawId = parseInt(args[0] ?? "", 10);
    if (isNaN(rawId)) { await ctx.reply("Usage: /adduser <telegram_id> [admin|viewer]"); return; }
    const role = args[1] === "admin" ? "admin" : "viewer";
    addUser(rawId, null, role);
    await ctx.reply(`User \`${rawId}\` added with role \`${role}\`.`, { parse_mode: "Markdown" });
  });

  // /audit [n]
  bot.command("audit", requireAuth("admin"), async (ctx) => {
    const limit = Math.min(parseInt(ctx.message.text.split(/\s+/)[1] ?? "10", 10) || 10, 50);
    const logs = getRecentLogs(limit) as Array<{
      command: string; status: string; created_at: string;
      username: string | null; telegram_id: number; server_name: string | null;
    }>;
    if (logs.length === 0) { await ctx.reply("No audit logs yet."); return; }
    const lines = logs.map(
      (l) =>
        `[${l.created_at}] ${l.username ?? l.telegram_id} @${l.server_name ?? "local"} » \`${l.command}\` → ${l.status}`
    );
    await replyMd(ctx, lines.join("\n"));
  });
}
