// core/scheduler.js
// 续期调度循环(纯编排,不含认证协议细节——不知道登录页面、Cookie、SM2
// 或验证码;认证通过注入的 refresh() 完成)。
//
// 规则:
//   - 按 expiresAt - refreshAheadMs 调度,不做固定周期轮询
//   - 文件创建/删除/原子替换立即唤醒(wakeup.wait 提前返回)
//   - 成功后重新读取 token、重新计算 deadline;自身写入的延迟事件不产生忙循环
//   - 无 token 且无凭据时按 noTokenWaitMs 等待
//   - 失败按指数退避;文件事件可提前唤醒检查,但不能绕过退避截止时间
//   - TWO_FACTOR_REQUIRED 立即停止(抛出,由 CLI 层退出)
//   - BAD_CREDENTIALS 连续达到上限后停止(抛出)
//   - AUTH_BUSY(人工 login 持锁的正常争用)短退避,不吃指数档位
//   - stop() / 结束时清理 pending 等待;wakeup 由调用方在 finally 关闭
//
// 保活(可选,注入 keepalive 探测函数后启用):
//   - 等待时长额外受 nextKeepaliveAt 封顶,到期探活隧道会话
//   - 启动时立即探活一次(修复"闲置后启动,cookie 已死"的场景)
//   - 'invalid' 立刻走 refresh 重签 token+cookie,90 秒后复核新凭据;
//     重签失败 5 分钟后再探(独立的轻量节奏,不吃主循环退避档位),但
//     BAD_CREDENTIALS 连续 3 次与主循环同纪律上抛(改了密码等场景,重试
//     无意义,5 分钟一次的完整登录链只会空打 id.tsinghua.edu.cn)
//   - 'network'(网络抖动)不动凭据,静默等下个周期

'use strict';

class Scheduler {
  constructor({ config, readToken, hasCredentials, refresh, wakeup, log, logError, now = Date.now }) {
    this.config = config;
    this.readToken = readToken;
    this.hasCredentials = hasCredentials;
    this.refresh = refresh;
    this.wakeup = wakeup;
    this.log = log || (() => {});
    this.logError = logError || (() => {});
    this.now = now;
    this.stopping = false;
    // keepalive: () => 'ok' | 'invalid' | 'network'(协议细节在注入方);
    // 未注入(测试/非隧道上游)时保活整体禁用
    this.keepalive = null;
    this.nextKeepaliveAt = 0;
    // 保活触发的重签连续 BAD_CREDENTIALS 计数(与主循环 badCredsStreak 同
    // 语义:非坏凭据的失败清零,连续 3 次上抛)
    this.keepaliveBadCreds = 0;
  }

  // 注入保活探测函数后启用保活;启用即时钟归零、坏凭据计数清零(防御:
  // 未来若有重启用场景,不残留上次的计数)
  enableKeepalive(probe) {
    this.keepalive = probe;
    this.nextKeepaliveAt = 0;
    this.keepaliveBadCreds = 0;
  }

  // 外部 poking:代理侧发现隧道会话被拒(302→/login)时,watch 消费 revive
  // 标志后调这里——把保活时钟拉回当前,主循环下一圈立即探活重签。用于
  // 网络切换后 WebVPN 会话绑定失效的快速自愈(会话绑定来源网络,切网即死,
  // 常规保活周期最长要等 25 分钟)。未启用保活时是空操作
  pokeKeepalive() {
    if (this.keepalive) this.nextKeepaliveAt = 0;
  }

  // 外部关闭:解除挂起的等待,循环在下一次检查点退出
  stop() {
    this.stopping = true;
    this.wakeup.close();
  }

  // 保活到期则探活;返回是否已到期执行(主循环据此决定 continue)
  async runKeepaliveIfDue() {
    if (!this.keepalive) return false;
    if (this.now() < this.nextKeepaliveAt) return false;
    const { config } = this;
    this.nextKeepaliveAt = this.now() + config.keepAliveIntervalMs;
    let verdict;
    try {
      verdict = await this.keepalive();
    } catch (e) {
      verdict = 'network';
    }
    if (verdict === 'ok') return true;
    if (verdict === 'network') {
      // 网络抖动不动凭据,但不能等满一个保活周期——期间代理可能正坏着
      // (会话已失效未检出),短周期重探尽快把状态问清楚
      this.nextKeepaliveAt = this.now() + 90e3;
      return true;
    }
    this.log('WebVPN 隧道会话已失效,提前续期(重签 token + cookie)');
    try {
      await this.refresh();
      this.keepaliveBadCreds = 0;
      // 90 秒后复核新 cookie 确已生效,而不是等满一个保活周期
      this.nextKeepaliveAt = this.now() + 90e3;
    } catch (e) {
      if (e.code === 'TWO_FACTOR_REQUIRED') throw e;
      // 与主循环同纪律:连续 3 次坏凭据上抛停止——继续重试只是空打登录链
      this.keepaliveBadCreds = e.code === 'BAD_CREDENTIALS' ? this.keepaliveBadCreds + 1 : 0;
      if (this.keepaliveBadCreds >= 3) throw e;
      this.logError('保活触发的续期失败(' + (e.code || 'unknown') + '): ' + e.message + ',5 分钟后再试');
      this.nextKeepaliveAt = this.now() + 5 * 60e3;
    }
    return true;
  }

  async run() {
    const { config, wakeup } = this;
    let retryIdx = 0;
    let badCredsStreak = 0;
    let nextAttemptAt = 0;

    for (;;) {
      // Read after clearing notifications; changes during the read stay pending.
      wakeup.reset();
      const current = this.readToken();
      const untilRefresh = current ? current.expiresAt - this.now() - config.refreshAheadMs : 0;
      if (untilRefresh > 0) {
        // 等待同时受保活周期封顶;keepalive 未启用时 untilKeepalive 为 Infinity
        const untilKeepalive = this.keepalive
          ? Math.max(0, this.nextKeepaliveAt - this.now()) : Infinity;
        this.log('token 有效至 ' + new Date(current.expiresAt).toLocaleString() + ',等待续期窗口');
        await wakeup.wait(Math.min(untilRefresh, config.maxSleepMs, untilKeepalive));
        if (this.stopping) break;
        await this.runKeepaliveIfDue();
        if (this.stopping) break;
        continue;
      }
      if (!this.hasCredentials()) {
        this.log('尚未配置凭据,请先: node refresh-token.js login');
        await wakeup.wait(config.noTokenWaitMs);
        if (this.stopping) break;
        continue;
      }
      // Short-lived tokens and delayed notifications of our own writes must not spin.
      if (this.now() < nextAttemptAt) {
        await wakeup.wait(nextAttemptAt - this.now());
        if (this.stopping) break;
        continue;
      }

      this.log('token 需要续期,开始认证');
      try {
        await this.refresh();
        retryIdx = 0;
        badCredsStreak = 0;
        // 成功后至少隔 60s 再评估:等延迟的文件事件消化完,避免忙循环
        nextAttemptAt = this.now() + 60e3;
      } catch (e) {
        if (e.code === 'TWO_FACTOR_REQUIRED') throw e;
        badCredsStreak = e.code === 'BAD_CREDENTIALS' ? badCredsStreak + 1 : 0;
        if (badCredsStreak >= 3) throw e;
        // AUTH_BUSY 是人工 login 持锁的正常争用:短退避即可,不吃指数退避档位
        const wait = e.code === 'AUTH_BUSY'
          ? 5e3
          : config.retryBackoffMs[Math.min(retryIdx++, config.retryBackoffMs.length - 1)];
        nextAttemptAt = this.now() + wait;
        this.logError('续期失败(' + (e.code || 'unknown') + '): ' + e.message + ', ' +
          (wait >= 60e3 ? Math.round(wait / 60e3) + ' 分钟' : Math.round(wait / 1000) + ' 秒') + '后重试');
      }
    }
  }
}

module.exports = { Scheduler };
