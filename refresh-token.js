#!/usr/bin/env node
// refresh-token.js
// CLI:配置凭据(首次) + 手动/自动续期 madmodel token。
// token 写入 %USERPROFILE%\.dsh-madmodel\token.json,反代热加载。
//
// 用法:
//   node refresh-token.js login          # 首次配置:输入学号密码,保存并取一次 token
//   node refresh-token.js once           # 用已存凭据取一次新 token
//   node refresh-token.js watch          # 常驻:到期前 30 分钟自动续,失败退避重试
//   node refresh-token.js status         # 一屏查看运行状态(代理/token/watch/key)
//   node refresh-token.js key            # 打印代理的 Bearer API key(配置客户端用)

'use strict';

const fs = require('fs');
const readline = require('readline');
const { MadmodelAuthClient, CookieJar, AuthError, generateFingerprint } = require('./madmodel-auth');
const { loadCreds, saveCreds, hasCreds } = require('./creds');
const { writeTokenRecord, readTokenRecord } = require('./secure-store');
const { claimFile } = require('./atomic-file');
const { TOKEN_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK, resolveApiKey } = require('./paths');

const REFRESH_AHEAD_MS = 30 * 60 * 1000;   // 到期前 30 分钟续
const RETRY_BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const NO_TOKEN_WAIT_MS = 60e3;             // 无 token/文件异常时的等待
const MAX_SLEEP_MS = 60 * 60 * 1000;       // 单次睡眠上限(时钟跳变/兜底)

// ===== PID 锁(watch 单实例锁 + 认证操作锁共用) =====
// 争用与原子安装由 atomic-file.js 的 claimFile 承担,这里只定义"什么算有效锁":
// 自己的 PID,或一个仍然存活的 PID。空/垃圾内容(旧版本中断写入、升级遗留)
// 与死 PID 一律视为可接管。
// 已知取舍:PID 被系统复用时会误判为"持有者存活"——fail-safe 方向(拒绝启动
// 而非双跑),按提示删锁即可恢复,这是无原生进程标识 API 下的合理代价
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

// watch 单实例锁(进程存活期持有):防止 start.cmd 重复拉起多个续期进程
// 并发登录(重复二次认证/账号锁定风险)
function acquireWatchLock() {
  const r = acquirePidLock(WATCH_LOCK);
  if (!r.ok) {
    console.error(`已有 watch 守护在运行(PID ${r.pid},锁: ${WATCH_LOCK})。本次不重复启动。`);
    console.error('若确认该进程并非 watch(锁残留且 PID 被系统复用),删除上述锁文件后重试即可。');
    process.exit(0);
  }
}
process.on('exit', () => releasePidLock(WATCH_LOCK));
// Windows 陷阱:SIGTERM/SIGHUP 处理器在 Windows 上不被 Node 调用,进程被外部
// 结束(任务管理器/关窗口/taskkill)时 exit 也来不及跑 → 锁可能残留。
// 已由"死 PID 自动接管"兜底:下次启动探活失败即接管,锁残留只推迟一次启动
// 判断,不造成死锁。SIGINT(Ctrl+C)在 Windows 控制台有效,保留优雅清理。
process.on('SIGINT', () => { releasePidLock(WATCH_LOCK); process.exit(130); });

// 认证操作锁(login/once 与 watch 续期共用):用户手动 login 时 watch 恰好在
// 走登录链,会触发重复二次认证且 token 互相覆盖。watch 抢不到锁按瞬时错误
// 退避重试(现有重试循环消化),人工操作不受影响
async function withAuthLock(fn) {
  const r = acquirePidLock(AUTH_LOCK);
  if (!r.ok) {
    const e = new Error(`另一认证操作进行中(PID ${r.pid}),请稍后重试`);
    e.code = 'AUTH_BUSY';
    throw e;
  }
  try { return await fn(); } finally { releasePidLock(AUTH_LOCK); }
}

// 终端二次认证 handler:选验证方式 → 输六位码
function terminalTwoFactorHandler() {
  return async ({ stage, methods, phone }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, res));
    try {
      if (stage === 'method') {
        console.log('\n=== 学校要求二次认证(新设备验证) ===');
        const names = { wechat: '微信', mobile: `手机短信(${phone})`, totp: 'TOTP 动态码' };
        methods.forEach((m, i) => console.log(`  ${i + 1}. ${names[m] || m}`));
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

  console.log('\n开始登录并获取 token…');
  // 认证操作锁:交互式登录含 2FA 人工输入可能持锁数分钟,期间 watch 续期按
  // 瞬时错误退避。凭据保存、认证、token 写入同锁原子化,且认证成功后才落盘
  // 新凭据——登录失败不覆盖旧凭据(watch 仍可用旧凭据续期),token 也不会
  // 被他方并发认证的结果覆盖
  await withAuthLock(async () => {
    const fingerPrint = generateFingerprint();
    const { token, expiresAt } = await fetchToken({ username, password, fingerPrint });
    saveCreds(username, password, fingerPrint);
    writeTokenRecord(token, expiresAt);
    console.log(`✅ token 已获取,有效期至 ${new Date(expiresAt).toLocaleString()}`);
    console.log(`已写入 ${TOKEN_FILE}`);
    console.log(`凭据已保存到 ${CREDS_FILE}(密码仅当前 Windows 账户可解密)`);
    console.log(`设备指纹: ${fingerPrint.slice(0, 8)}…` +
      '(首次登录可能触发二次认证,验证一次后免认证;完整指纹存于本地凭据文件)');
  });
}

async function cmdOnce({ interactive = true } = {}) {
  // 凭据读取、认证、token 写入全程持锁:与 login/其他 once 互斥,避免并发
  // 登录触发重复二次认证,以及旧认证结果覆盖新 token 的交错
  return withAuthLock(async () => {
    const creds = loadCreds();
    if (!creds) throw new Error('未配置凭据,请先: node refresh-token.js login');
    const { token, expiresAt } = await fetchToken(creds, { interactive });
    writeTokenRecord(token, expiresAt);
    console.log(`✅ token 已续期,有效期至 ${new Date(expiresAt).toLocaleString()}`);
    return expiresAt;
  });
}

// 日志时间戳:与 proxy.js 一致的固定 HH:MM:SS(dashboard 会把两边输出交错显示,
// 格式必须对齐;locale 化的时间在不同机器上形态不同)
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function cmdWatch() {
  acquireWatchLock();
  console.log(`madmodel token 自动续期守护进程已启动(PID ${process.pid})`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const valid = t => t && Number.isFinite(t.expiresAt) && t.expiresAt - Date.now() > REFRESH_AHEAD_MS;
  let retryIdx = 0;
  let badCredsStreak = 0;

  for (;;) {
    const current = readTokenRecord();
    if (!current) {
      if (!hasCreds()) {
        // 既无 token 也无凭据:重试无意义,等用户先配置
        console.log(`[${stamp()}] 尚无 token 且未配置凭据,请先: node refresh-token.js login`);
        await sleep(NO_TOKEN_WAIT_MS);
        continue;
      }
      // 有凭据无 token(如先启 watch 后 login):直接落入下方续期分支
    } else if (valid(current)) {
      // token 仍有效:不轮询,直接睡到续期窗口打开(兜底 1 小时)。
      // 若期间有人手动 login/once 写入新 token,醒来重读文件即自然适应
      const wait = Math.min(current.expiresAt - Date.now() - REFRESH_AHEAD_MS, MAX_SLEEP_MS);
      console.log(`[${stamp()}] token 有效至 ${new Date(current.expiresAt).toLocaleString()}` +
        `,休眠 ${Math.round(wait / 60e3)} 分钟`);
      await sleep(wait);
      continue;
    }

    console.log(`[${stamp()}] token 即将过期,开始续期…`);
    try {
      // watch 无人值守:非交互模式,二次认证立即失败而非挂起等输入
      const expiresAt = await cmdOnce({ interactive: false });
      retryIdx = 0;
      badCredsStreak = 0;
      await sleep(Math.min(Math.max(60e3, expiresAt - Date.now() - REFRESH_AHEAD_MS), MAX_SLEEP_MS));
    } catch (e) {
      // 二次认证需要人工介入,重试无意义:退出并指路
      if (e.code === 'TWO_FACTOR_REQUIRED') {
        console.error(`❌ ${e.message}`);
        process.exit(1);
      }
      // 密码失效是永久性错误:重试只会一直撞同一堵墙,甚至可能触发账号锁定。
      // 连续 3 次即停守护并指路,不再每 30 分钟空转
      if (e.code === 'BAD_CREDENTIALS' && ++badCredsStreak >= 3) {
        console.error(`❌ 统一认证密码已失效(连续 ${badCredsStreak} 次)。` +
          '请重新运行: node refresh-token.js login 更新凭据,守护进程退出。');
        process.exit(1);
      }
      const wait = RETRY_BACKOFF_MS[Math.min(retryIdx, RETRY_BACKOFF_MS.length - 1)];
      retryIdx++;
      console.error(`[${stamp()}] 续期失败(${e.code}): ${e.message}` +
        `, ${Math.round(wait / 60e3)} 分钟后重试`);
      await sleep(wait);
    }
  }
}

// 一屏状态:代理/token/watch/key 四问四答。全部只读,可随时运行。
async function cmdStatus() {
  // 1) 代理:/v1/models 在鉴权之前、无需 key;返回 DeepSeek-V4-Flash
  //    即确认是本代理在监听(而非端口被其他程序占用)
  const port = Number(process.env.PROXY_PORT) || 8080;
  let proxyUp = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json().catch(() => null);
    proxyUp = r.status === 200 && Array.isArray(j?.data) && j.data.some(m => m.id === 'DeepSeek-V4-Flash');
  } catch (e) { /* 未运行/超时/非本代理 */ }
  console.log('代理: ' + (proxyUp ? `运行中 → http://127.0.0.1:${port}/v1` : '未运行(双击 start.cmd 启动)'));

  // 2) token:三态口径与代理启动横幅一致
  const t = readTokenRecord();
  if (!t) console.log('token: 尚无(先运行: node refresh-token.js login)');
  else {
    const remainMin = Math.round((t.expiresAt - Date.now()) / 60e3);
    const until = new Date(t.expiresAt).toLocaleString();
    if (remainMin <= 0) console.log(`token: 已过期 ${-remainMin} 分钟(至 ${until})`);
    else if (remainMin < 30) console.log(`token: 剩余 ${remainMin} 分钟(即将进入续期窗口)`);
    else console.log(`token: 剩余 ${remainMin} 分钟(至 ${until})`);
  }

  // 3) watch 守护:锁文件 PID 探活(与 acquirePidLock 同一套判定)
  let lockPid = 0;
  try { lockPid = pidOf(fs.readFileSync(WATCH_LOCK, 'utf8')); } catch (e) { /* 无锁文件 */ }
  const watchAlive = lockPid > 0 && isAlive(lockPid);
  console.log('watch 续期守护: ' + (watchAlive ? `运行中(PID ${lockPid})`
    : `未运行(随 start.cmd 启动${lockPid ? ';当前锁文件为死进程残留,下次启动自动接管' : ''})`));

  // 4) 凭据与 key(优先级由 paths.resolveApiKey 统一裁定,与代理同源)
  console.log('凭据: ' + (hasCreds() ? '已配置' : '未配置(node refresh-token.js login)'));
  const keyState = {
    disabled: '鉴权已关闭(PROXY_NO_AUTH=1),key 不参与鉴权',
    env: '环境变量 PROXY_API_KEY 已设置(优先于文件)',
    file: '已生成(查看: node refresh-token.js key)',
    none: '未生成(首次启动代理时自动生成)',
  };
  console.log('API key: ' + keyState[resolveApiKey().source]);
}

function cmdKey() {
  const { key, source } = resolveApiKey();
  if (source === 'disabled') {
    console.log('本地鉴权已关闭(PROXY_NO_AUTH=1),key 不参与鉴权。');
    return;
  }
  if (source === 'none') {
    console.log('尚无 API key——首次启动代理时自动生成(双击 start.cmd 或 node proxy.js)。');
    console.log('也可用环境变量 PROXY_API_KEY 指定自定义 key。');
    return;
  }
  console.log(key);
  if (source === 'env') console.log('(来自环境变量 PROXY_API_KEY,优先于 key 文件)');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  try {
    if (cmd === 'login') await cmdLogin();
    else if (cmd === 'once') await cmdOnce();
    else if (cmd === 'watch') await cmdWatch();
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'key') cmdKey();
    else {
      console.log('用法: node refresh-token.js [login|once|watch|status|key]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ ${e.code ? `[${e.code}] ` : ''}${e.message}`);
    process.exit(1);
  }
}

main();

