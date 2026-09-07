#!/usr/bin/env node
// dashboard.js — 单窗口模式:同一控制台里运行 watch 续期守护与反代,
// 两边输出加 [代理]/[watch] 前缀交错显示,Ctrl+C 或关窗即全部停止。
// 本文件只是编排器:两个子进程仍是完全独立的进程(凭据隔离/爆炸半径的
// 拆分理由全部成立),调试时可绕过它分别运行
//   node refresh-token.js watch   与   node proxy.js   (行为与从前一致)
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const children = new Set();

let shuttingDown = false;

// 自动重启:崩溃(非零退出)5 秒后重启,支撑"无人值守"卖点(watch 崩了 token
// 5h 后过期、代理崩了端点消失)。防崩溃循环:启动 30s 内连续崩溃 3 次放弃该
// 子进程,两个都放弃才退出 dashboard。明确正常退出(code 0 且 <30s,如"已有
// 实例在运行")不重启
const crashStreaks = new Map();
const givenUp = new Set();

function launch(tag, script, args) {
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.log(`[${tag}] === 子进程启动失败: ${e.message} ===`);
    return null;
  }
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    readline.createInterface({ input: stream }).on('line', line => {
      process.stdout.write(`[${tag}] ${line}\n`);
    });
  }
  // spawn 的异步失败(如脚本路径不存在)走 'error' 而非 try/catch
  child.on('error', (e) => {
    console.log(`[${tag}] === 子进程错误: ${e.message} ===`);
    children.delete(child);
  });
  child.on('exit', (code) => {
    children.delete(child);
    const ranMs = Date.now() - startedAt;
    const intentional = code === 0 && ranMs < 30000;
    if (intentional) {
      console.log(`[${tag}] === 子进程正常退出(code 0,不重启)` +
        (children.size ? ',其余进程继续运行 ===' : ' ==='));
    } else if (ranMs < 30000) {
      const streak = (crashStreaks.get(tag) || 0) + 1;
      crashStreaks.set(tag, streak);
      if (streak >= 3) {
        givenUp.add(tag);
        console.log(`[${tag}] === 连续 ${streak} 次快速崩溃,停止自动重启;排查看上方输出 ===`);
        if (givenUp.size >= 2) {
          console.log('\n全部子进程均已停止自动重启,窗口可关闭;修复后重开 start.cmd。');
          process.exit(1);
        }
        return;
      }
      console.log(`[${tag}] === 子进程崩溃(code ${code}),5 秒后自动重启(${streak}/3)===`);
    } else {
      crashStreaks.set(tag, 0);
      console.log(`[${tag}] === 子进程退出(code ${code},运行 ${Math.round(ranMs / 1000)}s),5 秒后自动重启 ===`);
    }
    setTimeout(() => { if (!shuttingDown) launch(tag, script, args); }, 5000);
    // 没有存活/待重启的子进程时收尾(有定时器待重启则不退)
    if (!children.size && (intentional || givenUp.has(tag))) {
      console.log('\n没有存活/待重启的子进程,窗口可关闭;需要时重开 start.cmd。');
      process.exit(givenUp.size ? 1 : 0);
    }
  });
  return child;
}

console.log('madmodel 单窗口模式:watch 续期守护 + 反代同窗运行');
console.log('停止:本窗口 Ctrl+C 或直接关窗(两者一起停;watch 锁残留由下次启动自动探活接管)');
console.log('token 用量随请求日志显示(tok 输入+输出(r推理),含会话累计);状态速查再双击一次 start.cmd(在跑即显示体检)');
console.log('──────────────────────────────────────────────');
launch('watch', 'refresh-token.js', ['watch']);
launch('代理', 'proxy.js', []);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dashboard] 正在停止全部子进程…');
  for (const c of children) { try { c.kill(); } catch (e) {} }
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
// 注:Windows 控制台的 Ctrl+C 会同时送达同一控制台的所有进程,子进程通常
// 自行退出,上面的 kill 只是兜底;关窗则直接终止全部进程(无信号),watch
// 锁靠"死 PID 自动接管"自愈——与从前直接关窗口的行为一致。
