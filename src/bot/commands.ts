import { Telegraf, Context, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { CallbackQuery } from "telegraf/types";
import { requireAuth } from "../auth/authGuard";
import {
  findUser, findCommand, listCommands, listApps, findApp, listServers, findServer,
  addUser, upsertApp, upsertServer, deleteServer, logExecution, getRecentLogs,
  setAppGroup, listGroups, listAppsByGroup,
  Server, App,
} from "../db/db";
import { sshExec, truncateOutput } from "../executor/sshExecutor";
import {
  getSystemStatus, getProcessList, getPm2Logs,
  getSysOverview, getSysCpu, getSysMemory, getSysDisk, getSysNetwork, getSysAll,
} from "../services/systemService";
import { deployApp, restartApp, stopApp } from "../services/deployService";
import { config } from "../config/config";

// ---------- edit session state ----------

interface EditSession {
  type: "server";
  serverName: string;
  field: "host" | "port" | "username" | "sshkey" | "password" | "description";
}

interface EditAppSession {
  type: "app";
  appName: string;
  field: "server" | "path" | "start_command" | "build_command" | "deploy_branch" | "group_name";
}

const editSessions = new Map<number, EditSession | EditAppSession>(); // key = telegram_id

const CONFIG_DISABLED_MSG = "Chức năng cấu hình qua bot đã tắt. Vui lòng sử dụng Web Admin.";

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
      "/sysinfo       — System info menu (CPU/RAM/Disk/Network)",
      "/process       — Running processes",
      "/apps [server] — Managed applications",
      "/logs [lines]  — View PM2 logs",
      "/servers       — List servers",
      "/deploy <app>  — Deploy app (admin)",
      "/restart <app> — Restart app (admin)",
      "/stop <app>    — Stop app (admin)",
      "/deploygroup <group> — Deploy all apps in group (admin)",
      "/restartgroup <group> — Restart all apps in group (admin)",
      "/stopgroup <group> — Stop all apps in group (admin)",
      "/groups        — List app groups",
      "/run <cmd> <server> — Run whitelisted command (admin)",
      "/audit [n]     — Audit log (admin)",
    ];
    if (config.botConfigEnabled) {
      cmds.push(
        "/setgroup <app> <group> — Assign app to group (admin)",
        "/ungroup <app> — Remove app from group (admin)",
        "/addserver     — Register server (admin)",
        "/editapp       — Edit application (admin)",
        "/addapp        — Register application (admin)",
        "/adduser <id> [role] — Add user (admin)",
      );
    }
    await ctx.reply("*Commands:*\n" + cmds.join("\n"), { parse_mode: "Markdown" });
  });

  // /servers — list with Edit / Delete buttons
  bot.command("servers", requireAuth(), async (ctx) => {
    const servers = listServers();
    if (servers.length === 0) {
      await ctx.reply("No servers registered.");
      return;
    }
    for (const s of servers) {
      const info =
        `*${s.name}*\n` +
        `Host: \`${s.host}:${s.port}\`\n` +
        `User: \`${s.username}\`\n` +
        (s.ssh_key_path ? `Key:  \`${s.ssh_key_path}\`` : `Auth: \`password\``) +
        (s.description ? `\n${s.description}` : "");
      await ctx.reply(info, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          Markup.button.callback("✏️ Edit", `editsvr_pick:${s.name}`),
          Markup.button.callback("🗑 Xoá",  `delsvr_confirm:${s.name}`),
        ]),
      });
    }
  });

  // delete confirmation
  bot.action(/^delsvr_confirm:(.+)$/, requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.answerCbQuery(CONFIG_DISABLED_MSG); return; }
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("delsvr_confirm:", "");
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Xác nhận xoá", `delsvr_do:${serverName}`),
        Markup.button.callback("❌ Huỷ",           `delsvr_cancel:${serverName}`),
      ]).reply_markup
    );
  });

  bot.action(/^delsvr_do:(.+)$/, requireAuth("admin"), async (ctx) => {
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("delsvr_do:", "");
    deleteServer(serverName);
    await ctx.answerCbQuery("Đã xoá");
    await ctx.deleteMessage();
    await ctx.reply(`🗑 Server \`${serverName}\` đã được xoá.`, { parse_mode: "Markdown" });
  });

  bot.action(/^delsvr_cancel:(.+)$/, requireAuth("admin"), async (ctx) => {
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("delsvr_cancel:", "");
    const server = findServer(serverName);
    await ctx.answerCbQuery("Đã huỷ");
    if (!server) { await ctx.deleteMessage(); return; }
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        Markup.button.callback("✏️ Edit", `editsvr_pick:${server.name}`),
        Markup.button.callback("🗑 Xoá",  `delsvr_confirm:${server.name}`),
      ]).reply_markup
    );
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

  // /sysinfo — inline menu: overview | cpu | memory | disk | network | all
  bot.command("sysinfo", requireAuth(), async (ctx) => {
    const server = await pickServer(ctx, "syspick", "sysinfo");
    if (!server) return;
    await ctx.reply(
      `*${server.name}* — Chọn thông tin cần xem:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📋 Tổng quan", `sysinfo:overview:${server.name}`),
            Markup.button.callback("🖥 CPU",        `sysinfo:cpu:${server.name}`),
          ],
          [
            Markup.button.callback("💾 Bộ nhớ",    `sysinfo:memory:${server.name}`),
            Markup.button.callback("💽 Ổ đĩa",     `sysinfo:disk:${server.name}`),
          ],
          [
            Markup.button.callback("🌐 Mạng",      `sysinfo:network:${server.name}`),
            Markup.button.callback("📊 Tất cả",    `sysinfo:all:${server.name}`),
          ],
        ]),
      }
    );
  });

  // server picker callback for sysinfo
  bot.action(/^syspick:(.+)$/, requireAuth(), async (ctx) => {
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.split(":")[1];
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `*${server.name}* — Chọn thông tin cần xem:`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📋 Tổng quan", `sysinfo:overview:${server.name}`),
            Markup.button.callback("🖥 CPU",        `sysinfo:cpu:${server.name}`),
          ],
          [
            Markup.button.callback("💾 Bộ nhớ",    `sysinfo:memory:${server.name}`),
            Markup.button.callback("💽 Ổ đĩa",     `sysinfo:disk:${server.name}`),
          ],
          [
            Markup.button.callback("🌐 Mạng",      `sysinfo:network:${server.name}`),
            Markup.button.callback("📊 Tất cả",    `sysinfo:all:${server.name}`),
          ],
        ]),
      }
    );
  });

  // sysinfo section callbacks
  bot.action(/^sysinfo:(overview|cpu|memory|disk|network|all):(.+)$/, requireAuth(), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const m = data.match(/^sysinfo:(overview|cpu|memory|disk|network|all):(.+)$/);
    if (!m) { await ctx.answerCbQuery(); return; }
    const [, section, serverName] = m;
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runSysInfo(ctx, server, section as "overview" | "cpu" | "memory" | "disk" | "network" | "all");
  });

  const sysInfoLabels: Record<string, string> = {
    overview: "📋 Tổng quan",
    cpu:      "🖥 CPU",
    memory:   "💾 Bộ nhớ",
    disk:     "💽 Ổ đĩa",
    network:  "🌐 Mạng",
    all:      "📊 Tất cả",
  };

  const sysInfoFns: Record<string, (s: Server) => ReturnType<typeof getSysAll>> = {
    overview: getSysOverview,
    cpu:      getSysCpu,
    memory:   getSysMemory,
    disk:     getSysDisk,
    network:  getSysNetwork,
    all:      getSysAll,
  };

  async function runSysInfo(
    ctx: Context,
    server: Server,
    section: "overview" | "cpu" | "memory" | "disk" | "network" | "all"
  ): Promise<void> {
    const label = sysInfoLabels[section];
    const msg = await ctx.reply(`Đang lấy thông tin *${label}* từ *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await sysInfoFns[section](server);
    const output = result.stdout || result.stderr || "No output";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `${label} — *${server.name}*:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), `sysinfo:${section}`, output, result.exitCode === 0 ? "success" : "failure", server.id);
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
    let filterServer: Server | undefined;
    if (args[0]) {
      const server = findServer(args[0]);
      if (!server) { await ctx.reply(`Unknown server: ${args[0]}`); return; }
      filterServer = server;
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
      const group = a.group_name ? `  group: \`${a.group_name}\`` : "";
      return `*${a.name}*  server: \`${server?.name ?? a.server_id}\`  branch: \`${a.deploy_branch}\`${group}  path: \`${a.path}\``;
    });

    // Build suggestion buttons for each app
    const appButtons = apps.map((a) => [
      Markup.button.callback(`🚀 Deploy ${a.name}`, `deploy_app:${a.name}`),
      Markup.button.callback(`🔄 Restart ${a.name}`, `restart_app:${a.name}`),
      Markup.button.callback(`⛔ Stop ${a.name}`, `stop_app:${a.name}`),
    ]);

    // Add server filter buttons if not already filtered and multiple servers exist
    const servers = listServers();
    if (!filterServer && servers.length > 1) {
      const serverButtons = servers.map((s) =>
        Markup.button.callback(`🖥 ${s.name}`, `apps_server:${s.name}`)
      );
      appButtons.push(serverButtons);
    }

    await ctx.reply(
      lines.join("\n"),
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(appButtons) }
    );
  });

  // Callback: filter apps by server
  bot.action(/^apps_server:(.+)$/, requireAuth(), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const serverName = data.match(/^apps_server:(.+)$/)![1];
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();

    const apps = listApps(server.id);
    if (apps.length === 0) {
      await ctx.editMessageText(`No apps on server *${server.name}*.`, { parse_mode: "Markdown" });
      return;
    }
    const lines = apps.map((a) => {
      const group = a.group_name ? `  group: \`${a.group_name}\`` : "";
      return `*${a.name}*  server: \`${server.name}\`  branch: \`${a.deploy_branch}\`${group}  path: \`${a.path}\``;
    });

    const appButtons = apps.map((a) => [
      Markup.button.callback(`🚀 Deploy ${a.name}`, `deploy_app:${a.name}`),
      Markup.button.callback(`🔄 Restart ${a.name}`, `restart_app:${a.name}`),
      Markup.button.callback(`⛔ Stop ${a.name}`, `stop_app:${a.name}`),
    ]);

    await ctx.editMessageText(
      `📂 *Apps on ${server.name}:*\n` + lines.join("\n"),
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(appButtons) }
    );
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
    if (!appName) {
      const apps = listApps();
      if (apps.length === 0) { await ctx.reply("No apps registered."); return; }
      const buttons = apps.map((a) => {
        const server = findServer(a.server_id);
        return Markup.button.callback(`🚀 ${a.name} (${server?.name ?? "?"})`, `deploy_app:${a.name}`);
      });
      await ctx.reply("Chọn app cần deploy:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
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

  bot.action(/^deploy_app:(.+)$/, requireAuth("admin"), async (ctx) => {
    const appName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("deploy_app:", "");
    const app = findApp(appName);
    if (!app) { await ctx.answerCbQuery("App not found"); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();

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

  // /restart <app> — restart single app
  bot.command("restart", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const appName = args[0];
    if (!appName) {
      const apps = listApps();
      if (apps.length === 0) { await ctx.reply("No apps registered."); return; }
      const buttons = apps.map((a) => {
        const server = findServer(a.server_id);
        return Markup.button.callback(`🔄 ${a.name} (${server?.name ?? "?"})`, `restart_app:${a.name}`);
      });
      await ctx.reply("Chọn app cần restart:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
    const app = findApp(appName);
    if (!app) { await ctx.reply(`Unknown app: \`${appName}\`\n\nUse /apps to list.`, { parse_mode: "Markdown" }); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.reply("Server for this app not found."); return; }
    await runRestartApp(ctx, server, app);
  });

  bot.action(/^restart_app:(.+)$/, requireAuth("admin"), async (ctx) => {
    const appName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("restart_app:", "");
    const app = findApp(appName);
    if (!app) { await ctx.answerCbQuery("App not found"); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runRestartApp(ctx, server, app);
  });

  async function runRestartApp(ctx: Context, server: Server, app: App): Promise<void> {
    const msg = await ctx.reply(`Restarting *${app.name}* on *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await restartApp(server, app);
    const output = result.stdout || result.stderr || "No output";
    const status = result.exitCode === 0 ? "success" : "failure";
    const icon = status === "success" ? "✅" : "❌";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `${icon} Restart *${app.name}* on *${server.name}*:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), `restart:${app.name}`, output, status, server.id);
  }

  // /stop [app_name]
  bot.command("stop", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const appName = args[0];
    if (!appName) {
      const apps = listApps();
      if (apps.length === 0) { await ctx.reply("No apps registered."); return; }
      const buttons = apps.map((a) => {
        const server = findServer(a.server_id);
        return Markup.button.callback(`⏹ ${a.name} (${server?.name ?? "?"})`, `stop_app:${a.name}`);
      });
      await ctx.reply("Chọn app cần stop:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
    const app = findApp(appName);
    if (!app) { await ctx.reply(`Unknown app: \`${appName}\`\n\nUse /apps to list.`, { parse_mode: "Markdown" }); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.reply("Server for this app not found."); return; }
    await runStopApp(ctx, server, app);
  });

  bot.action(/^stop_app:(.+)$/, requireAuth("admin"), async (ctx) => {
    const appName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("stop_app:", "");
    const app = findApp(appName);
    if (!app) { await ctx.answerCbQuery("App not found"); return; }
    const server = findServer(app.server_id);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await runStopApp(ctx, server, app);
  });

  async function runStopApp(ctx: Context, server: Server, app: App): Promise<void> {
    const msg = await ctx.reply(`Stopping *${app.name}* on *${server.name}*…`, { parse_mode: "Markdown" });
    const result = await stopApp(server, app);
    const output = result.stdout || result.stderr || "No output";
    const status = result.exitCode === 0 ? "success" : "failure";
    const icon = status === "success" ? "✅" : "❌";
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `${icon} Stop *${app.name}* on *${server.name}*:\n\`\`\`\n${truncateOutput(output)}\n\`\`\``,
      { parse_mode: "Markdown" }
    );
    logExecution(userId(ctx), `stop:${app.name}`, output, status, server.id);
  }

  // /run <cmd_name> <server_name>
  bot.command("run", requireAuth("admin"), async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      const commands = listCommands();
      const servers = listServers();
      if (commands.length === 0 || servers.length === 0) {
        const all = commands.map((c) => `\`${c.name}\` — ${c.description}`).join("\n");
        await ctx.reply(`Usage: /run <command> <server>\n\n*Commands:*\n${all}`, { parse_mode: "Markdown" });
        return;
      }
      const buttons: ReturnType<typeof Markup.button.callback>[] = [];
      for (const cmd of commands) {
        for (const srv of servers) {
          buttons.push(Markup.button.callback(`▶️ ${cmd.name} @ ${srv.name}`, `run_cmd:${cmd.name}:${srv.name}`));
        }
      }
      await ctx.reply("Chọn lệnh cần chạy:", Markup.inlineKeyboard(buttons, { columns: 1 }));
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

  bot.action(/^run_cmd:(.+):(.+)$/, requireAuth("admin"), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const m = data.match(/^run_cmd:(.+):(.+)$/);
    if (!m) { await ctx.answerCbQuery(); return; }
    const [, cmdName, serverName] = m;
    const cmd = findCommand(cmdName);
    if (!cmd) { await ctx.answerCbQuery("Command not found"); return; }
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }

    const user = findUser(ctx.from!.id)!;
    if (!cmd.allowed_roles.split(",").includes(user.role)) {
      await ctx.answerCbQuery("No permission");
      return;
    }

    await ctx.answerCbQuery();
    await ctx.deleteMessage();

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

  // /addserver name|host|port|user|key_or_password|description
  // key_or_password: path starting with / or ~ = SSH key; otherwise = password; use "-" to leave empty
  bot.command("addserver", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const raw = ctx.message.text.replace(/^\/addserver\s+/, "").trim();
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await ctx.reply(
        "Usage: `/addserver name|host|port|user|key_or_pass|description`\n\n" +
        "• SSH key: `/addserver prod|1.2.3.4|22|ubuntu|~/.ssh/id_rsa|Production`\n" +
        "• Password: `/addserver prod|1.2.3.4|22|ubuntu|mypassword|Production`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    const [name, host, portStr, username, cred, description] = parts;
    const port = parseInt(portStr, 10) || 22;
    const isKey = cred.startsWith("/") || cred.startsWith("~");
    upsertServer(name, host, port, username,
      isKey ? cred : null, description,
      isKey ? undefined : cred
    );
    await ctx.reply(
      `Server \`${name}\` saved (auth: ${isKey ? "SSH key" : "password"}).`,
      { parse_mode: "Markdown" }
    );
  });

  // /delserver <name>
  bot.command("delserver", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const name = ctx.message.text.split(/\s+/)[1];
    if (!name) { await ctx.reply("Usage: /delserver <name>"); return; }
    deleteServer(name);
    await ctx.reply(`Server \`${name}\` removed.`, { parse_mode: "Markdown" });
  });

  // /editserver — pick server then pick field to edit
  bot.command("editserver", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const servers = listServers();
    if (servers.length === 0) { await ctx.reply("No servers registered."); return; }
    const buttons = servers.map((s) =>
      Markup.button.callback(`🖥 ${s.name} (${s.host})`, `editsvr_pick:${s.name}`)
    );
    await ctx.reply("Chọn server cần chỉnh sửa:", Markup.inlineKeyboard(buttons, { columns: 1 }));
  });

  function serverFieldKeyboard(serverName: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("🌐 Host",        `editsvr_field:host:${serverName}`),
        Markup.button.callback("🔌 Port",        `editsvr_field:port:${serverName}`),
      ],
      [
        Markup.button.callback("👤 Username",    `editsvr_field:username:${serverName}`),
        Markup.button.callback("🔑 SSH Key Path", `editsvr_field:sshkey:${serverName}`),
      ],
      [
        Markup.button.callback("🔒 Password",    `editsvr_field:password:${serverName}`),
        Markup.button.callback("📝 Description", `editsvr_field:description:${serverName}`),
      ],
      [
        Markup.button.callback("❌ Huỷ",          "editsvr_cancel"),
      ],
    ]);
  }

  bot.action(/^editsvr_pick:(.+)$/, requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.answerCbQuery(CONFIG_DISABLED_MSG); return; }
    const serverName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("editsvr_pick:", "");
    const server = findServer(serverName);
    if (!server) { await ctx.answerCbQuery("Server not found"); return; }
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `*${server.name}* — Chọn trường cần sửa:\n` +
      `Host: \`${server.host}\`  Port: \`${server.port}\`\n` +
      `User: \`${server.username}\`\n` +
      (server.ssh_key_path ? `Key: \`${server.ssh_key_path}\`` : `Auth: \`password\``) + "\n" +
      (server.description ? `Desc: ${server.description}` : ""),
      { parse_mode: "Markdown", ...serverFieldKeyboard(server.name) }
    );
  });

  bot.action(/^editsvr_field:(host|port|username|sshkey|password|description):(.+)$/, requireAuth("admin"), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const m = data.match(/^editsvr_field:(host|port|username|sshkey|password|description):(.+)$/);
    if (!m) { await ctx.answerCbQuery(); return; }
    const [, field, serverName] = m as [string, EditSession["field"], string];
    await ctx.answerCbQuery();
    editSessions.set(ctx.from!.id, { type: "server", serverName, field });
    const labels: Record<EditSession["field"], string> = {
      host: "Host (IP hoặc domain)",
      port: "Port (số)",
      username: "Username SSH",
      sshkey: "Đường dẫn SSH key",
      password: "Mật khẩu SSH",
      description: "Mô tả server",
    };
    await ctx.editMessageText(
      `Nhập giá trị mới cho *${labels[field]}* của server *${serverName}*:\n_(Gửi /cancel để huỷ)_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action("editsvr_cancel", async (ctx) => {
    editSessions.delete(ctx.from!.id);
    await ctx.answerCbQuery("Đã huỷ");
    await ctx.deleteMessage();
  });

  // /editapp — pick app then pick field to edit
  bot.command("editapp", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const apps = listApps();
    if (apps.length === 0) { await ctx.reply("No apps registered."); return; }
    const buttons = apps.map((a) => {
      const server = findServer(a.server_id);
      return Markup.button.callback(`📦 ${a.name} (${server?.name ?? "?"})`, `editapp_pick:${a.name}`);
    });
    await ctx.reply("Chọn app cần chỉnh sửa:", Markup.inlineKeyboard(buttons, { columns: 1 }));
  });

  function appFieldKeyboard(appName: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("🖥 Server",       `editapp_field:server:${appName}`),
        Markup.button.callback("📁 Path",          `editapp_field:path:${appName}`),
      ],
      [
        Markup.button.callback("▶️ Start Cmd",     `editapp_field:start_command:${appName}`),
        Markup.button.callback("🔨 Build Cmd",     `editapp_field:build_command:${appName}`),
      ],
      [
        Markup.button.callback("🌿 Branch",        `editapp_field:deploy_branch:${appName}`),
        Markup.button.callback("📂 Group",          `editapp_field:group_name:${appName}`),
      ],
      [
        Markup.button.callback("❌ Huỷ",            "editapp_cancel"),
      ],
    ]);
  }

  bot.action(/^editapp_pick:(.+)$/, requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.answerCbQuery(CONFIG_DISABLED_MSG); return; }
    const appName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("editapp_pick:", "");
    const app = findApp(appName);
    if (!app) { await ctx.answerCbQuery("App not found"); return; }
    const server = findServer(app.server_id);
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `*${app.name}* — Chọn trường cần sửa:\n` +
      `Server: \`${server?.name ?? "?"}\`\n` +
      `Path: \`${app.path}\`\n` +
      `Start: \`${app.start_command}\`\n` +
      (app.build_command ? `Build: \`${app.build_command}\`\n` : "") +
      `Branch: \`${app.deploy_branch}\`\n` +
      (app.group_name ? `Group: \`${app.group_name}\`` : "Group: _none_"),
      { parse_mode: "Markdown", ...appFieldKeyboard(app.name) }
    );
  });

  bot.action(/^editapp_field:(server|path|start_command|build_command|deploy_branch|group_name):(.+)$/, requireAuth("admin"), async (ctx) => {
    const data = (ctx.callbackQuery as CallbackQuery.DataQuery).data;
    const m = data.match(/^editapp_field:(server|path|start_command|build_command|deploy_branch|group_name):(.+)$/);
    if (!m) { await ctx.answerCbQuery(); return; }
    const [, field, appName] = m as [string, EditAppSession["field"], string];
    await ctx.answerCbQuery();
    editSessions.set(ctx.from!.id, { type: "app", appName, field });
    const labels: Record<EditAppSession["field"], string> = {
      server: "Tên server",
      path: "Đường dẫn ứng dụng",
      start_command: "Lệnh khởi động",
      build_command: "Lệnh build",
      deploy_branch: "Branch deploy",
      group_name: "Tên nhóm (gửi - để xoá)",
    };
    await ctx.editMessageText(
      `Nhập giá trị mới cho *${labels[field]}* của app *${appName}*:\n_(Gửi /cancel để huỷ)_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action("editapp_cancel", async (ctx) => {
    editSessions.delete(ctx.from!.id);
    await ctx.answerCbQuery("Đã huỷ");
    await ctx.deleteMessage();
  });

  // handle text input for edit session (server & app)
  bot.on(message("text"), requireAuth(), async (ctx, next) => {
    const telegramId = ctx.from!.id;
    const session = editSessions.get(telegramId);
    if (!session) return next();

    const text = ctx.message.text.trim();
    if (text === "/cancel") {
      editSessions.delete(telegramId);
      await ctx.reply("Đã huỷ chỉnh sửa.");
      return;
    }

    if (session.type === "server") {
      const server = findServer(session.serverName);
      if (!server) {
        editSessions.delete(telegramId);
        await ctx.reply("Server không còn tồn tại.");
        return;
      }

      const updated = {
        host: server.host,
        port: server.port,
        username: server.username,
        sshKeyPath: server.ssh_key_path,
        sshPassword: server.ssh_password,
        description: server.description ?? undefined,
      };

      if (session.field === "port") {
        const p = parseInt(text, 10);
        if (isNaN(p) || p < 1 || p > 65535) {
          await ctx.reply("Port không hợp lệ. Vui lòng nhập số từ 1-65535.");
          return;
        }
        updated.port = p;
      } else if (session.field === "host")        { updated.host = text; }
        else if (session.field === "username")    { updated.username = text; }
        else if (session.field === "sshkey")      { updated.sshKeyPath = text; updated.sshPassword = null; }
        else if (session.field === "password")    { updated.sshPassword = text; updated.sshKeyPath = null; }
        else if (session.field === "description") { updated.description = text; }

      upsertServer(server.name, updated.host, updated.port, updated.username,
        updated.sshKeyPath ?? null, updated.description, updated.sshPassword ?? undefined);
      editSessions.delete(telegramId);

      const fieldLabels: Record<EditSession["field"], string> = {
        host: "Host", port: "Port", username: "Username",
        sshkey: "SSH Key Path", password: "Password", description: "Description",
      };
      await ctx.reply(
        `✅ Đã cập nhật *${fieldLabels[session.field]}* của server *${server.name}*.\nGiá trị mới: \`${text}\``,
        { parse_mode: "Markdown" }
      );
    } else {
      // Edit app session
      const app = findApp(session.appName);
      if (!app) {
        editSessions.delete(telegramId);
        await ctx.reply("App không còn tồn tại.");
        return;
      }

      if (session.field === "server") {
        const newServer = findServer(text);
        if (!newServer) {
          await ctx.reply(`Server \`${text}\` không tồn tại. Vui lòng nhập lại.`, { parse_mode: "Markdown" });
          return;
        }
        upsertApp(app.name, newServer.id, app.path, app.start_command, app.build_command, app.deploy_branch, app.group_name);
      } else if (session.field === "group_name") {
        const val = text === "-" ? null : text;
        upsertApp(app.name, app.server_id, app.path, app.start_command, app.build_command, app.deploy_branch, val);
      } else if (session.field === "build_command") {
        const val = text === "-" ? null : text;
        upsertApp(app.name, app.server_id, app.path, app.start_command, val, app.deploy_branch, app.group_name);
      } else if (session.field === "path") {
        upsertApp(app.name, app.server_id, text, app.start_command, app.build_command, app.deploy_branch, app.group_name);
      } else if (session.field === "start_command") {
        upsertApp(app.name, app.server_id, app.path, text, app.build_command, app.deploy_branch, app.group_name);
      } else if (session.field === "deploy_branch") {
        upsertApp(app.name, app.server_id, app.path, app.start_command, app.build_command, text, app.group_name);
      }

      editSessions.delete(telegramId);

      const fieldLabels: Record<EditAppSession["field"], string> = {
        server: "Server", path: "Path", start_command: "Start Command",
        build_command: "Build Command", deploy_branch: "Branch", group_name: "Group",
      };
      await ctx.reply(
        `✅ Đã cập nhật *${fieldLabels[session.field]}* của app *${app.name}*.\nGiá trị mới: \`${text}\``,
        { parse_mode: "Markdown" }
      );
    }
  });

  // /addapp name|server|path|start_cmd|branch|build_cmd|group
  bot.command("addapp", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const raw = ctx.message.text.replace(/^\/addapp\s+/, "").trim();
    const parts = raw.split("|").map((s) => s.trim());
    if (parts.length < 5) {
      await ctx.reply(
        "Usage: `/addapp name|server|path|start_cmd|branch|build_cmd|group`\n" +
        "Example: `/addapp myapp|prod|/srv/myapp|pm2 restart myapp|main|npm run build|backend`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    const [name, serverName, appPath, startCmd, branch, buildCmd, groupName] = parts;
    const server = findServer(serverName);
    if (!server) { await ctx.reply(`Unknown server: \`${serverName}\``, { parse_mode: "Markdown" }); return; }
    upsertApp(name, server.id, appPath, startCmd, buildCmd ?? null, branch, groupName);
    const groupInfo = groupName ? ` group: \`${groupName}\`` : "";
    await ctx.reply(`App \`${name}\` saved on server \`${serverName}\`.${groupInfo}`, { parse_mode: "Markdown" });
  });

  // /groups — list all groups and their apps
  bot.command("groups", requireAuth(), async (ctx) => {
    const groups = listGroups();
    if (groups.length === 0) {
      await ctx.reply("Chưa có nhóm nào. Dùng /setgroup <app> <group> để gán app vào nhóm.");
      return;
    }
    const lines: string[] = [];
    const buttons: ReturnType<typeof Markup.button.callback>[] = [];
    for (const g of groups) {
      const apps = listAppsByGroup(g);
      const appNames = apps.map((a) => {
        const server = findServer(a.server_id);
        return `  • \`${a.name}\` @ \`${server?.name ?? "?"}\``;
      });
      lines.push(`*${g}* (${apps.length} apps)\n${appNames.join("\n")}`);
      buttons.push(
        Markup.button.callback(`🚀 Deploy ${g}`, `deploygrp:${g}`),
        Markup.button.callback(`🔄 Restart ${g}`, `restartgrp:${g}`),
      );
    }
    await ctx.reply(lines.join("\n\n"), {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons, { columns: 2 }),
    });
  });

  // /setgroup <app> <group>
  bot.command("setgroup", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      await ctx.reply("Usage: `/setgroup <app_name> <group_name>`", { parse_mode: "Markdown" });
      return;
    }
    const [appName, groupName] = args;
    const app = findApp(appName);
    if (!app) { await ctx.reply(`Unknown app: \`${appName}\``, { parse_mode: "Markdown" }); return; }
    setAppGroup(appName, groupName);
    await ctx.reply(`App \`${appName}\` đã được gán vào nhóm \`${groupName}\`.`, { parse_mode: "Markdown" });
  });

  // /ungroup <app>
  bot.command("ungroup", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
    const appName = ctx.message.text.split(/\s+/)[1];
    if (!appName) { await ctx.reply("Usage: `/ungroup <app_name>`", { parse_mode: "Markdown" }); return; }
    const app = findApp(appName);
    if (!app) { await ctx.reply(`Unknown app: \`${appName}\``, { parse_mode: "Markdown" }); return; }
    setAppGroup(appName, null);
    await ctx.reply(`App \`${appName}\` đã được xoá khỏi nhóm.`, { parse_mode: "Markdown" });
  });

  // /deploygroup <group> — deploy all apps in a group
  bot.command("deploygroup", requireAuth("admin"), async (ctx) => {
    const groupName = ctx.message.text.split(/\s+/)[1];
    if (!groupName) {
      const groups = listGroups();
      if (groups.length === 0) { await ctx.reply("Chưa có nhóm nào."); return; }
      const buttons = groups.map((g) =>
        Markup.button.callback(`🚀 ${g} (${listAppsByGroup(g).length} apps)`, `deploygrp:${g}`)
      );
      await ctx.reply("Chọn nhóm cần deploy:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) {
      await ctx.reply(`Nhóm \`${groupName}\` không có app nào.`, { parse_mode: "Markdown" });
      return;
    }

    const msg = await ctx.reply(
      `Đang deploy nhóm *${groupName}* (${apps.length} apps)…`,
      { parse_mode: "Markdown" }
    );

    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await deployApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `deploy:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }

    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Deploy nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  // /restartgroup <group> — restart all apps in a group (start_command only)
  bot.command("restartgroup", requireAuth("admin"), async (ctx) => {
    const groupName = ctx.message.text.split(/\s+/)[1];
    if (!groupName) {
      const groups = listGroups();
      if (groups.length === 0) { await ctx.reply("Chưa có nhóm nào."); return; }
      const buttons = groups.map((g) =>
        Markup.button.callback(`🔄 ${g} (${listAppsByGroup(g).length} apps)`, `restartgrp:${g}`)
      );
      await ctx.reply("Chọn nhóm cần restart:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) {
      await ctx.reply(`Nhóm \`${groupName}\` không có app nào.`, { parse_mode: "Markdown" });
      return;
    }

    const msg = await ctx.reply(
      `Đang restart nhóm *${groupName}* (${apps.length} apps)…`,
      { parse_mode: "Markdown" }
    );

    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await restartApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `restart:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }

    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Restart nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^deploygrp:(.+)$/, requireAuth("admin"), async (ctx) => {
    const groupName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("deploygrp:", "");
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) { await ctx.answerCbQuery("Nhóm không có app nào"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();

    const msg = await ctx.reply(`Đang deploy nhóm *${groupName}* (${apps.length} apps)…`, { parse_mode: "Markdown" });
    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await deployApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `deploy:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Deploy nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^restartgrp:(.+)$/, requireAuth("admin"), async (ctx) => {
    const groupName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("restartgrp:", "");
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) { await ctx.answerCbQuery("Nhóm không có app nào"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();

    const msg = await ctx.reply(`Đang restart nhóm *${groupName}* (${apps.length} apps)…`, { parse_mode: "Markdown" });
    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await restartApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `restart:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Restart nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  // /stopgroup [group_name]
  bot.command("stopgroup", requireAuth("admin"), async (ctx) => {
    const groupName = ctx.message.text.split(/\s+/)[1];
    if (!groupName) {
      const groups = listGroups();
      if (groups.length === 0) { await ctx.reply("Chưa có nhóm nào."); return; }
      const buttons = groups.map((g) =>
        Markup.button.callback(`⏹ ${g} (${listAppsByGroup(g).length} apps)`, `stopgrp:${g}`)
      );
      await ctx.reply("Chọn nhóm cần stop:", Markup.inlineKeyboard(buttons, { columns: 1 }));
      return;
    }
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) {
      await ctx.reply(`Nhóm \`${groupName}\` không có app nào.`, { parse_mode: "Markdown" });
      return;
    }

    const msg = await ctx.reply(
      `Đang stop nhóm *${groupName}* (${apps.length} apps)…`,
      { parse_mode: "Markdown" }
    );

    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await stopApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `stop:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }

    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Stop nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^stopgrp:(.+)$/, requireAuth("admin"), async (ctx) => {
    const groupName = (ctx.callbackQuery as CallbackQuery.DataQuery).data.replace("stopgrp:", "");
    const apps = listAppsByGroup(groupName);
    if (apps.length === 0) { await ctx.answerCbQuery("Nhóm không có app nào"); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage();

    const msg = await ctx.reply(`Đang stop nhóm *${groupName}* (${apps.length} apps)…`, { parse_mode: "Markdown" });
    const results: string[] = [];
    for (const app of apps) {
      const server = findServer(app.server_id);
      if (!server) { results.push(`❌ ${app.name}: server not found`); continue; }
      const result = await stopApp(server, app);
      const status = result.exitCode === 0 ? "success" : "failure";
      const icon = status === "success" ? "✅" : "❌";
      results.push(`${icon} *${app.name}* @ ${server.name}`);
      logExecution(userId(ctx), `stop:${app.name}`, result.stdout || result.stderr || "", status, server.id);
    }
    await ctx.telegram.editMessageText(
      msg.chat.id, msg.message_id, undefined,
      `Stop nhóm *${groupName}*:\n${results.join("\n")}`,
      { parse_mode: "Markdown" }
    );
  });

  // /adduser <telegram_id> [role]
  bot.command("adduser", requireAuth("admin"), async (ctx) => {
    if (!config.botConfigEnabled) { await ctx.reply(CONFIG_DISABLED_MSG); return; }
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
