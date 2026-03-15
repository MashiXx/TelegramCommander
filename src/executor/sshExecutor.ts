import { Client, ConnectConfig } from "ssh2";
import fs from "fs";
import os from "os";
import { Server } from "../db/db";
import { config } from "../config/config";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Executes a script on a remote server via SSH.
 * Uses key-based authentication only (no passwords).
 */
export function sshExec(server: Server, script: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ stdout, stderr: stderr + "\n[timeout]", exitCode: 124 });
    }, config.commandTimeoutMs);

    console.log(`SSH exec on ${server.name} (${server.host}): ${script}`);

    conn.on("ready", () => {
      // Source common profile files to ensure PATH includes nvm, pm2, etc.
      // Non-interactive SSH doesn't load these by default.
      const profileLoader =
        'source /etc/profile 2>/dev/null; ' +
        'source ~/.bash_profile 2>/dev/null; ' +
        'source ~/.bashrc 2>/dev/null; ' +
        'source ~/.profile 2>/dev/null; ' +
        'source ~/.nvm/nvm.sh 2>/dev/null; ';
      const wrappedScript = `bash -c ${shellQuote(profileLoader + script)}`;
      conn.exec(wrappedScript, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout: "", stderr: err.message, exitCode: 1 });
          return;
        }

        stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          conn.end();
          console.log(`SSH exec completed on ${server.name} with exit code ${code}. ${stderr} ${stdout}`);
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: `SSH connection error: ${err.message}`, exitCode: 1 });
    });

    if (!server.ssh_key_path && !server.ssh_password) {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "No SSH credentials configured (key or password required).", exitCode: 1 });
      return;
    }

    const connectCfg: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 10_000,
      ...(server.ssh_key_path
        ? { privateKey: fs.readFileSync(server.ssh_key_path.replace(/^~/, os.homedir())) }
        : { password: server.ssh_password! }),
    };

    conn.connect(connectCfg);
  });
}

/** Escape a string for safe use inside single quotes in bash */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Truncate output to fit Telegram's 4096-char message limit */
export function truncateOutput(text: string, maxLen = 3800): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…(truncated, ${text.length - maxLen} chars omitted)`;
}
