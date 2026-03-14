import { Server } from "../db/db";
import { sshExec, ExecResult } from "../executor/sshExecutor";

export function getSystemStatus(server: Server): Promise<ExecResult> {
  return sshExec(server, "uptime && echo '---' && free -m && echo '---' && df -h");
}

export function getSysOverview(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== Hostname ==='",
      "hostname -f 2>/dev/null || hostname",
      "echo '=== OS ==='",
      "cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION)=' || uname -a",
      "echo '=== Kernel ==='",
      "uname -r",
      "echo '=== Uptime ==='",
      "uptime",
      "echo '=== Load Average ==='",
      "cat /proc/loadavg 2>/dev/null || uptime",
    ].join(" && ")
  );
}

export function getSysCpu(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== CPU Info ==='",
      "lscpu 2>/dev/null | grep -E '(Model name|CPU\\(s\\)|Thread|Core|Socket|MHz)' || cat /proc/cpuinfo | grep 'model name' | head -1",
      "echo '=== CPU Usage (top 5 processes) ==='",
      "ps aux --sort=-%cpu 2>/dev/null | head -6 || ps aux | head -6",
    ].join(" && ")
  );
}

export function getSysMemory(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== Memory Usage ==='",
      "free -h",
      "echo '=== Top Memory Processes ==='",
      "ps aux --sort=-%mem 2>/dev/null | head -6 || ps aux | head -6",
    ].join(" && ")
  );
}

export function getSysDisk(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== Disk Usage ==='",
      "df -h",
      "echo '=== Disk I/O ==='",
      "iostat -d 1 1 2>/dev/null | tail -n +3 || echo 'iostat not available'",
    ].join(" && ")
  );
}

export function getSysNetwork(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== Network Interfaces ==='",
      "ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | grep -E '(^\\w|inet )' || echo 'N/A'",
      "echo '=== Open Ports ==='",
      "ss -tlnp 2>/dev/null | head -20 || netstat -tlnp 2>/dev/null | head -20 || echo 'N/A'",
      "echo '=== Network Traffic ==='",
      "cat /proc/net/dev 2>/dev/null | grep -v lo | tail -n +3 | awk '{print $1, \"RX:\", $2, \"TX:\", $10}' || echo 'N/A'",
    ].join(" && ")
  );
}

export function getSysAll(server: Server): Promise<ExecResult> {
  return sshExec(
    server,
    [
      "echo '=== HOST ==='",
      "hostname -f 2>/dev/null || hostname",
      "echo '=== OS ==='",
      "cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION)=' || uname -a",
      "echo '=== UPTIME ==='",
      "uptime",
      "echo '=== CPU ==='",
      "lscpu 2>/dev/null | grep -E '(Model name|CPU\\(s\\)|MHz)' | head -5 || grep 'model name' /proc/cpuinfo | head -1",
      "echo '=== MEMORY ==='",
      "free -h",
      "echo '=== DISK ==='",
      "df -h",
      "echo '=== NETWORK ==='",
      "ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | grep -E '(^\\w|inet )' || echo 'N/A'",
    ].join(" && ")
  );
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
