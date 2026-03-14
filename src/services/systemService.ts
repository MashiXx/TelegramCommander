import { Server } from "../db/db";
import { sshExec, ExecResult } from "../executor/sshExecutor";

export function getSystemStatus(server: Server): Promise<ExecResult> {
  return sshExec(server, "uptime && echo '---' && free -m && echo '---' && df -h");
}

export function getProcessList(server: Server): Promise<ExecResult> {
  return sshExec(server, "pm2 list 2>/dev/null; echo '--- Docker ---'; docker ps 2>/dev/null");
}

export function getPm2List(server: Server): Promise<ExecResult> {
  return sshExec(server, "pm2 list");
}

export function getPm2Logs(server: Server, lines = 50): Promise<ExecResult> {
  const n = Math.min(lines, 200);
  return sshExec(server, `pm2 logs --lines ${n} --nostream`);
}
