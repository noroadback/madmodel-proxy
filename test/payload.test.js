// test/payload.test.js — 请求解析与归一化(纯函数)。
// 与真实流量冒烟的分工:这里只测纯逻辑边界,协议行为靠 smoke-real.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseJsonBody, normalizePayload } = require('../core/payload');

const MODEL = 'DeepSeek-V4-Flash-0731';

// ---- parseJsonBody ----
test('parseJsonBody: 合法 JSON 对象返回原对象', () => {
  const p = parseJsonBody(Buffer.from('{"a":1}'));
  assert.deepStrictEqual(p, { a: 1 });
});

test('parseJsonBody: 非 JSON 抛 INVALID_JSON', () => {
  assert.throws(() => parseJsonBody(Buffer.from('not json')), e => e.code === 'INVALID_JSON');
});

test('parseJsonBody: 数组/null/标量抛 INVALID_PAYLOAD', () => {
  for (const raw of ['[1,2]', 'null', '42', '"str"']) {
    assert.throws(() => parseJsonBody(Buffer.from(raw)), e => e.code === 'INVALID_PAYLOAD');
  }
});

// ---- normalizePayload: 模型名 ----
test('归一化: 任意 model 重写为注入模型并记录原值', () => {
  const p = { model: 'gpt-4o', messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.ok(applied.includes('model=gpt-4o'));
});

test('归一化: model 缺省时静默注入,不产生 model= 记录', () => {
  const p = { messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.ok(!applied.some(n => n.startsWith('model=')));
});

test('归一化: 已是目标模型时不产生任何 model 记录', () => {
  const p = { model: MODEL, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(applied.length, 0);
});

// ---- normalizePayload: 上游拒绝参数 ----
test('归一化: logprobs/top_logprobs 剥离并记录', () => {
  const p = { model: MODEL, logprobs: true, top_logprobs: 5, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.ok(!('logprobs' in p) && !('top_logprobs' in p));
  assert.ok(applied.includes('-logprobs') && applied.includes('-top_logprobs'));
});

test('归一化: n>1 剥离, n=1 保留', () => {
  const a = { model: MODEL, n: 3, messages: [] };
  normalizePayload(a, MODEL);
  assert.ok(!('n' in a));
  const b = { model: MODEL, n: 1, messages: [] };
  normalizePayload(b, MODEL);
  assert.strictEqual(b.n, 1);
});

// ---- normalizePayload: max_tokens 区间 [512, 65536] ----
test('max_tokens: 思考开启(默认)时 <512 抬到 512', () => {
  const p = { model: MODEL, max_tokens: 16, messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 512);
  assert.ok(applied.includes('max_tokens→512'));
});

test('max_tokens: 显式关闭思考的三种方言均不抬升', () => {
  for (const noThinking of [
    { reasoning_effort: 'none' },
    { thinking: false },
    { thinking: { type: 'disabled' } },
  ]) {
    const p = { model: MODEL, max_tokens: 16, messages: [], ...noThinking };
    const applied = normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, 16, JSON.stringify(noThinking));
    assert.ok(!applied.includes('max_tokens→512'), JSON.stringify(noThinking));
  }
});

test('max_tokens: >65536 压回 65536(思考开/关两态)', () => {
  for (const extra of [{}, { reasoning_effort: 'none' }]) {
    const p = { model: MODEL, max_tokens: 384000, messages: [], ...extra };
    const applied = normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, 65536);
    assert.ok(applied.includes('max_tokens→65536'));
  }
});

test('max_tokens: 缺省时不注入任何值', () => {
  const p = { model: MODEL, messages: [] };
  normalizePayload(p, MODEL);
  assert.ok(!('max_tokens' in p));
});

// ---- normalizePayload: max_completion_tokens(新版 OpenAI 客户端方言) ----
test('max_completion_tokens: 映射为 max_tokens 并接受区间约束(两方向)', () => {
  const big = { model: MODEL, max_completion_tokens: 384000, messages: [] };
  const appliedBig = normalizePayload(big, MODEL);
  assert.strictEqual(big.max_tokens, 65536);
  assert.ok(!('max_completion_tokens' in big));
  assert.ok(appliedBig.includes('max_completion_tokens→max_tokens') && appliedBig.includes('max_tokens→65536'));

  const small = { model: MODEL, max_completion_tokens: 16, messages: [] };
  normalizePayload(small, MODEL);
  assert.strictEqual(small.max_tokens, 512);
});

test('max_completion_tokens: 思考关闭时不抬升,原值映射', () => {
  const p = { model: MODEL, max_completion_tokens: 16, reasoning_effort: 'none', messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 16);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_completion_tokens: 两键并存时以新键为准', () => {
  const p = { model: MODEL, max_completion_tokens: 2000, max_tokens: 9000, messages: [] };
  normalizePayload(p, MODEL);
  assert.strictEqual(p.max_tokens, 2000);
  assert.ok(!('max_completion_tokens' in p));
});

test('max_tokens: 512-65536 区间内原样保留', () => {
  for (const mt of [512, 4096, 65536]) {
    const p = { model: MODEL, max_tokens: mt, messages: [] };
    normalizePayload(p, MODEL);
    assert.strictEqual(p.max_tokens, mt);
  }
});

// ---- normalizePayload: 关闭思考的方言映射 ----
test('思考方言: reasoning_effort=none → chat_template_kwargs.thinking=false 且原键剥离', () => {
  const p = { model: MODEL, reasoning_effort: 'none', messages: [] };
  const applied = normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
  assert.ok(!('reasoning_effort' in p));
  assert.ok(applied.includes('thinking=false') && applied.includes('-reasoning_effort'));
});

test('思考方言: 非关闭档(如 high)剥离但绝不注入', () => {
  const p = { model: MODEL, reasoning_effort: 'high', messages: [] };
  normalizePayload(p, MODEL);
  assert.ok(!('reasoning_effort' in p));
  assert.ok(!('chat_template_kwargs' in p));
});

test('思考方言: 已有 chat_template_kwargs 被合并保留', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: { custom: 1 }, messages: [] };
  normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { custom: 1, thinking: false });
});

test('思考方言: chat_template_kwargs 为数组时整体替换', () => {
  const p = { model: MODEL, thinking: false, chat_template_kwargs: [1, 2], messages: [] };
  normalizePayload(p, MODEL);
  assert.deepStrictEqual(p.chat_template_kwargs, { thinking: false });
});
