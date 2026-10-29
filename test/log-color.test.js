'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { supportsColor, colorFirstOutput, childColorEnv } = require('../core/log-color');

test('日志颜色: 自动只在支持颜色的终端启用，重定向保持纯文本', () => {
  assert.equal(supportsColor({ env: {}, isTTY: true }), true);
  assert.equal(supportsColor({ env: {}, isTTY: false }), false);
  assert.equal(supportsColor({ env: {}, isTTY: undefined }), false);
  assert.equal(supportsColor({ env: { TERM: 'dumb' }, isTTY: true }), false);
  assert.equal(colorFirstOutput('首字 1.2s', 1200, { env: {}, isTTY: false }), '首字 1.2s');
});

test('日志颜色: NO_COLOR 与 FORCE_COLOR=0 禁色，显式强制可以作用于管道', () => {
  for (const force of ['', '1', '2', '3']) {
    assert.equal(supportsColor({ env: { FORCE_COLOR: force, TERM: 'dumb' }, isTTY: false }), true);
    assert.equal(supportsColor({ env: { FORCE_COLOR: force, NO_COLOR: '1' }, isTTY: true }), false);
  }
  assert.equal(supportsColor({ env: { FORCE_COLOR: '0', PROXY_LOG_COLOR: '1' }, isTTY: true }), false);
  assert.equal(supportsColor({ env: { NO_COLOR: '' }, isTTY: true }), true);
  assert.equal(supportsColor({ env: { FORCE_COLOR: 'invalid' }, isTTY: false }), false);
});

test('日志颜色: 首字颜色按未四舍五入的毫秒判断，边界为 5s 与 10s', () => {
  const options = { env: {}, isTTY: true };
  for (const [firstMs, code] of [[0, 32], [4999.99, 32], [5000, 33], [9999.99, 33], [10000, 31]]) {
    assert.equal(colorFirstOutput('首字 5.0s', firstMs, options), `\x1b[${code}m首字 5.0s\x1b[0m`);
  }
  for (const firstMs of [-1, NaN, Infinity, undefined]) {
    assert.equal(colorFirstOutput('首字 —', firstMs, options), '首字 —');
  }
});

test('日志颜色: dashboard 将终端选择传给管道子进程，且不修改原环境', () => {
  const env = { PATH: 'retained', PROXY_UPSTREAM: 'retained', proxy_log_color: '1' };
  const childEnv = childColorEnv({ env, isTTY: true });
  assert.deepEqual(childEnv, { PATH: 'retained', PROXY_UPSTREAM: 'retained', PROXY_LOG_COLOR: '1' });
  assert.deepEqual(env, { PATH: 'retained', PROXY_UPSTREAM: 'retained', proxy_log_color: '1' });
  assert.equal(supportsColor({ env: childEnv, isTTY: false }), true);
  assert.equal(childColorEnv({ env: {}, isTTY: false }).PROXY_LOG_COLOR, '0');
  assert.equal(childColorEnv({ env: {}, isTTY: true }).PROXY_LOG_COLOR, '1');
});

test('日志颜色: 内部传递开关服从显式禁色，并兼容 Windows 环境变量大小写', () => {
  assert.equal(supportsColor({ env: { PROXY_LOG_COLOR: '0' }, isTTY: true }), false);
  assert.equal(supportsColor({ env: { PROXY_LOG_COLOR: '1', NO_COLOR: 'yes' }, isTTY: false }), false);
  assert.equal(supportsColor({ env: { force_color: '0', proxy_log_color: '1' }, isTTY: true }), false);
  assert.equal(supportsColor({ env: { force_color: '1' }, isTTY: false }), true);
  assert.equal(supportsColor({ env: { no_color: 'yes' }, isTTY: true }), false);
  assert.equal(supportsColor({ env: { term: 'dumb' }, isTTY: true }), false);
  const childEnv = childColorEnv({ env: { FORCE_COLOR: '3', NO_COLOR: '1' }, isTTY: true });
  assert.equal(childEnv.FORCE_COLOR, '3');
  assert.equal(childEnv.PROXY_LOG_COLOR, '0');
  assert.equal(supportsColor({ env: childEnv, isTTY: false }), false);
});
