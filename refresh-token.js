#!/usr/bin/env node
// refresh-token.js
// CLI:配置凭据(首次) + 手动/自动续期 madmodel token。
// token 写入 %USERPROFILE%\.dsh-madmodel\token.json,反代热加载。
//
// 用法:
//   node refresh-token.js login          # 首次配置:输入学号密码,保存并取一次 token
//   node refresh-token.js once           # 用已存凭据取一次新 token
//   node refresh-token.js watch          # 常驻:到期前 30 分钟自动续,失败退避重试
//   node refresh-token.js status         # 查看当前 token 状态
//   node refresh-token.js key            # 打印代理的 Bearer API key(配置客户端用)

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MadmodelAuthClient, CookieJar, AuthError } = require('./madmodel-auth');
const { loadCreds, saveCreds, hasCreds, CREDS_FILE } = require('./creds');
const { STATE_DIR, TOKEN_FILE, writeTokenRecord, readTokenRecord } = require('./secure-store');

const REFRESH_AHEAD_MS = 30 * 60 * 1000;   // 到期前 30 分钟续
const RETRY_BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const NO_TOKEN_WAIT_MS = 60e3;             // 无 token/文件异常时的等待
const MAX_SLEEP_MS = 60 * 60 * 1000;       // 单次睡眠上限(时钟跳变/兜底)
const LOCK_FILE = path.join(STATE_DIR, 'watch.lock');

// token 统一经 secure-store:DPAPI 加密 + 原子写(旧明文格式下次续期自动升级)
function writeToken(token, expiresAt) {
  writeTokenRecord(token, expiresAt);
}

function readToken() {
  return readTokenRecord();
}

// watch 单实例锁:锁文件记 PID,进程已死/属本进程则接管,否则拒绝启动。
// 防止 start.cmd 重复拉起多个续期进程并发登录(重复二次认证/账号锁定风险)
function acquireWatchLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try { fs.writeFileSync(fd, String(process.pid), 'utf8'); }
      finally { fs.closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch (readError) {}
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 0); alive = true; } catch (probeError) {}
      }
      if (alive) {
        console.error('已有 watch 守护在运行(PID ' + pid + ',锁: ' + LOCK_FILE + ')。本次不重复启动。');
        process.exit(0);
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
}

function releaseWatchLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* 无锁文件 */ }
}
process.on('exit', releaseWatchLock);
// Windows 陷阱:SIGTERM/SIGHUP 处理器在 Windows 上不被 Node 调用,进程被外部
// 结束(任务管理器/关窗口/taskkill)时 exit 也来不及跑 → 锁可能残留。
// 已由"死 PID 自动接管"兜底:下次启动 process.kill(pid,0) 探活失败即接管,
// 锁残留只推迟一次启动判断,不造成死锁。SIGINT(Ctrl+C)在 Windows 控制台有效,
// 保留优雅清理。
process.on('SIGINT', () => { releaseWatchLock(); process.exit(130); });

// 终端二次认证 handler:选验证方式 → 输六位码
function terminalTwoFactorHandler() {
  return async ({ stage, methods, phone }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, res));
    try {
      if (stage === 'method') {
        console.log('\n=== 学校要求二次认证(新设备验证) ===');
        const names = { wechat: '微信', mobile: '手机短信(' + phone + ')', totp: 'TOTP 动态码' };
        methods.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + (names[m] || m)));
        const idx = parseInt(await ask('选择验证方式(序号): '), 10);
        const method = methods[idx - 1];
        if (!method) return null;
        return { method, trustDevice: true };
      }
      if (stage === 'code') {
        const code = await ask('输入六位验证码: ');
        return code;
      }
      return null;
    } finally { rl.close(); }
  };
}

async function fetchToken(credentials, { interactive = true } = {}) {
  const client = new MadmodelAuthClient(new CookieJar());
  return client.getMadModelToken({
    ...credentials,
    // watch 是无人值守守护:二次认证需要人工输码,交互式 rl.question 无超时,
    // 静默等待会让守护假死并占着锁。非交互模式直接失败并指引用户跑一次 login
    twoFactorHandler: interactive ? terminalTwoFactorHandler() : () => {
      throw AuthError('续期需要二次认证(可信设备登记可能已失效)。请运行: node refresh-token.js login 完成一次交互登录', 'TWO_FACTOR_REQUIRED');
    },
  });
}

async function cmdLogin() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
  const username = (await ask('学号: ')).trim();
  if (!username) { console.error('学号不能为空'); process.exit(1); }
  rl.close(); // 释放 stdin,避免与 raw 模式密码输入抢占
  // 隐藏密码输入:raw mode 逐键读取,不回显(退格/回车正常处理),纯 Node 不依赖 PowerShell
  const password = await new Promise(resolve => {
    process.stdout.write('统一认证密码(输入不显示): ');
    if (!process.stdin.isTTY) {
      // 非 TTY(管道环境):按行读,输入内容不经过终端
      process.stdin.once('data', d => {
        process.stdout.write('\n');
        resolve(String(d).trim());
      });
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '') { // Ctrl+C
        process.stdin.setRawMode(false);
        console.error('\n已取消');
        process.exit(130);
      } else if (ch === '' || ch === '\b') { // 退格
        if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (ch >= ' ') {
        buf += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
  if (!password) { console.error('密码不能为空'); process.exit(1); }

  console.log('\n保存凭据(DPAPI 加密)…');
  const creds = saveCreds(username, password);
  console.log('已保存到 ' + CREDS_FILE + '(密码仅当前 Windows 账户可解密)');
  console.log('设备指纹: ' + creds.fingerPrint.slice(0, 8) + '…(首次登录可能触发二次认证,验证一次后免认证;完整指纹存于本地凭据文件)');

  console.log('\n开始登录并获取 token…');
  const { token, expiresAt } = await fetchToken(creds);
  writeToken(token, expiresAt);
  console.log('✅ token 已获取,有效期至 ' + new Date(expiresAt).toLocaleString());
  console.log('已写入 ' + TOKEN_FILE);
}

async function cmdOnce({ interactive = true } = {}) {
  const creds = loadCreds();
  if (!creds) { console.error('未配置凭据,请先: node refresh-token.js login'); process.exit(1); }
  const { token, expiresAt } = await fetchToken(creds, { interactive });
  writeToken(token, expiresAt);
  console.log('✅ token 已续期,有效期至 ' + new Date(expiresAt).toLocaleString());
  return expiresAt;
}

async function cmdWatch() {
  acquireWatchLock();
  console.log('madmodel token 自动续期守护进程已启动(PID ' + process.pid + ')');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const valid = t => t && Number.isFinite(t.expiresAt) && t.expiresAt - Date.now() > REFRESH_AHEAD_MS;
  let retryIdx = 0;
  let badCredsStreak = 0;

  for (;;) {
    const current = readToken();
    if (!current) {
      if (!hasCreds()) {
        // 既无 token 也无凭据:重试无意义,等用户先配置
        console.log('[' + new Date().toLocaleTimeString() + '] 尚无 token 且未配置凭据,请先: node refresh-token.js login');
        await sleep(NO_TOKEN_WAIT_MS);
        continue;
      }
      // 有凭据无 token(如先启 watch 后 login):直接落入下方续期分支
    } else if (valid(current)) {
      // token 仍有效:不轮询,直接睡到续期窗口打开(兜底 1 小时)。
      // 若期间有人手动 login/once 写入新 token,醒来重读文件即自然适应
      const wait = Math.min(current.expiresAt - Date.now() - REFRESH_AHEAD_MS, MAX_SLEEP_MS);
      console.log('[' + new Date().toLocaleTimeString() + '] token 有效至 ' +
        new Date(current.expiresAt).toLocaleString() + ',休眠 ' +
        Math.round(wait / 60e3) + ' 分钟');
      await sleep(wait);
      continue;
    }

    console.log('[' + new Date().toLocaleTimeString() + '] token 即将过期,开始续期…');
    try {
      // watch 无人值守:非交互模式,二次认证立即失败而非挂起等输入
      const expiresAt = await cmdOnce({ interactive: false });
      retryIdx = 0;
      badCredsStreak = 0;
      await sleep(Math.min(Math.max(60e3, expiresAt - Date.now() - REFRESH_AHEAD_MS), MAX_SLEEP_MS));
    } catch (e) {
      // 二次认证需要人工介入,重试无意义:退出并指路
      if (e.code === 'TWO_FACTOR_REQUIRED') {
        console.error('❌ ' + e.message);
        process.exit(1);
      }
      // 密码失效是永久性错误:重试只会一直撞同一堵墙,甚至可能触发账号锁定。
      // 连续 3 次即停守护并指路,不再每 30 分钟空转
      if (e.code === 'BAD_CREDENTIALS' && ++badCredsStreak >= 3) {
        console.error('❌ 统一认证密码已失效(连续 ' + badCredsStreak +
          ' 次)。请重新运行: node refresh-token.js login 更新凭据,守护进程退出。');
        process.exit(1);
      }
      const wait = RETRY_BACKOFF_MS[Math.min(retryIdx, RETRY_BACKOFF_MS.length - 1)];
      retryIdx++;
      console.error('[' + new Date().toLocaleTimeString() + '] 续期失败(' + e.code + '): ' +
        e.message + ', ' + Math.round(wait / 60e3) + ' 分钟后重试');
      await sleep(wait);
    }
  }
}

function cmdStatus() {
  const t = readToken();
  if (!t) { console.log('尚无 token。先运行: node refresh-token.js login'); return; }
  const remain = t.expiresAt - Date.now();
  if (remain <= 0) console.log('token 已过期(' + new Date(t.expiresAt).toLocaleString() + ')');
  else console.log('token 有效,剩余 ' + Math.round(remain / 60e3) + ' 分钟(至 ' +
    new Date(t.expiresAt).toLocaleString() + ')');
  console.log('凭据: ' + (hasCreds() ? '已配置' : '未配置'));
}

function cmdKey() {
  // 代理的 Bearer key 由 proxy.js 首次启动时生成;这里只负责读取展示,配置客户端用
  const keyFile = path.join(STATE_DIR, 'api-key');
  try {
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (key) return console.log(key);
  } catch (e) { /* 尚无文件 */ }
  console.log('尚无 API key——首次启动代理时自动生成(双击 start.cmd 或 node proxy.js)。');
  console.log('也可用环境变量 PROXY_API_KEY 指定自定义 key。');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  try {
    if (cmd === 'login') await cmdLogin();
    else if (cmd === 'once') await cmdOnce();
    else if (cmd === 'watch') await cmdWatch();
    else if (cmd === 'status') cmdStatus();
    else if (cmd === 'key') cmdKey();
    else {
      console.log('用法: node refresh-token.js [login|once|watch|status|key]');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ ' + (e.code ? '[' + e.code + '] ' : '') + e.message);
    process.exit(1);
  }
}

main();

