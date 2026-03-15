# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript (tsc) → dist/
npm start            # run compiled app (node dist/index.js)
npm run dev          # run from source via ts-node
npm run watch        # tsc --watch for continuous compilation
docker compose up -d # run via Docker
```

No test framework is configured. No linter is configured.

## Environment

Requires a `.env` file (see `.env.example`). `BOT_TOKEN` is the only required variable. Database defaults to `./data/bot.db`.

## Architecture

Telegram bot for multi-server SSH management. Built with **Telegraf** (Telegram bot framework), **node-sqlite3-wasm** (WASM-based SQLite, no native bindings), and **ssh2**.

### Request flow

1. **Entry** (`src/index.ts`) — initializes DB, creates Telegraf bot, launches polling
2. **Auth middleware** (`src/auth/authGuard.ts`) — `requireAuth(minRole?)` middleware checks `telegram_users` table; gates commands by role (`admin` / `viewer`)
3. **Command handlers** (`src/bot/commands.ts`) — all bot commands registered in `registerCommands()`. Multi-server commands use inline keyboards for server selection via callback queries (pattern: `action:serverName`)
4. **Services** (`src/services/`) — `systemService.ts` builds shell command strings for system info; `deployService.ts` runs git-pull → npm install → build → restart pipeline
5. **Executor** (`src/executor/sshExecutor.ts`) — `sshExec(server, script)` runs commands on remote servers via SSH with configurable timeout. Supports both SSH key and password auth. Output truncated to 3800 chars for Telegram's message limit

### Database

SQLite via `node-sqlite3-wasm`. Schema in `src/db/schema.sql`, initialized on first `getDb()` call. Five tables: `telegram_users`, `servers`, `commands`, `apps`, `command_logs`. All DB helpers (CRUD) are synchronous functions exported from `src/db/db.ts`. Schema migrations are handled inline in `initSchema()`.

### Key patterns

- **Server picker**: when multiple servers exist, commands show an inline keyboard; single server auto-selects. Callback query data format: `actionName:serverName`
- **Edit sessions**: `/editserver` uses an in-memory `Map<telegramId, EditSession>` to track which field is being edited, then captures the next text message
- **Seed data**: default whitelisted commands (status, process, apps, logs) are inserted on DB init via `seedDefaultData()`
- UI strings are a mix of English and Vietnamese
