// platform/file-store.js
// 文件系统原语:原子写入 / 独占安装 / 单写者文件争用仲裁 / 目录监听唤醒。
// 全项目的 fs 写入路径都收在这里,core 层不直接接触文件系统。
//
// 三个写入原语。状态目录里的每个文件都属于以下三类之一:
//   atomicWrite       单写者、可覆盖(token.json / creds.json,写入方已被锁保护)
//   installExclusive  只允许创建、目标已存在即失败(争用仲裁的基础动作)
//   claimFile         争用单写者文件的所有权(api-key 引导 / PID 锁)
// 共同的不变量:内容永不写进已存在的 inode——一律先写同目录临时文件再
// rename/link 就位。读方于是只有两种可见状态:文件不存在,或内容完整。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 临时文件必须每次唯一:固定 ${pid}.tmp 在同一进程内并发写同一目标时
// 互相覆盖(rename 抢跑会装错内容),随机后缀消除该共享名
function stagingFile(file, tag) {
  return `${file}.${tag}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// mode 0o600 在创建时就收紧权限(POSIX 下 umask 不影响显式 mode 的属主位),
// 避免"先 0644 后 chmod"之间出现世界可读的窗口
function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = stagingFile(file, 'w');
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
}

// 目标已存在时 link 原子失败(EEXIST),由调用方仲裁。
// 不能用 openSync(file, 'wx'):那样先出现空文件再写入,并发方在窗口内会读到
// 空内容,创建方中途崩溃还会留下永久空文件。
function installExclusive(file, content) {
  const tmp = stagingFile(file, 'x');
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.linkSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 已清理或从未建成 */ }
  }
}

// 争用一个单写者文件的所有权。isUsable(content) 判定"他方内容有效,应当让位";
// 无效内容(空 / 垃圾 / 死 PID)则接管。返回:
//   { installed: true }              本方内容已装入
//   { installed: false, content }    他方内容有效,原样奉还
//
// 仲裁只用原子原语。抢处置权用 rename 而非 unlink——unlink 依据的是已经过期的
// 读取结果,并发方都读到无效内容时,后删者会误删先恢复者刚装好的内容。rename
// 到手后还必须复核:隔离期间他方可能已恢复出有效内容,拿错了要放回去。
function claimFile(file, content, isUsable, attempts = 8) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      installExclusive(file, content);
      return { installed: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 末轮仍撞 EEXIST 才算失败:每轮开头都重试安装,清掉死锁后立即就能装入
      if (attempt >= attempts) {
        const error = new Error(`${file} 并发争用未收敛(${attempts} 轮)`);
        error.code = 'LOCK_CONTENTION';
        throw error;
      }
    }
    let current;
    try { current = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      continue; // 文件暂缺(他方隔离中):重试安装,link 的 EEXIST 会继续仲裁
    }
    if (isUsable(current)) return { installed: false, content: current };

    const quarantined = stagingFile(file, 'stale');
    try { fs.renameSync(file, quarantined); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      continue; // 他方刚处理:重读仲裁
    }
    let taken = '';
    try { taken = fs.readFileSync(quarantined, 'utf8'); } catch (e) { /* 按无效处理 */ }
    if (isUsable(taken)) {
      // 隔离到手的已是有效内容(他方刚恢复):放回;他方已重装则丢弃
      try { fs.linkSync(quarantined, file); } catch (e) { /* 已被重装 */ }
    }
    try { fs.unlinkSync(quarantined); } catch (e) { /* ENOENT 无妨 */ }
  }
}

// ===== 续期等待:到期调度 + 文件事件唤醒 =====
// Watch directories so atomic file replacement does not detach the listener.
function createFileWakeup(files) {
  const directories = new Map();
  const watchers = [];
  const mtimes = new Map(); // basename → 上次事件时的 mtime(伪事件过滤)
  const normalize = name => process.platform === 'win32' ? name.toLowerCase() : name;
  let changed = false;
  let pending = null;
  let closed = false;

  for (const file of files) {
    const directory = path.dirname(file);
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(normalize(path.basename(file)));
  }

  function wake() {
    changed = true;
    if (pending) pending('changed');
  }

  for (const [directory, names] of directories) {
    try {
      const watcher = fs.watch(directory, { persistent: false }, (_, name) => {
        if (name === null) { wake(); return; } // 无名事件(目录级):保守唤醒
        const norm = normalize(String(name));
        if (!names.has(norm)) return;
        // Windows/NTFS 的伪事件过滤:读取文件会更新 atime 且延迟最多 1 小时
        // 落盘,fs.watch 会把 atime 更新当事件上报(FILE_NOTIFY_CHANGE_LAST_
        // ACCESS)。守护自己的每小时例行读取正好触发延迟刷盘,伪事件会让
        // 调度器多跑一圈(日志双行)。mtime 未变即伪事件,忽略——真实写入
        // (原子替换)必然改变 mtime;文件被删等 stat 失败则保守唤醒。
        // 附带收益:Windows 对一次写入常发双事件,此处顺带去重
        try {
          const mtime = fs.statSync(path.join(directory, String(name))).mtimeMs;
          const prev = mtimes.get(norm);
          mtimes.set(norm, mtime);
          if (prev !== undefined && prev === mtime) return;
        } catch (e) { /* stat 失败:保守唤醒 */ }
        wake();
      });
      // The timer remains active if the directory disappears or watching fails.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch (error) { /* Timer fallback, including missing credentials directories. */ }
  }

  return {
    reset() { changed = false; },
    wait(ms) {
      if (closed) return Promise.resolve('closed');
      if (changed) return Promise.resolve('changed');
      return new Promise(resolve => {
        const timer = setTimeout(() => finish('timeout'), ms);
        const finish = reason => {
          clearTimeout(timer);
          pending = null;
          resolve(reason);
        };
        pending = finish;
      });
    },
    close() {
      closed = true;
      for (const watcher of watchers) watcher.close();
      if (pending) pending('closed');
    },
  };
}

module.exports = { atomicWrite, installExclusive, claimFile, createFileWakeup };
