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
  }

  // 外部关闭:解除挂起的等待,循环在下一次检查点退出
  stop() {
    this.stopping = true;
    this.wakeup.close();
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
        this.log('token 有效至 ' + new Date(current.expiresAt).toLocaleString() + ',等待续期窗口');
        await wakeup.wait(Math.min(untilRefresh, config.maxSleepMs));
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
        this.logError('续期失败(' + e.code + '): ' + e.message + ', ' +
          (wait >= 60e3 ? Math.round(wait / 60e3) + ' 分钟' : Math.round(wait / 1000) + ' 秒') + '后重试');
      }
    }
  }
}

module.exports = { Scheduler };
