# TelegramCommander

A Telegram bot for secure **multi-server** management via SSH. Built with Node.js 20, TypeScript, Telegraf, and `node-sqlite3-wasm` (no native build required).

## Commands

| Command | Role | Description |
|---------|------|-------------|
| `/start` | any | Welcome message |
| `/help` | viewer+ | List commands |
| `/servers` | viewer+ | List registered servers |
| `/status` | viewer+ | CPU, RAM, disk, uptime (server picker if >1) |
| `/process` | viewer+ | PM2 + Docker process list |
| `/apps [server]` | viewer+ | Registered applications |
| `/logs [lines]` | viewer+ | PM2 logs |
| `/run <cmd> <server>` | admin | Execute a whitelisted command on a server |
| `/deploy <app>` | admin | Full deploy pipeline via SSH |
| `/addserver name\|host\|port\|user\|key_path\|desc` | admin | Register a server |
| `/delserver <name>` | admin | Remove a server |
| `/addapp name\|server\|path\|start\|branch\|build` | admin | Register an application |
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

## Multi-server setup

### Register servers

```
/addserver prod|203.0.113.10|22|ubuntu|/home/bot/.ssh/prod_key|Production
/addserver staging|203.0.113.11|22|ubuntu|/home/bot/.ssh/staging_key|Staging
```

Fields (pipe-separated): `name | host | port | ssh_user | /path/to/private_key | description`

When a command like `/status` is used and more than one server is registered, the bot
shows an **inline keyboard** to pick the target server.

### Register applications (for /deploy)

```
/addapp api|prod|/srv/api|pm2 restart api|main|npm run build
/addapp frontend|staging|/srv/frontend|pm2 restart frontend|develop|npm run build
```

Fields: `name | server | path | start_command | branch | build_command`

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

```bash
# Find your Telegram ID via @userinfobot, then:
sqlite3 data/bot.db \
  "INSERT INTO telegram_users (telegram_id, username, role) VALUES (12345678, 'you', 'admin');"
```

After that use `/adduser` to add others.

## Security

- Only users in `telegram_users` can interact with the bot.
- Commands are role-gated (`viewer` / `admin`).
- All remote execution goes through SSH key auth — no passwords, no root.
- Only scripts stored in the `commands` table are executed — no arbitrary shell input.
- Execution timeout: 30 s (configurable via `COMMAND_TIMEOUT_MS`).
- Docker container runs as non-root user `botuser`.
- Every command execution is logged to `command_logs` with user + server + timestamp.

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
  services/deployService.ts    — git-pull deploy pipeline via SSH
  bot/commands.ts              — all command handlers + inline server picker
  bot/bot.ts                   — Telegraf setup
  index.ts                     — entry point
Dockerfile
docker-compose.yml
```
