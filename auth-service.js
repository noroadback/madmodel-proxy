// auth-service.js
// 认证业务:统一认证调用(协议细节在 madmodel-auth.js)、凭据与 token 的落盘
// 编排、watch 守护(watch 的状态机在 core/scheduler.js,本文件只装配依赖)。
// CLI 交互(提示/状态展示)在 adapters/cli.js,存取在 platform/。

'use strict';

const readline = require('readline');
const { MadmodelAuthClient, CookieJar, AuthError, generateFingerprint } = require('./madmodel-auth');
const credentials = require('./platform/credentials');
const processLock = require('./platform/process-lock');
const { createFileWakeup } = require('./platform/file-store');
const { Scheduler } = require('./core/scheduler');
const config = require('./config');
const { TOKEN_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK } = require('./platform/paths');

// 认证操作锁(login/once 与 watch 续期共用):用户手动 login 时 watch 恰好在
// 走登录链,会触发重复二次认证且 token 互相覆盖。watch 抢不到锁按瞬时错误
// 短退避重试(scheduler 的 AUTH_BUSY 分支),人工操作不受影响
async function withAuthLock(fn) {
  const r = processLock.acquirePidLock(AUTH_LOCK);
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
    const { token, expiresAt } = await fetchToken({ username, password, fingerPrint });
    credentials.writeAccount(username, password, fingerPrint);
    credentials.writeToken(token, expiresAt);
    return { expiresAt, fingerPrint, tokenFile: TOKEN_FILE, credsFile: CREDS_FILE };
  });
}

// 用已存凭据取一次新 token:凭据读取、认证、token 写入全程持锁,与 login/
// 其他 once 互斥,避免并发登录触发重复二次认证,以及旧认证结果覆盖新 token
async function refresh({ interactive = true } = {}) {
  return withAuthLock(async () => {
    const creds = credentials.readAccount();
    if (!creds) throw new Error('未配置凭据,请先: node refresh-token.js login');
    const { token, expiresAt } = await fetchToken(creds, { interactive });
    credentials.writeToken(token, expiresAt);
    return { expiresAt, tokenFile: TOKEN_FILE };
  });
}

// 日志时间戳:与代理侧一致的固定 HH:MM:SS(dashboard 会把两边输出交错显示,
// 格式必须对齐;locale 化的时间在不同机器上形态不同)
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

// watch 守护:单实例锁 + 调度器装配。锁的争用与提示属 CLI 决策,留在本层
let activeScheduler = null;
async function watch() {
  const lock = processLock.acquirePidLock(WATCH_LOCK);
  if (!lock.ok) {
    console.error(`已有 watch 守护在运行(PID ${lock.pid},锁: ${WATCH_LOCK}),不重复启动。`);
    console.error('锁为死进程残留时,删除该锁文件后重试。');
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

  console.log('madmodel token 自动续期守护进程已启动(PID ' + process.pid + ')');
  const wakeup = createFileWakeup([TOKEN_FILE, CREDS_FILE]);
  const scheduler = new Scheduler({
    config,
    readToken: () => credentials.readToken(),
    hasCredentials: () => credentials.hasAccount(),
    refresh: () => refresh({ interactive: false }),
    wakeup,
    log: msg => console.log('[' + stamp() + '] ' + msg),
    logError: msg => console.error('[' + stamp() + '] ' + msg),
  });
  activeScheduler = scheduler;
  try {
    await scheduler.run();
  } finally {
    wakeup.close();
    activeScheduler = null;
  }
}

module.exports = { login, refresh, watch };
