// test/scheduler-keepalive.test.js — Scheduler 保活状态机(runKeepaliveIfDue)。
// 构造已注入可控制的 now()/probe()/refresh()/log*,离线覆盖三态 verdict 的
// 完整路由:ok 维持周期、network/探活异常 90s 重探、invalid 触发重签与
// 90s 复核、重签失败 5 分钟重试、TWO_FACTOR_REQUIRED 上抛。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Scheduler } = require('../core/scheduler');

const DUE_ANYWAY = 0;            // enableKeepalive 把时钟归零,首次调用必到期
const INTERVAL_MS = 25 * 60e3;   // 与 config 默认一致
const RETRY_90S = 90e3;
const RETRY_5M = 5 * 60e3;

// 用可控时钟 + 探针构建调度器,只测保活状态机,不触碰 run()
function makeScheduler({ verdict, refreshOk = true, refreshErr = null }) {
  let t = 0;
  const probeCalls = [];
  const s = new Scheduler({
    config: { keepAliveIntervalMs: INTERVAL_MS },
    readToken: () => null,
    hasCredentials: () => false,
    refresh: async () => {
      if (refreshErr) throw refreshErr;
      return { ok: refreshOk };
    },
    wakeup: { close() {}, reset() {}, wait() {} },
    log() {},
    logError() {},
    now: () => t,
  });
  s.probe = async () => {
    probeCalls.push(t);
    if (typeof verdict === 'function') return verdict();
    if (verdict === 'throw') throw new Error('probe boom');
    return verdict;
  };
  s.enableKeepalive(s.probe);
  return { s, probeCalls, advance: ms => { t += ms; } };
}

test('未启用保活:runKeepaliveIfDue 不作为', async () => {
  const s = new Scheduler({
    config: { keepAliveIntervalMs: INTERVAL_MS },
    readToken: () => null,
    hasCredentials: () => false,
    refresh: async () => ({}),
    wakeup: { close() {} },
    now: () => 0,
  });
  assert.strictEqual(await s.runKeepaliveIfDue(), false);
});

test('未到期:不触发探活', async () => {
  const { s, probeCalls } = makeScheduler({ verdict: 'ok' });
  s.nextKeepaliveAt = 10_000;   // 当前 t=0,未到期
  assert.strictEqual(await s.runKeepaliveIfDue(), false);
  assert.strictEqual(probeCalls.length, 0);
});

test("verdict 'ok':维持周期,下个探活点 = now + keepAliveIntervalMs", async () => {
  const { s, probeCalls, advance } = makeScheduler({ verdict: 'ok' });
  assert.strictEqual(await s.runKeepaliveIfDue(), true);
  assert.strictEqual(probeCalls.length, 1);
  assert.strictEqual(s.nextKeepaliveAt, DUE_ANYWAY + INTERVAL_MS);
  advance(INTERVAL_MS - 1);
  assert.strictEqual(await s.runKeepaliveIfDue(), false); // 未到期
  advance(1);
  assert.strictEqual(await s.runKeepaliveIfDue(), true);  // 到期再探
  assert.strictEqual(probeCalls.length, 2);
});

test("verdict 'network':不动凭据,90s 后重探(不等满整周期)", async () => {
  const { s, probeCalls } = makeScheduler({ verdict: 'network' });
  assert.strictEqual(await s.runKeepaliveIfDue(), true);
  assert.strictEqual(s.nextKeepaliveAt, DUE_ANYWAY + RETRY_90S);
  assert.strictEqual(probeCalls.length, 1);
});

test('探活抛异常:按 network 处理,90s 后重探', async () => {
  const { s } = makeScheduler({ verdict: 'throw' });
  assert.strictEqual(await s.runKeepaliveIfDue(), true);
  assert.strictEqual(s.nextKeepaliveAt, DUE_ANYWAY + RETRY_90S);
});

test("verdict 'invalid' + 重签成功:立刻 refresh,90s 后复核新凭据", async () => {
  let refreshed = 0;
  const { s } = makeScheduler({ verdict: 'invalid', refreshOk: true });
  s.refresh = async () => { refreshed += 1; };
  assert.strictEqual(await s.runKeepaliveIfDue(), true);
  assert.strictEqual(refreshed, 1);
  assert.strictEqual(s.nextKeepaliveAt, DUE_ANYWAY + RETRY_90S);
});

test("verdict 'invalid' + 重签失败:记录错误,5 分钟后重试", async () => {
  const { s } = makeScheduler({
    verdict: 'invalid',
    refreshErr: Object.assign(new Error('boom'), { code: 'BAD_CREDENTIALS' }),
  });
  assert.strictEqual(await s.runKeepaliveIfDue(), true);
  assert.strictEqual(s.nextKeepaliveAt, DUE_ANYWAY + RETRY_5M);
});

test('重签连续 3 次 BAD_CREDENTIALS:与主循环同纪律上抛停止', async () => {
  const { s, advance } = makeScheduler({
    verdict: 'invalid',
    refreshErr: Object.assign(new Error('bad creds'), { code: 'BAD_CREDENTIALS' }),
  });
  await s.runKeepaliveIfDue();   // 第 1 次:5 分钟重试
  assert.strictEqual(s.keepaliveBadCreds, 1);
  advance(RETRY_5M);
  await s.runKeepaliveIfDue();   // 第 2 次
  assert.strictEqual(s.keepaliveBadCreds, 2);
  advance(RETRY_5M);
  await assert.rejects(          // 第 3 次:上抛,不再空打登录链
    () => s.runKeepaliveIfDue(),
    (e) => e.code === 'BAD_CREDENTIALS',
  );
});

test('非坏凭据的重签失败清零计数(与主循环 badCredsStreak 同语义)', async () => {
  let calls = 0;
  const { s, advance } = makeScheduler({ verdict: 'invalid' });
  s.refresh = async () => {
    calls += 1;
    if (calls % 2 === 1) throw Object.assign(new Error('bad'), { code: 'BAD_CREDENTIALS' });
    throw Object.assign(new Error('net'), { code: 'AUTH_BUSY' });
  };
  await s.runKeepaliveIfDue();   // BAD_CREDENTIALS → 1
  assert.strictEqual(s.keepaliveBadCreds, 1);
  advance(RETRY_5M);
  await s.runKeepaliveIfDue();   // AUTH_BUSY → 清零
  assert.strictEqual(s.keepaliveBadCreds, 0);
});

test('重签成功后计数清零', async () => {
  let calls = 0;
  const { s, advance } = makeScheduler({ verdict: 'invalid' });
  s.refresh = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('bad'), { code: 'BAD_CREDENTIALS' });
  };
  await s.runKeepaliveIfDue();   // 失败 → 1
  advance(RETRY_5M);
  await s.runKeepaliveIfDue();   // 成功 → 0
  assert.strictEqual(s.keepaliveBadCreds, 0);
});

test('pokeKeepalive:时钟拉回当前,未到期的探活立即执行(网络切换快速自愈)', async () => {
  const { s, probeCalls, advance } = makeScheduler({ verdict: 'ok' });
  await s.runKeepaliveIfDue();   // 首探,nextKeepaliveAt = +25min
  advance(60e3);                 // 1 分钟后
  assert.strictEqual(await s.runKeepaliveIfDue(), false); // 未到期不探
  s.pokeKeepalive();             // 代理报告隧道会话被拒
  assert.strictEqual(s.nextKeepaliveAt, 0);
  advance(1);
  assert.strictEqual(await s.runKeepaliveIfDue(), true);  // 立即探
  assert.strictEqual(probeCalls.length, 2);
});

test('pokeKeepalive:未启用保活时空操作', () => {
  const s = new Scheduler({
    config: { keepAliveIntervalMs: INTERVAL_MS },
    readToken: () => null,
    hasCredentials: () => false,
    refresh: async () => ({}),
    wakeup: { close() {} },
    now: () => 12345,
  });
  s.pokeKeepalive();
  assert.strictEqual(s.nextKeepaliveAt, 0); // 保持构造初值,未被改动
});

test("verdict 'invalid' + 重签抛 TWO_FACTOR_REQUIRED:上抛交给上层处理", async () => {
  const { s } = makeScheduler({
    verdict: 'invalid',
    refreshErr: Object.assign(new Error('mfa'), { code: 'TWO_FACTOR_REQUIRED' }),
  });
  await assert.rejects(() => s.runKeepaliveIfDue(), (e) => e.code === 'TWO_FACTOR_REQUIRED');
});
