import { Client, ConnectConfig } from "ssh2";
import fs from "fs";
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

    conn.on("ready", () => {
      conn.exec(script, (err, stream) => {
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
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: `SSH connection error: ${err.message}`, exitCode: 1 });
    });

    const connectCfg: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: fs.readFileSync(server.ssh_key_path),
      readyTimeout: 10_000,
    };

    conn.connect(connectCfg);
  });
}

/** Truncate output to fit Telegram's 4096-char message limit */
export function truncateOutput(text: string, maxLen = 3800): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…(truncated, ${text.length - maxLen} chars omitted)`;
}
