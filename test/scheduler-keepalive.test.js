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

test("verdict 'invalid' + 重签抛 TWO_FACTOR_REQUIRED:上抛交给上层处理", async () => {
  const { s } = makeScheduler({
    verdict: 'invalid',
    refreshErr: Object.assign(new Error('mfa'), { code: 'TWO_FACTOR_REQUIRED' }),
  });
  await assert.rejects(() => s.runKeepaliveIfDue(), (e) => e.code === 'TWO_FACTOR_REQUIRED');
});