// test/aggregator.test.js — 非流式聚合(纯函数):delta 拼接、tool_calls 组装、
// 结果形态。与真实流量冒烟的分工见 smoke-real.js
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const { createAggregator } = require('../core/completion-aggregator');

function delta(d) { return { choices: [{ delta: d }] }; }

test('聚合: content 增量拼接,空内容时为 null', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ content: '你' }));
  agg.feed(delta({ content: '好' }));
  const out = agg.result();
  assert.strictEqual(out.choices[0].message.content, '你好');
  assert.strictEqual(out.choices[0].finish_reason, 'stop');
});

test('聚合: 无任何 feed 时 content 与未知 usage 均为 null', () => {
  const agg = createAggregator('M');
  const out = agg.result();
  assert.strictEqual(out.choices[0].message.content, null);
  assert.strictEqual(out.usage, null);
  assert.strictEqual(out.model, 'M');
});

test('聚合: reasoning_content 独立累积', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ reasoning_content: '思考' }));
  agg.feed(delta({ reasoning_content: '继续' }));
  agg.feed(delta({ content: '答案' }));
  const msg = agg.result().choices[0].message;
  assert.strictEqual(msg.reasoning_content, '思考继续');
  assert.strictEqual(msg.content, '答案');
});

test('聚合: 多个 tool_call 按 index 组装,arguments 跨帧拼接', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_', arguments: '{"q":' } }] }));
  agg.feed(delta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'put', arguments: '{}' } }] }));
  agg.feed(delta({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '1}' } }] }));
  agg.feed({ choices: [{ finish_reason: 'tool_calls', delta: {} }] });
  const out = agg.result();
  const msg = out.choices[0].message;
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(msg.tool_calls.length, 2);
  assert.strictEqual(msg.tool_calls[0].id, 'call_a');
  assert.strictEqual(msg.tool_calls[0].function.name, 'get_weather');
  assert.strictEqual(msg.tool_calls[0].function.arguments, '{"q":1}');
  assert.strictEqual(msg.tool_calls[1].function.name, 'put');
});

test('聚合: 缺 index 的 tool_call 归并到 0', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ tool_calls: [{ id: 'c1', function: { name: 'aa', arguments: '{}' } }] }));
  agg.feed(delta({ tool_calls: [{ function: { name: 'bb', arguments: '[]' } }] }));
  const tc = agg.result().choices[0].message.tool_calls;
  assert.strictEqual(tc.length, 1);
  assert.strictEqual(tc[0].function.name, 'aabb');
});

test('聚合: 缺 id/name 的 tool_call 保留给交付校验，不被其他完整调用掩盖', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }));
  agg.feed(delta({ tool_calls: [{ index: 1, id: 'call_x', function: { name: 'real', arguments: '{}' } }] }));
  const msg = agg.result().choices[0].message;
  assert.strictEqual(msg.tool_calls.length, 2);
  assert.strictEqual(msg.tool_calls[0].id, '');
  assert.strictEqual(msg.tool_calls[0].function.name, '');
  assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path":');
  assert.strictEqual(msg.tool_calls[1].id, 'call_x');
});

test('聚合: 错误字段类型不能经拼接或后续正常帧掩盖', () => {
  for (const bad of [
    { type: 'invalid-type' }, { id: 123 }, { function: [] },
    { function: { name: 123 } }, { function: { arguments: ['{}'] } }, null,
  ]) {
    const agg = createAggregator('M');
    agg.feed(delta({ tool_calls: [bad] }));
    agg.feed(delta({ tool_calls: [{ index: 0, id: 'call_x', type: 'function',
      function: { name: 'real', arguments: '{}' } }] }));
    assert.strictEqual(agg.invalidToolCalls, true, JSON.stringify(bad));
  }
});

test('聚合: 合法续帧的省略/null 字段不会被判为错误类型', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ tool_calls: [{ index: 0, id: 'call_x', type: 'function',
    function: { name: 'real', arguments: '{' } }] }));
  agg.feed(delta({ tool_calls: [{ index: 0, id: null, type: null,
    function: { name: null, arguments: '}' } }] }));
  assert.strictEqual(agg.invalidToolCalls, false);
  assert.strictEqual(agg.result().choices[0].message.tool_calls[0].function.arguments, '{}');
});

test('聚合: finish_reason/usage/id/model 从帧透传', () => {
  const agg = createAggregator('fallback-model');
  agg.feed({ id: 'up-1', created: 123, model: 'upstream-model', choices: [{ delta: { content: 'hi' }, finish_reason: null }] });
  agg.feed({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
  const out = agg.result();
  assert.strictEqual(out.id, 'up-1');
  assert.strictEqual(out.created, 123);
  assert.strictEqual(out.model, 'upstream-model');
  assert.strictEqual(out.choices[0].finish_reason, 'length');
  assert.deepStrictEqual(out.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('聚合: 上游 chunk 的 model 优先于构造默认', () => {
  const quiet = createAggregator('default-m');
  const out = quiet.result();
  assert.strictEqual(out.model, 'default-m');
});

test('聚合: 同一 index 更换 ID 时拒绝串接两个调用', () => {
  const agg = createAggregator('M');
  agg.feed(delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'run', arguments: '{"value":' } }] }));
  agg.feed(delta({ tool_calls: [{ index: 0, id: 'call_b', function: { arguments: '1}' } }] }));
  assert.strictEqual(agg.invalidToolCalls, true);
  assert.match(agg.invalidToolReason, /ID/);
  const call = agg.result().choices[0].message.tool_calls[0];
  assert.strictEqual(call.id, 'call_a');
  assert.strictEqual(call.function.arguments, '{"value":');
});
