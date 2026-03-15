# TelegramCommander

A Telegram bot for secure **multi-server** management via SSH, with a built-in **web admin panel**. Built with Node.js 20, TypeScript, Telegraf, Express, and `node-sqlite3-wasm` (no native build required).

## Commands

| Command | Role | Description |
|---------|------|-------------|
| `/start` | any | Welcome message |
| `/help` | viewer+ | List commands |
| `/servers` | viewer+ | List registered servers |
| `/status` | viewer+ | CPU, RAM, disk, uptime (server picker if >1) |
| `/sysinfo` | viewer+ | System info menu (CPU/RAM/Disk/Network) |
| `/process` | viewer+ | PM2 + Docker process list |
| `/apps [server]` | viewer+ | Registered applications |
| `/logs [lines]` | viewer+ | PM2 logs |
| `/groups` | viewer+ | List app groups |
| `/run <cmd> <server>` | admin | Execute a whitelisted command on a server |
| `/deploy <app>` | admin | Full deploy pipeline via SSH |
| `/deploygroup <group>` | admin | Deploy all apps in a group |
| `/restartgroup <group>` | admin | Restart all apps in a group |
| `/addserver name\|host\|port\|user\|key_or_pass\|desc` | admin | Register a server |
| `/delserver <name>` | admin | Remove a server |
| `/editserver` | admin | Edit server fields interactively |
| `/addapp name\|server\|path\|start\|branch\|build\|group` | admin | Register an application |
| `/setgroup <app> <group>` | admin | Assign app to a group |
| `/ungroup <app>` | admin | Remove app from group |
| `/adduser <id> [role]` | admin | Add authorized user |
| `/audit [n]` | admin | Audit log (shows server per entry) |

## Quick start

### 1. Get a bot token

Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.

### 2. Configure

```bash
cp .env.example .env
# Edit .env — set BOT_TOKEN at minimum
```

### 3. Run locally

```bash
npm install
npm run build
npm start
```

### 4. Run with Docker

```bash
docker compose up -d
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_TOKEN` | *(required)* | Telegram bot token from BotFather |
| `DATABASE_PATH` | `./data/bot.db` | SQLite database path |
| `COMMAND_TIMEOUT_MS` | `30000` | SSH command timeout in ms |
| `WEB_ENABLED` | `true` | Enable web admin panel (`false` to disable) |
| `WEB_PORT` | `3000` | Web admin panel port |
| `WEB_USER` | `admin` | Web admin username |
| `WEB_PASS` | *(empty)* | Web admin password (empty = no auth) |
| `BOT_CONFIG_ENABLED` | `true` | Enable config commands in Telegram (`false` to disable) |

## Web admin panel

A built-in web UI for managing servers, apps, groups, users, and commands. Accessible at `http://localhost:3000` (or your configured `WEB_PORT`).

- **Servers** — add, edit, delete servers (SSH key or password auth)
- **Apps** — add, delete apps, assign to groups
- **Groups** — view groups and their apps
- **Users** — add, delete Telegram users with role selection
- **Commands** — add whitelisted commands
- **Logs** — view audit logs

Protected by Basic auth (`WEB_USER` / `WEB_PASS`). Set `WEB_ENABLED=false` to disable entirely.

When `BOT_CONFIG_ENABLED=false`, config commands (`/addserver`, `/addapp`, `/adduser`, etc.) are disabled in Telegram and users are directed to use the web panel instead. Operational commands (`/deploy`, `/status`, `/run`, etc.) remain available.

## Multi-server setup

### Register servers

Via Telegram:
```
/addserver prod|203.0.113.10|22|ubuntu|/home/bot/.ssh/prod_key|Production
/addserver staging|203.0.113.11|22|ubuntu|/home/bot/.ssh/staging_key|Staging
```

Or via the web admin panel.

Fields (pipe-separated): `name | host | port | ssh_user | key_or_password | description`

- If the credential field starts with `/` or `~`, it's treated as an SSH key path.
- Otherwise, it's treated as a password.

When a command like `/status` is used and more than one server is registered, the bot
shows an **inline keyboard** to pick the target server.

### Register applications (for /deploy)

```
/addapp api|prod|/srv/api|pm2 restart api|main|npm run build|backend
/addapp frontend|staging|/srv/frontend|pm2 restart frontend|develop|npm run build|frontend
```

Fields: `name | server | path | start_command | branch | build_command | group`

### App groups

Group apps together to deploy or restart them in batch:

```
/setgroup api backend
/setgroup worker backend
/deploygroup backend      # deploys all apps in the "backend" group
/restartgroup backend     # restarts all apps (start_command only)
/groups                   # list all groups
```

### SSH key setup

The bot user on the machine running the bot needs read access to the private keys.
On the target servers the corresponding public key must be in `~/.ssh/authorized_keys`.

```bash
# Generate a dedicated key pair
ssh-keygen -t ed25519 -f ~/.ssh/bot_key -N ""
# Copy public key to each server
ssh-copy-id -i ~/.ssh/bot_key.pub ubuntu@203.0.113.10
```

## Adding the first admin

Via SQLite:
```bash
# Find your Telegram ID via @userinfobot, then:
sqlite3 data/bot.db \
  "INSERT INTO telegram_users (telegram_id, username, role) VALUES (12345678, 'you', 'admin');"
```

Or via the web admin panel at the Users tab.

After that use `/adduser` to add others.

## Security

- Only users in `telegram_users` can interact with the bot.
- Commands are role-gated (`viewer` / `admin`).
- All remote execution goes through SSH (key or password auth).
- Only scripts stored in the `commands` table are executed — no arbitrary shell input.
- Execution timeout: 30 s (configurable via `COMMAND_TIMEOUT_MS`).
- Docker container runs as non-root user `botuser`.
- Every command execution is logged to `command_logs` with user + server + timestamp.
- Web admin protected by Basic auth.

## Project structure

```
src/
  config/config.ts             — env config
  db/db.ts                     — SQLite helpers (node-sqlite3-wasm, no native build)
  db/schema.sql                — tables: users, servers, commands, apps, logs
  auth/authGuard.ts            — Telegraf auth middleware
  executor/sshExecutor.ts      — SSH command runner (ssh2)
  executor/commandExecutor.ts  — local child_process wrapper (for local fallback)
  services/systemService.ts    — status / process / logs via SSH
  services/deployService.ts    — git-pull deploy pipeline + restart via SSH
  bot/commands.ts              — all command handlers + inline server picker
  bot/bot.ts                   — Telegraf setup
  web/server.ts                — Express web server + basic auth
  web/api.ts                   — REST API for CRUD operations
  web/public/index.html        — Single-page admin UI
  index.ts                     — entry point
Dockerfile
docker-compose.yml
```
