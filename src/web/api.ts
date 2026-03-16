import { Router, Request, Response } from "express";
import {
  listServers, findServer, upsertServer, deleteServer,
  listApps, findApp, upsertApp, setAppGroup, listGroups, listAppsByGroup,
  listUsers, addUser, findUser, getDb,
  listCommands, findCommand, upsertCommand,
  getRecentLogs,
} from "../db/db";

const router = Router();

function param(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? v[0] : v;
}

// ─── Servers ───

router.get("/servers", (_req, res) => {
  res.json(listServers());
});

router.post("/servers", (req: Request, res: Response) => {
  const { name, host, port, username, ssh_key_path, ssh_password, description } = req.body;
  if (!name || !host) { res.status(400).json({ error: "name and host required" }); return; }
  upsertServer(name, host, port ?? 22, username ?? "ubuntu", ssh_key_path ?? null, description, ssh_password);
  res.json(findServer(name));
});

router.put("/servers/:name", (req: Request, res: Response) => {
  const name = param(req, "name");
  const server = findServer(name);
  if (!server) { res.status(404).json({ error: "Server not found" }); return; }
  const { host, port, username, ssh_key_path, ssh_password, description } = req.body;
  upsertServer(
    name,
    host ?? server.host,
    port ?? server.port,
    username ?? server.username,
    ssh_key_path !== undefined ? ssh_key_path : server.ssh_key_path,
    description !== undefined ? description : server.description ?? undefined,
    ssh_password !== undefined ? ssh_password : server.ssh_password ?? undefined,
  );
  res.json(findServer(name));
});

router.delete("/servers/:name", (req: Request, res: Response) => {
  deleteServer(param(req, "name"));
  res.json({ ok: true });
});

// ─── Apps ───

router.get("/apps", (_req, res) => {
  res.json(listApps());
});

router.post("/apps", (req: Request, res: Response) => {
  const { name, server_name, path, start_command, build_command, deploy_branch, group_name, stop_command } = req.body;
  if (!name || !server_name || !path || !start_command) {
    res.status(400).json({ error: "name, server_name, path, start_command required" }); return;
  }
  const server = findServer(server_name);
  if (!server) { res.status(400).json({ error: `Unknown server: ${server_name}` }); return; }
  upsertApp(name, server.id, path, start_command, build_command ?? null, deploy_branch ?? "main", group_name, stop_command ?? null);
  res.json(findApp(name));
});

router.put("/apps/:name/group", (req: Request, res: Response) => {
  const appName = param(req, "name");
  const app = findApp(appName);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  setAppGroup(appName, req.body.group_name ?? null);
  res.json(findApp(appName));
});

router.put("/apps/:name", (req: Request, res: Response) => {
  const appName = param(req, "name");
  const app = findApp(appName);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  const { server_name, path, start_command, build_command, deploy_branch, group_name, stop_command } = req.body;
  let serverId = app.server_id;
  if (server_name) {
    const server = findServer(server_name);
    if (!server) { res.status(400).json({ error: `Unknown server: ${server_name}` }); return; }
    serverId = server.id;
  }
  upsertApp(
    appName,
    serverId,
    path ?? app.path,
    start_command ?? app.start_command,
    build_command !== undefined ? build_command : app.build_command,
    deploy_branch ?? app.deploy_branch,
    group_name !== undefined ? group_name : app.group_name,
    stop_command !== undefined ? stop_command : app.stop_command,
  );
  res.json(findApp(appName));
});

router.delete("/apps/:name", (req: Request, res: Response) => {
  getDb().run("DELETE FROM apps WHERE name = ?", [param(req, "name")]);
  res.json({ ok: true });
});

// ─── Groups ───

router.get("/groups", (_req, res) => {
  const groups = listGroups();
  const result = groups.map((g) => ({
    name: g,
    apps: listAppsByGroup(g).map((a) => ({
      ...a,
      server_name: findServer(a.server_id)?.name ?? null,
    })),
  }));
  res.json(result);
});

// ─── Users ───

router.get("/users", (_req, res) => {
  res.json(listUsers());
});

router.post("/users", (req: Request, res: Response) => {
  const { telegram_id, username, role } = req.body;
  if (!telegram_id) { res.status(400).json({ error: "telegram_id required" }); return; }
  addUser(parseInt(telegram_id, 10), username ?? null, role === "admin" ? "admin" : "viewer");
  res.json(findUser(parseInt(telegram_id, 10)));
});

router.delete("/users/:telegram_id", (req: Request, res: Response) => {
  getDb().run("DELETE FROM telegram_users WHERE telegram_id = ?", [parseInt(param(req, "telegram_id"), 10)]);
  res.json({ ok: true });
});

// ─── Commands ───

router.get("/commands", (_req, res) => {
  res.json(listCommands());
});

router.post("/commands", (req: Request, res: Response) => {
  const { name, description, script, allowed_roles } = req.body;
  if (!name || !script) { res.status(400).json({ error: "name and script required" }); return; }
  upsertCommand(name, description ?? "", script, allowed_roles ?? "admin,viewer");
  res.json(findCommand(name));
});

// ─── Logs ───

router.get("/logs", (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
  res.json(getRecentLogs(limit));
});

export default router;
