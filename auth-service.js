// auth-service.js
// 认证业务:统一认证调用(协议细节在 madmodel-auth.js)、凭据与 token 的落盘
// 编排、watch 守护(watch 的状态机在 core/scheduler.js,本文件只装配依赖)。
// CLI 交互(提示/状态展示)在 adapters/cli.js,存取在 platform/。

'use strict';

const fs = require('fs');
const readline = require('readline');
const { MadmodelAuthClient, CookieJar, AuthError, generateFingerprint, probeWebvpnSession } = require('./madmodel-auth');
const credentials = require('./platform/credentials');
const processLock = require('./platform/process-lock');
const { createFileWakeup } = require('./platform/file-store');
const { Scheduler } = require('./core/scheduler');
const config = require('./config');
const { isProxyRunning } = require('./core/proxy-status');
const { TOKEN_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK, TUNNEL_REVIVE } = require('./platform/paths');

// 认证操作锁(login/once 与 watch 续期共用):用户手动 login 时 watch 恰好在
// 走登录链,会触发重复二次认证且 token 互相覆盖。watch 抢不到锁按瞬时错误
// 短退避重试(scheduler 的 AUTH_BUSY 分支),人工操作不受影响
async function withAuthLock(fn) {
  const r = await processLock.acquirePidLock(AUTH_LOCK);
  if (!r.ok) {
    const e = new Error(`另一认证操作进行中(PID ${r.pid}),请稍后重试`);
    e.code = 'AUTH_BUSY';
    throw e;
  }
  try { return await fn(); } finally { processLock.releasePidLock(AUTH_LOCK); }
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

async function fetchToken(accountCredentials, { interactive = true } = {}) {
  const client = new MadmodelAuthClient(new CookieJar());
  return client.getMadModelToken({
    ...accountCredentials,
    // watch 是无人值守守护:二次认证需要人工输码,交互式 rl.question 无超时,
    // 静默等待会让守护假死并占着锁。非交互模式直接失败并指引用户跑一次 login
    twoFactorHandler: interactive ? terminalTwoFactorHandler() : () => {
      throw AuthError('续期需要二次认证(可信设备登记可能已失效)。请运行: node refresh-token.js login 完成一次交互登录', 'TWO_FACTOR_REQUIRED');
    },
  });
}

// 首次配置:凭据保存、认证、token 写入同锁原子化,且认证成功后才落盘新凭据
// ——登录失败不覆盖旧凭据(watch 仍可用旧凭据续期),token 也不会被他方
// 并发认证的结果覆盖
async function login({ username, password }) {
  return withAuthLock(async () => {
    const fingerPrint = generateFingerprint();
    const { token, expiresAt, cookie } = await fetchToken({ username, password, fingerPrint });
    credentials.writeAccount(username, password, fingerPrint);
    credentials.writeToken(token, expiresAt, cookie);
    return { expiresAt, fingerPrint, tokenFile: TOKEN_FILE, credsFile: CREDS_FILE };
  });
}

// 用已存凭据取一次新 token:凭据读取、认证、token 写入全程持锁,与 login/
// 其他 once 互斥,避免并发登录触发重复二次认证,以及旧认证结果覆盖新 token
async function refresh({ interactive = true } = {}) {
  return withAuthLock(async () => {
    const creds = credentials.readAccount();
    if (!creds) throw new Error('未配置凭据,请先: node refresh-token.js login');
    const { token, expiresAt, cookie } = await fetchToken(creds, { interactive });
    credentials.writeToken(token, expiresAt, cookie);
    return { expiresAt, tokenFile: TOKEN_FILE };
  });
}

// 日志时间戳:与代理侧一致的固定 HH:MM:SS(dashboard 会把两边输出交错显示,
// 格式必须对齐;locale 化的时间在不同机器上形态不同)
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

// 登出:清除本工具保存的全部本地凭据(密码/token/隧道会话)。
// 前置:服务必须已停——运行中的代理持有 token 缓存(读失败时回退旧值),
// 运行中的 watch 会把清掉的凭据重新写回,清除即被架空。首版(1.9.0)
// 只支持停服后清理,不做代停(进程身份确认与停止顺序的复杂度留给真实
// 需要时)。远端不撤销:学校侧登录状态活到自然过期(约 6 小时)
async function logout() {
  if (await isProxyRunning(config.port, undefined, config.host)) {
    throw new Error('代理仍在运行。请先用 Ctrl+C 停止代理与续期守护，再执行 logout');
  }
  // ② watch 在跑?(锁 PID 探活)
  try {
    const lockPid = processLock.pidOf(fs.readFileSync(WATCH_LOCK, 'utf8'));
    if (lockPid > 0 && processLock.isAlive(lockPid)) {
      const e = new Error(`watch 续期守护仍在运行(PID ${lockPid})。请先用 Ctrl+C 停止续期守护,再执行 logout`);
      e.serviceRunning = true;
      throw e;
    }
  } catch (e) {
    if (e.serviceRunning) throw e; // 自身的指引错误原样上抛
    // 只有"锁文件不存在"才等于未运行。其余读取失败(权限、目录被占、
    // IO 错误)不是"没在跑"的证据——静默放行会在这道闸本该校验的场景下
    // 直接清掉凭据。上抛让用户看到原因再决定(2026-09-22 审阅指出)
    if (e.code !== 'ENOENT') throw e;
    /* ENOENT = 无锁文件,未运行,继续 */
  }
  // ③ 持认证锁清除(与 login/once 互斥,防进行中的续期写回)
  return withAuthLock(() => {
    const cleared = credentials.clearAll();
    return { cleared };
  });
}

// watch 守护:单实例锁 + 调度器装配。锁的争用与提示属 CLI 决策,留在本层
let activeScheduler = null;
async function watch() {
  const lock = await processLock.acquirePidLock(WATCH_LOCK);
  if (!lock.ok) {
    console.error(`续期服务已在运行（PID ${lock.pid}），跳过启动。`);
    process.exit(0);
  }
  process.on('exit', () => processLock.releasePidLock(WATCH_LOCK));
  // Windows 陷阱:SIGTERM/SIGHUP 处理器在 Windows 上不被 Node 调用,进程被外部
  // 结束(任务管理器/关窗口/taskkill)时 exit 也来不及跑 → 锁可能残留。
  // 已由"死 PID 自动接管"兜底:下次启动探活失败即接管,锁残留只推迟一次启动
  // 判断,不造成死锁。SIGINT(Ctrl+C)在 Windows 控制台有效,保留优雅清理。
  process.on('SIGINT', () => {
    if (activeScheduler) activeScheduler.stop(); // 清理挂起的等待
    processLock.releasePidLock(WATCH_LOCK);
    process.exit(130);
  });

  console.log('自动续期已启动');
  // TUNNEL_REVIVE 一并纳入监听:代理遇隧道会话被拒(302→/login,如网络切换
  // 后 WebVPN 会话绑定失效)时写该标志,文件事件把 wait 提前唤醒
  const wakeup = createFileWakeup([TOKEN_FILE, CREDS_FILE, TUNNEL_REVIVE]);
  // 标志消费:唤醒后若标志存在,poke 保活时钟让主循环下一圈立即探活重签
  // (秒级自愈,不等 25 分钟的常规周期)。消费即删除;删除动作会再触发一次
  // 无害的空唤醒(标志已不在,按普通 token/creds 事件处理)
  let consumeRevive = null;
  const scheduler = new Scheduler({
    config,
    readToken: () => credentials.readToken(),
    hasCredentials: () => credentials.hasAccount(),
    refresh: () => refresh({ interactive: false }),
    wakeup: {
      reset: () => wakeup.reset(),
      close: () => wakeup.close(),
      wait: ms => wakeup.wait(ms).then(reason => {
        if (reason === 'changed' && consumeRevive) consumeRevive();
        return reason;
      }),
    },
    log: msg => console.log('[' + stamp() + '] ' + msg),
    logError: msg => console.error('[' + stamp() + '] ' + msg),
  });
  consumeRevive = () => {
    try {
      fs.statSync(TUNNEL_REVIVE);
      fs.unlinkSync(TUNNEL_REVIVE);
    } catch (e) {
      // 标志不存在 = 普通 token/creds 事件,静默;其他错误(权限/占用)留痕:
      // 标志会残留并在下次唤醒重试,但反复戳不醒的故障不能无声消失
      if (e.code !== 'ENOENT') {
        console.error('[' + stamp() + '] 消费 tunnel-revive 标志失败(' + e.code + '): ' + e.message);
      }
      return;
    }
    console.log('[' + stamp() + '] WebVPN 会话被拒绝，正在检查');
    scheduler.pokeKeepalive();
  };
  // 隧道会话保活:带存储的 cookie 探活 WebVPN 隧道(探测本身重置隧道空闲
  // 计时),失效则 scheduler 立即重签。上游非隧道形态(config.keepaliveUrl
  // 为 null,如测试假上游)时不启用
  if (config.keepaliveUrl) {
    scheduler.enableKeepalive(async () => {
      const t = credentials.readToken();
      // 无 token 时探活无意义(主循环自会走续期路径),按 ok 跳过
      if (!t) return 'ok';
      return probeWebvpnSession(config.keepaliveUrl, t.cookie);
    });
  }
  activeScheduler = scheduler;
  try {
    await scheduler.run();
  } finally {
    wakeup.close();
    activeScheduler = null;
  }
}

module.exports = { login, refresh, watch, logout };
