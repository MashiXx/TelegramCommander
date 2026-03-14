import { exec } from "child_process";
import { config } from "../config/config";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Executes a whitelisted shell script with a configurable timeout.
 * The script is passed as a single string – no user-supplied interpolation.
 */
export function executeScript(script: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = exec(
      script,
      { timeout: config.commandTimeoutMs, shell: "/bin/sh" },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: error?.code ?? 0,
        });
      }
    );

    // Kill after timeout (exec already handles this but we double-guard)
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, config.commandTimeoutMs + 1000);

    child.on("close", () => clearTimeout(timer));
  });
}

/** Truncate output to fit Telegram's 4096-char message limit */
export function truncateOutput(text: string, maxLen = 3800): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…(truncated, ${text.length - maxLen} chars omitted)`;
}
