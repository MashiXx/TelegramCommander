// eslint-disable-next-line @typescript-eslint/no-require-imports
import { Database as Db } from "node-sqlite3-wasm";
import fs from "fs";
import path from "path";
import { config } from "../config/config";

// node-sqlite3-wasm does not ship its own .d.ts, so we declare the minimal interface we use.
interface Statement {
  run(params?: unknown[]): void;
  get(params?: unknown[]): unknown;
  all(params?: unknown[]): unknown[];
  finalize(): void;
}

interface Database {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get(sql: string, params?: unknown[]): unknown;
  all(sql: string, params?: unknown[]): unknown[];
  prepare(sql: string): Statement;
  close(): void;
}

let db: Database;

export function getDb(): Database {
  if (!db) {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
    db = new Db(config.databasePath) as unknown as Database;
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    initSchema();
    seedDefaultData();
  }
  return db;
}

function initSchema(): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  // migrations for existing databases
  for (const col of ["ssh_key_path TEXT DEFAULT NULL", "ssh_password TEXT DEFAULT NULL"]) {
    try { db.exec(`ALTER TABLE servers ADD COLUMN ${col}`); } catch { /* already exists */ }
  }

  // Add group_name column to apps
  try { db.exec("ALTER TABLE apps ADD COLUMN group_name TEXT DEFAULT NULL"); } catch { /* already exists */ }

  // Add stop_command column to apps
  try { db.exec("ALTER TABLE apps ADD COLUMN stop_command TEXT DEFAULT NULL"); } catch { /* already exists */ }

  // Fix NOT NULL constraint on ssh_key_path/ssh_password if created by older schema
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS servers_backup AS SELECT * FROM servers;
      DROP TABLE IF EXISTS servers;
      CREATE TABLE servers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        host         TEXT NOT NULL,
        port         INTEGER NOT NULL DEFAULT 22,
        username     TEXT NOT NULL DEFAULT 'ubuntu',
        ssh_key_path TEXT DEFAULT NULL,
        ssh_password TEXT DEFAULT NULL,
        description  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO servers SELECT * FROM servers_backup;
      DROP TABLE servers_backup;
    `);
  } catch { /* backup table might not match — ignore */ }
}

function seedDefaultData(): void {
  const defaults: [string, string, string, string][] = [
    ["status",  "System status (CPU, RAM, disk, uptime)", "uptime && free -m && df -h",                  "admin,viewer"],
    ["process", "List running processes (PM2 + Docker)",  "pm2 list 2>/dev/null; docker ps 2>/dev/null", "admin,viewer"],
    ["apps",    "List PM2-managed applications",          "pm2 list",                                    "admin,viewer"],
    ["logs",    "Tail latest PM2 logs (50 lines)",        "pm2 logs --lines 50 --nostream",              "admin,viewer"],
  ];

  for (const [name, description, script, roles] of defaults) {
    db.run(
      "INSERT OR IGNORE INTO commands (name, description, script, allowed_roles) VALUES (?, ?, ?, ?)",
      [name, description, script, roles]
    );
  }
}

export type Role = "admin" | "viewer";

export interface TelegramUser {
  id: number;
  telegram_id: number;
  username: string | null;
  role: Role;
  created_at: string;
}

export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  ssh_key_path: string | null;
  ssh_password: string | null;
  description: string | null;
  created_at: string;
}

export interface Command {
  id: number;
  name: string;
  description: string;
  script: string;
  allowed_roles: string;
  created_at: string;
}

export interface App {
  id: number;
  name: string;
  server_id: number;
  path: string;
  start_command: string;
  stop_command: string | null;
  build_command: string | null;
  deploy_branch: string;
  group_name: string | null;
  created_at: string;
}

// --- User helpers ---
export function findUser(telegramId: number): TelegramUser | undefined {
  return getDb().get(
    "SELECT * FROM telegram_users WHERE telegram_id = ?", [telegramId]
  ) as TelegramUser | undefined;
}

export function addUser(telegramId: number, username: string | null, role: Role = "viewer"): void {
  getDb().run(
    "INSERT OR IGNORE INTO telegram_users (telegram_id, username, role) VALUES (?, ?, ?)",
    [telegramId, username, role]
  );
}

export function listUsers(): TelegramUser[] {
  return getDb().all("SELECT * FROM telegram_users ORDER BY created_at") as TelegramUser[];
}

// --- Server helpers ---
export function listServers(): Server[] {
  return getDb().all("SELECT * FROM servers ORDER BY name") as Server[];
}

export function findServer(nameOrId: string | number): Server | undefined {
  const col = typeof nameOrId === "number" ? "id" : "name";
  return getDb().get(`SELECT * FROM servers WHERE ${col} = ?`, [nameOrId]) as Server | undefined;
}

export function upsertServer(
  name: string, host: string, port: number,
  username: string, sshKeyPath: string | null, description?: string,
  sshPassword?: string
): void {
  // Mutual exclusion: password set → clear key, key set → clear password
  const keyVal = sshKeyPath || null;
  const passVal = sshPassword || null;
  const finalKey = passVal ? null : keyVal;
  const finalPass = keyVal ? null : passVal;

  getDb().run(
    `INSERT INTO servers (name, host, port, username, ssh_key_path, ssh_password, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port,
       username=excluded.username, ssh_key_path=excluded.ssh_key_path,
       ssh_password=excluded.ssh_password, description=excluded.description`,
    [name, host, port, username, finalKey, finalPass, description ?? null]
  );
}

export function deleteServer(name: string): void {
  getDb().run("DELETE FROM servers WHERE name = ?", [name]);
}

// --- Command helpers ---
export function findCommand(name: string): Command | undefined {
  return getDb().get("SELECT * FROM commands WHERE name = ?", [name]) as Command | undefined;
}

export function listCommands(): Command[] {
  return getDb().all("SELECT * FROM commands ORDER BY name") as Command[];
}

export function upsertCommand(name: string, description: string, script: string, allowedRoles: string): void {
  getDb().run(
    `INSERT INTO commands (name, description, script, allowed_roles) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description=excluded.description,
       script=excluded.script, allowed_roles=excluded.allowed_roles`,
    [name, description, script, allowedRoles]
  );
}

// --- App helpers ---
export function listApps(serverId?: number): App[] {
  if (serverId !== undefined) {
    return getDb().all("SELECT * FROM apps WHERE server_id = ? ORDER BY name", [serverId]) as App[];
  }
  return getDb().all("SELECT * FROM apps ORDER BY name") as App[];
}

export function findApp(name: string): App | undefined {
  return getDb().get("SELECT * FROM apps WHERE name = ?", [name]) as App | undefined;
}

export function upsertApp(
  name: string, serverId: number, appPath: string,
  startCommand: string, buildCommand: string | null, deployBranch: string,
  groupName?: string | null, stopCommand?: string | null
): void {
  getDb().run(
    `INSERT INTO apps (name, server_id, path, start_command, build_command, deploy_branch, group_name, stop_command)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET server_id=excluded.server_id, path=excluded.path,
       start_command=excluded.start_command, build_command=excluded.build_command,
       deploy_branch=excluded.deploy_branch, group_name=excluded.group_name,
       stop_command=excluded.stop_command`,
    [name, serverId, appPath, startCommand, buildCommand, deployBranch, groupName ?? null, stopCommand ?? null]
  );
}

export function setAppGroup(appName: string, groupName: string | null): void {
  getDb().run("UPDATE apps SET group_name = ? WHERE name = ?", [groupName, appName]);
}

export function listGroups(): string[] {
  const rows = getDb().all(
    "SELECT DISTINCT group_name FROM apps WHERE group_name IS NOT NULL ORDER BY group_name"
  ) as Array<{ group_name: string }>;
  return rows.map((r) => r.group_name);
}

export function listAppsByGroup(groupName: string): App[] {
  return getDb().all(
    "SELECT * FROM apps WHERE group_name = ? ORDER BY name", [groupName]
  ) as App[];
}

// --- Log helpers ---
export function logExecution(
  telegramUserId: number, command: string,
  output: string, status: "success" | "failure",
  serverId?: number
): void {
  getDb().run(
    "INSERT INTO command_logs (telegram_user_id, server_id, command, output, status) VALUES (?, ?, ?, ?, ?)",
    [telegramUserId, serverId ?? null, command, output, status]
  );
}

export function getRecentLogs(limit = 20): unknown[] {
  return getDb().all(
    `SELECT cl.*, tu.username, tu.telegram_id, s.name AS server_name
     FROM command_logs cl
     JOIN telegram_users tu ON tu.id = cl.telegram_user_id
     LEFT JOIN servers s ON s.id = cl.server_id
     ORDER BY cl.created_at DESC LIMIT ?`,
    [limit]
  );
}
