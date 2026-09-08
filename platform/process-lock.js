// platform/process-lock.js
// 进程锁的平台分发点,core/service 层只依赖这里的接口,平台实现收在 windows/;
// 当前仅有 Windows(PID 探活)实现。接口供 auth-service / CLI 使用:
//   processLock.acquirePidLock(file) -> { ok } | { ok: false, pid }
//   processLock.releasePidLock(file)
//   processLock.pidOf(content) / isAlive(pid)(诊断命令用)

'use strict';

module.exports = require('./windows/process-lock');
