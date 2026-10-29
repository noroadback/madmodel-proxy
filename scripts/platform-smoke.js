#!/usr/bin/env node
// scripts/platform-smoke.js — 跨平台"启动 + 存储"冒烟(不访问学校、不触碰
// 真实状态目录)。1.4.0 起凭据存储分平台(Windows DPAPI / macOS 钥匙串 /
// Linux 机器绑定加密),node --check 语法门验证不了这些路径,本脚本在临时
// 状态目录里验证三件事:
//   1) 凭据与 token 的新建、重复更新和读回(真实调用当前平台的存储原语)
//      macOS 另验证旧版带 -T 创建的条目可直接更新
//   2) proxy.js 无 token 启动并应答 /v1/models
//   3) refresh-token.js watch 在无凭据时的调度循环(锁/文件唤醒/调度器)
// 测试隔离：清理继承的路径与上游覆盖，状态目录及钥匙串每次运行独立。
// 哨兵只用测试命名空间，并发运行互不清理。
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
const { randomUUID } = require('crypto');
const { createTestEnv, applyTestEnv } = require('./isolated-env');
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

// macOS 钥匙串隔离(1.8.1):测试与哨兵的 service 名。生产默认名是
// 'madmodel-proxy'(见 platform/macos/credentials.js),测试经
// MADMODEL_KEYCHAIN_SERVICE 指到独立命名空间
const KC_TEST_SERVICE = `madmodel-smoke-${randomUUID()}`;
const KC_SENTINEL_SERVICE = `madmodel-sentinel-${randomUUID()}`;

function secRun(args) {
  const { execFileSync } = require('child_process');
  return execFileSync('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
const secB64 = s => Buffer.from(s, 'utf8').toString('base64');
function secRead(svc, account) {
  try {
    return Buffer.from(secRun(['find-generic-password', '-s', svc, '-a', account, '-w']).toString().trim(), 'base64').toString('utf8');
  } catch (e) { return null; }
}

async function main() {
  // 必须在 require platform 模块之前生效:paths.js 在加载期读环境变量;
  // macOS 的 credentials 模块同样在加载期读 MADMODEL_KEYCHAIN_SERVICE
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madmodel-smoke-'));
  const port = await freePort();
  const env = createTestEnv(stateDir, { PROXY_PORT: String(port), MADMODEL_KEYCHAIN_SERVICE: KC_TEST_SERVICE });
  applyTestEnv(env);

  const credentials = require('../platform/credentials');
  const cfg = require('../config');

  try {
  // 哨兵也使用独立命名空间；不读取、创建或删除生产钥匙串条目。
  if (process.platform === 'darwin') {
    secRun(['add-generic-password', '-s', KC_SENTINEL_SERVICE, '-a', 'password', '-w', secB64('sentinel-v0')]);
    ok('钥匙串隔离哨兵就绪');
  }
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
    credentials.writeToken('tok-►-smoke', expiresAt, 'cookie-►-smoke');
    const t = credentials.readToken();
    assert(t && t.token === 'tok-►-smoke', 'token 往返不一致: 写入 "tok-►-smoke" 读回 ' + show(t && t.token));
    assert(t.expiresAt === expiresAt, 'expiresAt 往返不一致: 写入 ' + expiresAt + ' 读回 ' + (t && t.expiresAt));
    assert(t && t.cookie === 'cookie-►-smoke', 'cookie 往返不一致: 写入 "cookie-►-smoke" 读回 ' + show(t && t.cookie));
    ok('token/cookie 写入-读回往返');
  } catch (e) { bad('token/cookie 写入-读回往返', e); }

  // 只验证首次写入无法发现 macOS -U 搭配 -T 每次更新都会修改 ACL 的问题。
  try {
    for (let i = 1; i <= 2; i++) {
      credentials.writeAccount('smoke-user', `${PW}-${i}`, 'smoke-fp');
      const expiresAt = Date.now() + 3600e3;
      credentials.writeToken(`tok-update-${i}`, expiresAt, `cookie-update-${i}`);
      assert(credentials.readAccount()?.password === `${PW}-${i}`, '重复更新后密码读回不一致');
      const t = credentials.readToken();
      assert(t?.token === `tok-update-${i}` && t.expiresAt === expiresAt &&
        t.cookie === `cookie-update-${i}`, '重复更新后 token/cookie 或有效期不一致');
    }
    ok('密码/token/cookie 连续更新后读回一致');
  } catch (e) { bad('密码/token/cookie 重复更新', e); }

  if (process.platform === 'darwin') {
    try {
      // 仅重建本次冒烟的三条测试凭据，复现旧版本创建方式，不需要真实登录。
      credentials.clearAll();
      for (const account of ['password', 'token', 'webvpn-cookie']) {
        secRun(['add-generic-password', '-s', KC_TEST_SERVICE, '-a', account,
          '-w', secB64(`legacy-${account}`), '-T', '/usr/bin/security']);
      }
      credentials.writeAccount('smoke-user', PW, 'smoke-fp');
      const expiresAt = Date.now() + 3600e3;
      credentials.writeToken('upgraded-token', expiresAt, 'upgraded-cookie');
      assert(credentials.readAccount()?.password === PW, '旧条目更新后密码不一致');
      const t = credentials.readToken();
      assert(t?.token === 'upgraded-token' && t.expiresAt === expiresAt &&
        t.cookie === 'upgraded-cookie', '旧条目更新后 token/cookie 或有效期不一致');
      credentials.writeToken('upgraded-token-again', expiresAt);
      const again = credentials.readToken();
      assert(again?.token === 'upgraded-token-again' && again.cookie === 'upgraded-cookie',
        '未提供 cookie 的再次更新应保留已有 cookie');
      ok('旧版 -T 条目可直接更新，再次更新保留未改动的 cookie');
    } catch (e) { bad('macOS 旧版钥匙串条目兼容更新', e); }
  }

  // ---- 1b) macOS 哨兵复核:测试实例的所有操作不得影响任何隔离命名空间 ----
  if (process.platform === 'darwin') {
    try {
      assert(secRead(KC_SENTINEL_SERVICE, 'password') === 'sentinel-v0', '第三命名空间哨兵被测试操作改写(隔离失效)');
      ok('哨兵复核:测试实例未触碰任何隔离命名空间');
    } catch (e) { bad('哨兵复核', e); }
  }

  // ---- 1c) 登出清除:clearAll 移除全部凭据,且只动测试命名空间 ----
  try {
    const cleared = credentials.clearAll();
    assert(cleared.length >= 2, 'clearAll 应至少清除 token 与账号文件');
    assert(credentials.readToken() === null, '清除后 readToken 应为 null');
    assert(credentials.readAccount() === null, '清除后 readAccount 应为 null');
    assert(credentials.hasAccount() === false, '清除后 hasAccount 应为 false');
    if (process.platform === 'darwin') {
      assert(secRead(KC_TEST_SERVICE, 'password') === null, '清除后钥匙串 password 条目应不存在');
      assert(secRead(KC_TEST_SERVICE, 'token') === null, '清除后钥匙串 token 条目应不存在');
      assert(secRead(KC_TEST_SERVICE, 'webvpn-cookie') === null, '清除后钥匙串 cookie 条目应不存在');
      assert(secRead(KC_SENTINEL_SERVICE, 'password') === 'sentinel-v0', 'clearAll 不得触碰哨兵命名空间');
    }
    ok('登出清除(全凭据移除,仅限测试命名空间)');
  } catch (e) { bad('登出清除', e); }

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
  // 1c 已清除凭据:守护打印"尚未配置凭据"(该心跳证明锁/唤醒/调度器装配
  // 成功;token 有效性路径由 1a 的跨进程读回覆盖)
  let watch;
  try {
    watch = spawn(process.execPath, [path.join(ROOT, 'refresh-token.js'), 'watch'], { env });
    await waitForLine(watch,
      l => l.includes('等待续期窗口') || l.includes('尚未配置凭据'),
      'watch 调度循环', 20000);
    ok('watch 守护启动并进入调度循环(锁/唤醒/调度器/跨进程存储读取)');
  } catch (e) { bad('watch 守护调度循环', e); }
  if (watch) await stop(watch);

  } finally {
    // ---- 清理:只删本脚本自建的条目(测试 service 三个账号 + 哨兵),----
    // 绝不触碰生产命名空间;异常退出也会走到这里(finally)
    if (process.platform === 'darwin') {
      const targets = [
        [KC_TEST_SERVICE, ['password', 'token', 'webvpn-cookie']],
        [KC_SENTINEL_SERVICE, ['password']],
      ];
      for (const [svc, accounts] of targets) {
        for (const a of accounts) {
          try { secRun(['delete-generic-password', '-s', svc, '-a', a]); } catch (e) { /* 条目不存在 */ }
        }
      }
    }
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
  }

  console.log(failed ? `\n平台冒烟失败(${failed} 项)` : '\n平台冒烟通过');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('✗ 冒烟脚本自身异常:', e.message); process.exit(1); });
