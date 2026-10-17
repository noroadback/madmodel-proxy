'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { performanceNote } = require('../core/proxy-service');

test('速度日志: 均速包含首字等待，思考不重复计数', () => {
  const ctx = { started: 1000, firstOutputAt: 2200 };
  const usage = { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 80 } };
  assert.equal(performanceNote(ctx, usage, 5000), ' | 首字 1.2s · 均速 25.0 tok/s');
});

test('速度日志: JSON 应答只有均速，不伪造首字时间', () => {
  assert.equal(performanceNote({ started: 1000 }, { completion_tokens: 100 }, 5000), ' | 均速 25.0 tok/s');
});

test('速度日志: 缺失或非法用量不按字符估算速度', () => {
  for (const usage of [undefined, {}, { completion_tokens: null }, { completion_tokens: '100' },
    { completion_tokens: NaN }, { completion_tokens: -1 }, { completion_tokens: Infinity }]) {
    assert.equal(performanceNote({ started: 1000 }, usage, 5000), '');
  }
});

test('速度日志: 零输出或无效耗时不显示速度', () => {
  assert.equal(performanceNote({ started: 1000 }, { completion_tokens: 0 }, 5000), '');
  for (const now of [1000, 0, NaN, Infinity]) {
    assert.equal(performanceNote({ started: 1000 }, { completion_tokens: 100 }, now), '');
  }
});
