#!/usr/bin/env node
// scripts/platform-smoke.js — 跨平台"启动 + 存储"冒烟(不访问学校、不触碰
// 真实状态目录)。1.4.0 起凭据存储分平台(Windows DPAPI / macOS 钥匙串 /
// Linux 机器绑定加密),node --check 语法门验证不了这些路径,本脚本在临时
// 状态目录里验证三件事:
//   1) 凭据与 token 的写入-读回往返(真实调用当前平台的存储原语)
//   2) proxy.js 无 token 启动并应答 /v1/models
//   3) refresh-token.js watch 在无凭据时的调度循环(锁/文件唤醒/调度器)
// CI 三平台(ubuntu/macos/windows)各跑一次;本地跑也不会影响在跑的服务
// (独立状态目录 + 独立端口)。
//   node scripts/platform-smoke.js

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function ok(name) { console.log(`✓ ${name}`); }
function bad(name, err) {
  failed++;
  const msg = String(err && err.message ? err.message : err).split('\n').slice(0, 3).join(' | ').slice(0, 400);
  console.error(`✗ ${name}`);
  console.error(`  ${msg}`);
  // GitHub workflow command:失败详情进 check-run annotation——匿名 API 可读,
  // 免登录就能拿到远端平台(macOS runner)的失败原因
  console.log(`::error title=platform-smoke::✗ ${name} :: ${msg}`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
// 失配诊断:写入值与读回值都进错误消息(annotation 可见),损坏形态一目了然
const show = v => `${JSON.stringify(String(v))}(len ${String(v).length})`;

// 挑一个空闲端口:listen(0) 拿到后立即释放,交给子进程用
function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 子进程随 stdout 逐行到达谓词即 resolve;超时 reject
function waitForLine(child, predicate, what, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${what}: ${timeoutMs}ms 内未见预期输出`)), timeoutMs);
    const onData = chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (predicate(line)) { clearTimeout(timer); resolve(line); return; }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${what}: 子进程提前退出(code ${code})`));
    });
  });
}

function stop(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ } }, 3000).unref();
  });
}

async function main() {
  // 必须在 require platform 模块之前生效:paths.js 在加载期读环境变量
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madmodel-smoke-'));
  const port = await freePort();
  const env = { ...process.env, MADMODEL_STATE_DIR: stateDir, PROXY_PORT: String(port) };
  process.env.MADMODEL_STATE_DIR = stateDir;

  const credentials = require('../platform/credentials');
  const cfg = require('../config');

  // ---- 1) 凭据与 token 存储往返(非 ASCII 秘密顺带验证编码路径) ----
  const PW = 'pass-马Φ"quote\\slash';
  try {
    credentials.writeAccount('smoke-user', PW, 'smoke-fp');
    const acc = credentials.readAccount();
    assert(acc && acc.username === 'smoke-user', 'username 往返不一致: 写入 "smoke-user" 读回 ' + show(acc && acc.username));
    assert(acc.password === PW, 'password 往返不一致: 写入 ' + show(PW) + ' 读回 ' + show(acc && acc.password));
    assert(acc.fingerPrint === 'smoke-fp', 'fingerprint 往返不一致: 写入 "smoke-fp" 读回 ' + show(acc && acc.fingerPrint));
    assert(credentials.hasAccount() === true, 'hasAccount 应为 true');
    ok('凭据写入-读回往返(' + process.platform + ' 存储原语)');
  } catch (e) { bad('凭据写入-读回往返', e); }

  try {
    const expiresAt = Date.now() + 3600e3;
    credentials.writeToken('tok-►-smoke', expiresAt);
    const t = credentials.readToken();
    assert(t && t.token === 'tok-►-smoke', 'token 往返不一致: 写入 "tok-►-smoke" 读回 ' + show(t && t.token));
    assert(t.expiresAt === expiresAt, 'expiresAt 往返不一致: 写入 ' + expiresAt + ' 读回 ' + (t && t.expiresAt));
    ok('token 写入-读回往返');
  } catch (e) { bad('token 写入-读回往返', e); }

  // ---- 2) proxy 无 token 场景启动并应答 /v1/models ----
  let proxy;
  try {
    proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.js')], { env });
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
        const j = await r.json();
        if (Array.isArray(j.data) && j.data.some(m => m.id === cfg.models[0])) break;
        throw new Error('/v1/models 应答缺模型 id');
      } catch (e) {
        if (Date.now() > deadline) throw new Error('代理 20s 内未应答 /v1/models');
        await new Promise(r => setTimeout(r, 300));
      }
    }
    ok('proxy 启动并应答 /v1/models(无 token 场景)');
  } catch (e) { bad('proxy 启动探活', e); }
  if (proxy) await stop(proxy);

  // ---- 3) watch 守护的调度循环 ----
  // 状态目录里有第 1 步写入的有效 token:守护会打印"token 有效至…等待续期窗口"
  // (顺带验证了跨进程的存储解密——生产形态正是 watch 写、其他进程读);
  // 若无凭据则是"尚未配置凭据"。两种心跳都证明锁/唤醒/调度器装配成功
  let watch;
  try {
    watch = spawn(process.execPath, [path.join(ROOT, 'refresh-token.js'), 'watch'], { env });
    await waitForLine(watch,
      l => l.includes('等待续期窗口') || l.includes('尚未配置凭据'),
      'watch 调度循环', 20000);
    ok('watch 守护启动并进入调度循环(锁/唤醒/调度器/跨进程存储读取)');
  } catch (e) { bad('watch 守护调度循环', e); }
  if (watch) await stop(watch);

  // ---- 清理:钥匙串条目(macOS 反复本地跑会累积)与临时目录 ----
  if (process.platform === 'darwin') {
    for (const account of ['password', 'token']) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('security', ['delete-generic-password', '-s', 'madmodel-proxy', '-a', account],
          { stdio: 'ignore' });
      } catch (e) { /* 条目不存在 */ }
    }
  }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }

  console.log(failed ? `\n平台冒烟失败(${failed} 项)` : '\n平台冒烟通过');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('✗ 冒烟脚本自身异常:', e.message); process.exit(1); });
