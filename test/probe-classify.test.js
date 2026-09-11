// test/probe-classify.test.js — classifyProbeStatus 纯函数:探活 HTTP 状态码 →
// verdict。隧道对未认证会话的固定形态是 3xx 跳登录页;2xx/4xx/5xx 都说明
// 请求已穿过隧道(会话有效)。网络层错误不在此函数范围(调用方归为 'network')。
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyProbeStatus } = require('../madmodel-auth');

test('2xx:会话有效', () => {
  assert.strictEqual(classifyProbeStatus(200), 'ok');
  assert.strictEqual(classifyProbeStatus(299), 'ok');
});

test('3xx:隧道把未认证会话跳去登录页,判为失效', () => {
  assert.strictEqual(classifyProbeStatus(300), 'invalid');
  assert.strictEqual(classifyProbeStatus(302), 'invalid'); // 实测隧道形态
  assert.strictEqual(classifyProbeStatus(399), 'invalid');
});

test('4xx/5xx:已穿过隧道到达应用,会话有效(失败在应用侧)', () => {
  assert.strictEqual(classifyProbeStatus(401), 'ok');
  assert.strictEqual(classifyProbeStatus(500), 'ok');
  assert.strictEqual(classifyProbeStatus(599), 'ok');
});
