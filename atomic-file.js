// atomic-file.js
// 三个文件写入原语。状态目录里的每个文件都属于以下三类之一:
//   atomicWrite       单写者、可覆盖(token.json / creds.json,写入方已被锁保护)
//   installExclusive  只允许创建、目标已存在即失败(争用仲裁的基础动作)
//   claimFile         争用单写者文件的所有权(api-key 引导 / PID 锁)
//
// 共同的不变量:内容永不写进已存在的 inode——一律先写同目录临时文件再
// rename/link 就位。读方于是只有两种可见状态:文件不存在,或内容完整。

'use strict';

const fs = require('fs');
const path = require('path');

// mode 0o600 在创建时就收紧权限(POSIX 下 umask 不影响显式 mode 的属主位),
// 避免"先 0644 后 chmod"之间出现世界可读的窗口
function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
}

// 目标已存在时 link 原子失败(EEXIST),由调用方仲裁。
// 不能用 openSync(file, 'wx'):那样先出现空文件再写入,并发方在窗口内会读到
// 空内容,创建方中途崩溃还会留下永久空文件。
function installExclusive(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
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

    const quarantined = `${file}.stale.${process.pid}`;
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

module.exports = { atomicWrite, installExclusive, claimFile };
