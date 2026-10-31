'use strict';
require('../scripts/isolated-env').isolate();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PromptCounter } = require('../core/prompt-counter');
const { getTokenizer, preparePrompt } = require('../core/tokenizer');
const payload = text => ({ messages: [{ role: 'user', content: text }] });
const large = payload('hello 世界 123 '.repeat(800));
function counter(t, opts) { const c = new PromptCounter(opts); t.after(() => c.close()); return c; }
const stallPath = path.join(process.env.MADMODEL_STATE_DIR, 'stall.cjs');
fs.writeFileSync(stallPath, "require('worker_threads').parentPort.on('message', () => {});");

test('worker 与同步分词在文本、思考、工具历史和图片混合输入上保持一致', async t => {
  const c = counter(t, { timeoutMs: 20000 });
  const cases = [payload('hi'), large, { ...large, tools: [{ type: 'function', function: {
    name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    messages: [...large.messages,
      { role: 'assistant', reasoning_content: '分析', reasoning: '不重复计数', content: null,
        tool_calls: [{ function: { name: 'read', arguments: '{"path":"hello"}' } }] },
      { role: 'tool', content: [{ type: 'text', text: '结果' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,not-text' } }] }] }];
  for (const body of cases) {
    const expected = getTokenizer().countPromptTokens(body);
    const result = await c.count(body);
    assert.equal(result.exact, true);
    assert.equal(result.tokens, expected);
    const work = preparePrompt(body);
    assert.equal(work.parts.reduce((n, p) => n + getTokenizer().countText(p), work.overhead), expected);
    assert.ok(!JSON.stringify(work).includes('data:image'));
  }
});

test('巨型连续片段有界失败；事件循环继续响应，后续任务可恢复', async t => {
  const c = counter(t, { timeoutMs: 20000 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await c.count(payload('中'.repeat(2 * 1024 * 1024)));
    assert.equal(result.exact, false);
    assert.equal(result.reason, 'piece-limit');
    assert.ok(ticks > 0, '大输入计算期间主线程必须继续处理事件');
    assert.equal((await c.count(large)).exact, true);
  } finally { clearInterval(timer); }
});

test('计算超时和无法创建 worker 均释放资源，恢复有效 worker 后可重试', async t => {
  const c = counter(t, { workerPath: stallPath, timeoutMs: 100 });
  assert.equal((await c.count(large)).reason, 'worker-timeout');
  await c.closing;
  c.workerPath = 'not-an-absolute-worker-path';
  assert.equal((await c.count(large)).reason, 'worker-error');
  assert.equal(c.chars, 0);
  assert.equal(c.active, null);
  c.workerPath = require.resolve('../core/tokenizer-worker');
  c.timeoutMs = 20000;
  assert.equal((await c.count(large)).exact, true);
});

test('活动任务和排队任务取消；队列数量及字符额度可重用', async t => {
  const c = counter(t, { workerPath: stallPath, timeoutMs: 20000, maxQueue: 1 });
  const a = new AbortController(), b = new AbortController();
  const first = c.count(large, { signal: a.signal });
  const second = c.count(large, { signal: b.signal });
  assert.equal((await c.count(large)).reason, 'queue-limit');
  b.abort();
  assert.equal((await second).reason, 'cancelled');
  a.abort();
  assert.equal((await first).reason, 'cancelled');
  assert.equal(c.chars, 0);
  await c.closing;
  c.workerPath = require.resolve('../core/tokenizer-worker');
  assert.equal((await c.count(large)).exact, true);
});

test('队列等待及输入上限不产生伪造 token 数，也不干扰活动任务', async t => {
  const c = counter(t, { workerPath: stallPath, timeoutMs: 20000, queueTimeoutMs: 50 });
  const a = new AbortController();
  const active = c.count(large, { signal: a.signal });
  const expired = await c.count(large);
  assert.equal(expired.reason, 'queue-timeout');
  assert.equal(expired.tokens, undefined);
  assert.ok(c.active);
  a.abort();
  await active;
  assert.equal((await c.count(payload('x'.repeat(8 * 1024 * 1024 + 1)))).reason, 'text-limit');
  assert.equal((await c.count({ messages: Array(10001).fill({}) })).reason, 'text-limit');
  const bounded = counter(t, { maxQueuedChars: 5000 });
  assert.equal((await bounded.count(large)).reason, 'queue-limit');
  assert.equal(c.chars, 0);
});
