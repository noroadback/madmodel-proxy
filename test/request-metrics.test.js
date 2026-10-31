'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { performanceNote, createProxyService } = require('../core/proxy-service');
const { startOutputTiming, recordOutput, completeOutputTiming, phaseNote } = require('../core/request-metrics');
const plain = { env: {}, isTTY: false };
const context = (patch = {}) => ({ outputTiming: { startedAt: 1000, firstAt: 2200,
  completedAt: 5000, ...patch } });
const note = (ctx, usage) => performanceNote(ctx, usage, plain);

test('阶段时间区分本地、上传、上游等待、思考与正文；ID 不接受控制符', () => {
  const ctx = { startedMonotonic: 1000, requestTiming: { readyAt: 1100, drainMs: 25 },
    promptCount: { elapsedMs: 80, queueMs: 20 } };
  startOutputTiming(ctx);
  recordOutput(ctx, { id: 'unsafe\nID', choices: [{ delta: { reasoning_content: '思考' } }] }, null, 1800);
  recordOutput(ctx, { id: 'chatcmpl-safe', choices: [{ delta: { content: '正文' } }] }, null, 2000);
  completeOutputTiming(ctx, { completedAt: 3000, timing: { startedAt: 1100,
    network: { bodySentMs: 100, headersMs: 600 } } });
  assert.equal(note(ctx, { completion_tokens: 60 }), ' | 首字 0.8s · 单次输出 50.0 tok/s');
  const result = phaseNote(ctx);
  assert.match(result, /本地=100ms 分词=80ms 分词排队=20ms 提交=200ms 待上游=500ms/);
  assert.match(result, /思考首段=800ms 正文首段=1000ms 生成=1200ms 背压=25ms/);
  assert.match(result, /上游id=chatcmpl-safe$/);
  assert.doesNotMatch(result, /unsafe/);
});

test('速度日志: 只用首字之后的原始耗时，思考不重复计数', () => {
  const ctx = context();
  const usage = { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 80 } };
  assert.equal(note(ctx, usage), ' | 首字 1.2s · 单次输出 35.7 tok/s');
  assert.equal(note(context({ startedAt: 0, firstAt: 9300, completedAt: 10900 }),
    { completion_tokens: 117 }), ' | 首字 9.3s · 单次输出 73.1 tok/s');
  const unrounded = context({ startedAt: 0, firstAt: 9349, completedAt: 10949 });
  assert.equal(note(unrounded, { completion_tokens: 117 }), ' | 首字 9.3s · 单次输出 73.1 tok/s',
    '显示秒数先四舍五入再相减会得到1.7s，计算必须使用原始时间');
});

test('速度日志: 缺少首字观察点不估算速度', () => {
  assert.equal(note({}, { completion_tokens: 100 }), ' | 首字 — · 单次输出 —');
});

test('速度日志: 非数字时间不能被减法隐式转换成有效统计', () => {
  for (const invalid of [undefined, null, false, '2200', NaN, Infinity]) {
    for (const field of ['startedAt', 'firstAt']) {
      assert.equal(note(context({ [field]: invalid }), { completion_tokens: 100 }),
        ' | 首字 — · 单次输出 —');
    }
    assert.equal(note(context({ completedAt: invalid }), { completion_tokens: 100 }),
      ' | 首字 1.2s · 单次输出 —');
  }
});

test('速度日志: 缺失或非法用量不按字符估算速度', () => {
  for (const usage of [undefined, {}, { completion_tokens: null }, { completion_tokens: '100' },
    { completion_tokens: NaN }, { completion_tokens: -1 }, { completion_tokens: Infinity }]) {
    assert.equal(note(context(), usage), ' | 首字 1.2s · 单次输出 —');
  }
});

test('速度日志: 零输出显示0，零时长或无效区间不做除法', () => {
  assert.equal(note(context(), { completion_tokens: 0 }), ' | 首字 1.2s · 单次输出 0.0 tok/s');
  assert.equal(note(context({ completedAt: 2200 }), { completion_tokens: 100 }),
    ' | 首字 1.2s · 单次输出 —（时长为0）');
  for (const completedAt of [0, NaN, Infinity]) {
    assert.equal(note(context({ completedAt }), { completion_tokens: 100 }), ' | 首字 1.2s · 单次输出 —');
  }
  assert.equal(note(context({ firstAt: 999 }), { completion_tokens: 100 }), ' | 首字 — · 单次输出 —');
});

test('速度日志: 总耗时和首字都显示4.5s仍用原始正间隔计算', () => {
  const ctx = context({ startedAt: 0, firstAt: 4460, completedAt: 4470 });
  assert.equal(note(ctx, { completion_tokens: 60, reasoning_tokens: 1 }),
    ' | 首字 4.5s · 单次输出 6000.0 tok/s');
  for (const [elapsedMs, rate] of [[100, '600.0'], [50, '1200.0'], [5, '12000.0'], [0.5, '120000.0']]) {
    assert.equal(note(context({ startedAt: 0, firstAt: 4460, completedAt: 4460 + elapsedMs }),
      { completion_tokens: 60 }), ` | 首字 4.5s · 单次输出 ${rate} tok/s`);
  }
});

test('速度日志: 思考用量不屏蔽可观察输出的近似速度，也不重复相加', () => {
  const ctx = context();
  for (const count of [0, 1, 80]) {
    for (const details of [{ reasoning_tokens: count }, { completion_tokens_details: { reasoning_tokens: count } }]) {
      assert.equal(note(ctx, { completion_tokens: 100, ...details }), ' | 首字 1.2s · 单次输出 35.7 tok/s');
    }
  }
});

test('首字识别: 忽略角色、空字段、用量、心跳及工具id', () => {
  const ctx = { startedMonotonic: 1000 };
  startOutputTiming(ctx);
  for (const obj of [{}, { usage: { completion_tokens: 100 } }, { choices: [] },
    { choices: [{ delta: { role: 'assistant', content: '', reasoning: '', reasoning_content: '',
      tool_calls: [{ id: 'call_1', function: { name: '', arguments: '' } }] } }] }]) {
    recordOutput(ctx, obj, null, 1500);
  }
  assert.equal(ctx.outputTiming.firstAt, undefined);
  recordOutput(ctx, { choices: [{ delta: { content: '正文' } }] }, null, 2200);
  recordOutput(ctx, { choices: [{ delta: { content: '更多正文' } }] }, null, 4500);
  completeOutputTiming(ctx, { type: 'stream', completedAt: 5000 });
  assert.equal(note(ctx, { completion_tokens: 100 }), ' | 首字 1.2s · 单次输出 35.7 tok/s');
});

test('首字识别: 思考方言、工具名和工具参数都属于有效输出', () => {
  for (const [delta, field] of [
    [{ reasoning: '思考' }, null], [{ reasoning_content: '思考' }, null],
    [{ custom_thinking: '思考' }, 'custom_thinking'],
    [{ tool_calls: [{ function: { name: 'Read' } }] }, null],
    [{ tool_calls: [{ function: { arguments: '{' } }] }, null],
  ]) {
    const ctx = { startedMonotonic: 1000 };
    startOutputTiming(ctx);
    recordOutput(ctx, { choices: [{ delta }] }, field, 2200);
    recordOutput(ctx, { choices: [{ delta }] }, field, 4500);
    assert.equal(ctx.outputTiming.firstAt, 2200);
  }
});

test('计时: 重试保留请求起点，清理前一尝试；日志延迟和墙钟跳变不影响统计', t => {
  const ctx = { started: 1700000000000, startedMonotonic: 1000 };
  startOutputTiming(ctx);
  recordOutput(ctx, { choices: [{ delta: { content: '失败尝试' } }] }, null, 1200);
  startOutputTiming(ctx);
  assert.equal(ctx.outputTiming.firstAt, undefined);
  recordOutput(ctx, { choices: [{ delta: { content: '成功' } }] }, null, 2200);
  recordOutput(ctx, { choices: [{ delta: { content: '完成' } }] }, null, 4500);
  completeOutputTiming(ctx, { type: 'stream', completedAt: 5000 });
  t.mock.method(Date, 'now', () => -100000000);
  assert.equal(note(ctx, { completion_tokens: 100 }), ' | 首字 1.2s · 单次输出 35.7 tok/s');
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
