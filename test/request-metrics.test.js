'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { performanceNote, createProxyService } = require('../core/proxy-service');

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

test('用量日志: 图片与缓存为输入明细，不重复计入累计，实际零值可见', () => {
  const { usageNote } = createProxyService({});
  assert.equal(usageNote({ prompt_tokens: 1000, completion_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 10 },
    prompt_tokens_details: { image_tokens: 184, cached_tokens: 768 } }),
  ' | token 1000/20(思考 10 · 图片 184 · 缓存 768) 累计 1000/20');
  assert.equal(usageNote({ prompt_tokens: 0, completion_tokens: 0,
    prompt_tokens_details: { image_tokens: 0, cached_tokens: 0 } }),
  ' | token 0/0(图片 0 · 缓存 0) 累计 1000/20');
  assert.equal(usageNote({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: null }),
    ' | token 1/1 累计 1001/21');
});

test('用量日志: 缺失或无效明细不补零，非法总量不污染累计', () => {
  const { usageNote } = createProxyService({});
  for (const bad of [null, undefined, NaN, Infinity, -1, '0']) {
    assert.equal(usageNote({ prompt_tokens: bad, completion_tokens: 1 }), '');
    assert.equal(usageNote({ prompt_tokens: 1, completion_tokens: bad }), '');
    assert.equal(usageNote({ prompt_tokens: 0, completion_tokens: 0,
      reasoning_tokens: bad, prompt_tokens_details: { image_tokens: bad, cached_tokens: bad } }),
    ' | token 0/0 累计 0/0');
  }
  assert.equal(usageNote(null), '');
  assert.equal(usageNote({ prompt_tokens: 2, completion_tokens: 3 }), ' | token 2/3 累计 2/3');
});
