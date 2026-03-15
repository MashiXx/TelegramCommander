import path from "path";
import { App, Server } from "../db/db";
import { sshExec, ExecResult } from "../executor/sshExecutor";

/**
 * Runs the full deploy pipeline on the remote server via SSH:
 * 1. git pull
 * 2. npm install
 * 3. build (if defined)
 * 4. restart service
 */
export function restartApp(server: Server, app: App): Promise<ExecResult> {
  return sshExec(server, app.start_command);
}

export function stopApp(server: Server, app: App): Promise<ExecResult> {
  // Derive stop command from start_command by replacing "restart" with "stop"
  const stopCmd = app.start_command.replace(/\brestart\b/, "stop");
  return sshExec(server, stopCmd);
}

export function deployApp(server: Server, app: App): Promise<ExecResult> {
  if (/[`$;&|><]/.test(app.path)) {
    return Promise.resolve({ stdout: "", stderr: "Invalid application path.", exitCode: 1 });
  }

  const safePath = app.path.replace(/'/g, "");
  const branch = app.deploy_branch.replace(/[^a-zA-Z0-9._\-/]/g, "");

  const steps: string[] = [
    `cd '${safePath}'`,
    `git pull origin ${branch}`,
    `npm install`,
  ];

  if (app.build_command) {
    steps.push(app.build_command);
  }

  steps.push(app.start_command);

  return sshExec(server, steps.join(" && "));
}
