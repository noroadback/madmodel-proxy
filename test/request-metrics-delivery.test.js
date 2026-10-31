'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyService } = require('../core/proxy-service');
const config = require('../config');

const usage = { prompt_tokens: 200, completion_tokens: 100,
  completion_tokens_details: { reasoning_tokens: 80 } };
const tool = { type: 'function', function: { name: 'report_result',
  parameters: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } } };
const delta = (value, at) => ({ at, chunk: { choices: [{ index: 0, delta: value, finish_reason: null }] } });
const toolEvents = () => [
  delta({ role: 'assistant', content: '' }, 1500),
  delta({ reasoning_content: '确认结果', tool_calls: [{ index: 0, id: 'call_result', type: 'function',
    function: { name: 'report_result', arguments: '{"answer":' } }] }, 2200),
  delta({ tool_calls: [{ index: 0, function: { arguments: '42}' } }] }, 4500),
  { at: 4800, chunk: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage } },
];

function context(body, onWrite) {
  let headers = false;
  const out = { chunks: [], lines: [] };
  return {
    out, rawBody: Buffer.from(JSON.stringify({ model: 'DeepSeek-V4.1-Flash',
      messages: [{ role: 'user', content: '报告结果' }], max_tokens: 200, ...body })),
    req: { method: 'POST', url: '/v1/chat/completions' }, size: 1,
    started: Date.now(), startedMonotonic: 1000,
    abortController: new AbortController(), clientGone: () => false,
    headersSent: () => headers, sseHeadersSent: () => headers, sseBytes: () => 0,
    setExtraHeaders() {}, setThinkingFields() {}, dumpFailed() {},
    ensureSseHeaders() { headers = true; },
    async writeSseChunk(chunk) {
      headers = true;
      if (onWrite) await onWrite(chunk);
      out.chunks.push(chunk);
    },
    async writeSseLine(line) { headers = true; out.lines.push(line); },
    endResponse() { out.ended = true; },
    sendJson(status, value) { headers = true; Object.assign(out, { status, body: value }); },
    sendError(status, message, type, extra, code) {
      headers = true; Object.assign(out, { status, message, type, extra, code });
    },
    sendStreamError(message, type, code) { Object.assign(out, { streamError: { message, type, code } }); },
  };
}

async function run(t, { body = { stream: true }, events = toolEvents(), response,
  onUpstreamEnd, onWrite, toolStreamMode = 'incremental' } = {}) {
  const logs = [], seen = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ').replace(/\u001b\[[0-9;]*m/g, '')));
  const ctx = context(body, onWrite);
  const service = createProxyService({
    config: { ...config, debugBudget: false, toolStreamMode,
      streamTotalTimeout: 5000, nonstreamTotalTimeout: 5000 },
    tokenState: () => ({ ok: true, token: 'synthetic-token', msLeft: 3600000 }),
    upstreamClient: { request: async args => {
      seen.push(args.payload);
      assert.equal(seen.length, 1, '成功响应不重试');
      for (const event of events) await args.onChunk(event.chunk, { receivedAt: event.at });
      if (onUpstreamEnd) onUpstreamEnd(ctx);
      return response || { type: 'stream', usage, completedAt: 5000 };
    } },
  });
  await service.handleRequest(ctx);
  assert.equal(ctx.out.message, undefined);
  assert.equal(ctx.out.streamError, undefined);
  assert.equal(logs.length, 1);
  return { ctx, seen, log: logs[0] };
}

const hasTool = chunk => chunk.choices?.some(choice => choice.delta?.tool_calls?.length);

test('服务日志: 实时原生工具按上游首字到DONE计算速度，思考token不重复相加', async t => {
  let forwardedBeforeDone = false;
  const { ctx, log } = await run(t, { body: { stream: true, tools: [tool] },
    onUpstreamEnd(ctx) {
      forwardedBeforeDone = ctx.out.chunks.some(hasTool);
      assert.ok(ctx.out.chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content));
      assert.ok(ctx.out.chunks.every(chunk => !chunk.choices?.[0]?.finish_reason && !chunk.usage),
        '工具成功收尾和用量仍需等上游完成');
    } });
  assert.equal(forwardedBeforeDone, true, '工具参数实时交付');
  assert.ok(ctx.out.lines.includes('data: [DONE]\n\n'));
  assert.match(log, /token 200\/100\(思考 80\) 累计 200\/100/);
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

test('服务日志: buffered工具按上游观察区间计算，交付缓冲不屏蔽速度', async t => {
  const { ctx, log } = await run(t, { toolStreamMode: 'buffered', body: { stream: true, tools: [tool] },
    onUpstreamEnd(ctx) {
      assert.equal(ctx.out.chunks.some(hasTool), false, '上游完成前工具帧留在缓冲');
      assert.ok(ctx.out.chunks.some(chunk => chunk.choices?.[0]?.delta?.reasoning_content),
        '同帧思考仍先交付');
    } });
  assert.equal(ctx.out.chunks.some(hasTool), true, '校验完成后交付工具');
  assert.ok(ctx.out.lines.includes('data: [DONE]\n\n'));
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

test('服务日志: 非流式聚合使用观察到的上游输出时间与实际用量', async t => {
  const { ctx, log } = await run(t, { body: { stream: false, tools: [tool] },
    onUpstreamEnd(ctx) { assert.deepEqual(ctx.out.chunks, []); assert.equal(ctx.out.body, undefined); } });
  assert.equal(ctx.out.status, 200);
  assert.equal(ctx.out.body.choices[0].message.tool_calls[0].function.arguments, '{"answer":42}');
  assert.deepEqual(ctx.out.body.usage, usage);
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

test('服务日志: DONE之后的本地终帧冲刷延迟不计入输出速度', async t => {
  let upstreamEnded = false, delayed = false;
  const { ctx, log } = await run(t, { body: { stream: true, tools: [tool] },
    onUpstreamEnd() { upstreamEnded = true; },
    async onWrite(chunk) {
      if (chunk.choices?.[0]?.finish_reason || chunk.usage) {
        assert.equal(upstreamEnded, true);
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    } });
  assert.equal(delayed, true);
  assert.equal(ctx.out.ended, true);
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

test('服务日志: include_usage:false缺少token时首字可见，速度不按字符或帧数猜测', async t => {
  const events = [delta({ role: 'assistant' }, 1500), delta({ content: '结果' }, 2200),
    delta({ content: '完成' }, 4500),
    { at: 4800, chunk: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }];
  const { ctx, seen, log } = await run(t, { events,
    body: { stream: true, stream_options: { include_usage: false } },
    response: { type: 'stream', completedAt: 5000 } });
  assert.equal(seen[0].stream_options.include_usage, false);
  assert.equal(ctx.out.ended, true);
  assert.doesNotMatch(log, /token \d/);
  assert.match(log, /首字 1\.2s · 单次输出 — 阶段\[/);
});

test('服务日志: 有效输出短间隔不屏蔽速度，分母仍截止DONE', async t => {
  const { log } = await run(t, { events: [delta({ content: '大量正文' }, 2200),
    delta({ content: '最后一段' }, 2250),
    { at: 4800, chunk: { choices: [], usage: { prompt_tokens: 200, completion_tokens: 100 } } }],
    response: { type: 'stream', usage: { prompt_tokens: 200, completion_tokens: 100 }, completedAt: 5000 } });
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

test('服务日志: 未收到思考文本仍按约定公式显示可观察输出的近似速度', async t => {
  const { log } = await run(t, { events: [delta({ content: '结果' }, 2200),
    delta({ content: '完成' }, 4500), { at: 4800, chunk: { choices: [], usage } }] });
  assert.match(log, /token 200\/100\(思考 80\)/);
  assert.match(log, /首字 1\.2s · 单次输出 35\.7 tok\/s 阶段\[/);
});

for (const stream of [true, false]) {
  test(`服务日志: JSON整包响应缺少首字观察点，集中交付不显示速度，stream=${stream}`, async t => {
    const { ctx, log } = await run(t, { events: [], body: { stream }, response: {
      type: 'completion', completedAt: 5000, body: { model: 'DeepSeek-V4.1-Flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage },
    } });
    if (stream) assert.ok(ctx.out.lines.includes('data: [DONE]\n\n'));
    else assert.equal(ctx.out.status, 200);
    assert.match(log, /首字 — · 单次输出 — 阶段\[/);
  });
}
