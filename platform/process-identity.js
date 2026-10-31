// OS 创建时间区分同一个 PID 的不同进程。无法读取时返回 null，调用方保守判活。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let ownIdentity;
function parseLinuxStat(stat, bootId) {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] || '') && bootId ? `linux:${bootId.trim()}:${fields[19]}` : null;
}
function processIdentities(pids) {
  pids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const result = new Map();
  if (!pids.length) return result;
  if (ownIdentity && pids.includes(process.pid)) {
    result.set(process.pid, ownIdentity);
    pids = pids.filter(pid => pid !== process.pid);
  }
  try {
    if (process.platform === 'linux') {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
      for (const pid of pids) {
        try { result.set(pid, parseLinuxStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), boot)); } catch { /* 不可读 */ }
      }
    } else if (process.platform === 'win32' && pids.length) {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // PID 已验证为正整数；不插入文件路径、命令行或凭据。
      const script = `$ErrorActionPreference='Stop'; @(${pids.join(',')}) | ForEach-Object { try { $p=Get-Process -Id $_; $t=$p.StartTime.ToUniversalTime().Ticks; [Console]::WriteLine(('{0} {1}' -f $p.Id,$t)) } catch {} }`;
      const output = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of output.trim().split(/\r?\n/)) {
        const match = /^(\d+) (\d+)$/.exec(line.trim());
        if (match) result.set(Number(match[1]), `win32:${match[2]}`);
      }
    } else if (process.platform === 'darwin' && pids.length) {
      const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000 }).trim();
      const output = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,lstart='],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of output.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match) result.set(Number(match[1]), `darwin:${boot}:${match[2].trim()}`);
      }
    }
  } catch { /* 工具缺失/权限不足/超时不是死亡证据。 */ }
  if (result.get(process.pid)) ownIdentity = result.get(process.pid);
  return result;
}
module.exports = { processIdentities, parseLinuxStat };
