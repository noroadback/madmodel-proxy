// platform/process-lock.js
// PID 锁实现(watch 单实例锁 + 认证操作锁共用),纯 Node 跨平台。
// 争用与原子安装由 file-store 的 claimFile 承担,这里只定义"什么算有效锁":
// 自己的 PID,或一个仍然存活的 PID。空/垃圾内容(旧版本中断写入、升级遗留)
// 与死 PID 一律视为可接管。
// 已知取舍:PID 被系统复用时会误判为"持有者存活"——fail-safe 方向(拒绝启动
// 而非双跑),按提示删锁即可恢复,这是无原生进程标识 API 下的合理代价。
// 接口供 auth-service / CLI 使用:
//   processLock.acquirePidLock(file) -> { ok } | { ok: false, pid }
//   processLock.releasePidLock(file)
//   processLock.pidOf(content) / isAlive(pid)(诊断命令用)

'use strict';

const fs = require('fs');
const { claimFile } = require('./file-store');

function pidOf(content) {
  const pid = Number(String(content).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function acquirePidLock(file) {
  const claim = claimFile(file, String(process.pid), content => {
    const pid = pidOf(content);
    return pid === process.pid || (pid > 0 && isAlive(pid));
  });
  if (claim.installed) return { ok: true };
  const pid = pidOf(claim.content);
  // 同进程重复获取(上一次 release 未成功)视为已持有
  return pid === process.pid ? { ok: true } : { ok: false, pid };
}

function releasePidLock(file) {
  try {
    if (pidOf(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file);
  } catch (e) { /* 无锁文件 */ }
}

module.exports = { pidOf, isAlive, acquirePidLock, releasePidLock };
