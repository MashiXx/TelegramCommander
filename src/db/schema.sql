CREATE TABLE IF NOT EXISTS telegram_users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username    TEXT,
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL DEFAULT 22,
  username     TEXT NOT NULL DEFAULT 'ubuntu',
  ssh_key_path TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  script        TEXT NOT NULL,
  allowed_roles TEXT NOT NULL DEFAULT 'admin,viewer',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS apps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  server_id      INTEGER NOT NULL,
  path           TEXT NOT NULL,
  start_command  TEXT NOT NULL,
  build_command  TEXT,
  deploy_branch  TEXT NOT NULL DEFAULT 'main',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id)
);

CREATE TABLE IF NOT EXISTS command_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  server_id        INTEGER,
  command          TEXT NOT NULL,
  output           TEXT,
  status           TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (telegram_user_id) REFERENCES telegram_users(id),
  FOREIGN KEY (server_id) REFERENCES servers(id)
);
