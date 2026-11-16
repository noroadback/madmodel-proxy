// test/protocol-bridge.test.js — 协议翻译(Anthropic Messages / OpenAI Responses
// <-> chat completions)纯逻辑与 ctx 包装。真实流量冒烟见 smoke-real.js。
'use strict';

require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');
const {
  detectProtocol, toChatPayload, chatToAnthropic, chatToResponses, errorBody,
  createAnthropicStream, createResponsesStream, wrapContext,
} = require('../core/protocol-bridge');

const MODEL = 'DeepSeek-V4.1-Flash';

// ---------------------------------------------------------------- 路由识别
test('detectProtocol: 三种 POST 端点与未知路径', () => {
  assert.strictEqual(detectProtocol('/v1/chat/completions'), 'chat');
  assert.strictEqual(detectProtocol('/chat/completions'), 'chat');
  assert.strictEqual(detectProtocol('/v1/messages'), 'anthropic');
  assert.strictEqual(detectProtocol('/v1/responses'), 'responses');
  assert.strictEqual(detectProtocol('/v1/embeddings'), null);
  assert.strictEqual(detectProtocol('/v1/messages/count_tokens'), null);
  assert.strictEqual(detectProtocol('/v1/models'), null);
});

// ---------------------------------------------------------------- 请求翻译
test('toChatPayload: Anthropic system + text + tools', () => {
  const body = {
    model: MODEL, max_tokens: 4096, stream: true, temperature: 0.3,
    system: '你是助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }],
    stop_sequences: ['STOP'],
  };
  const p = toChatPayload(body, 'anthropic', 'fallback');
  assert.strictEqual(p.model, MODEL);
  assert.strictEqual(p.stream, true);
  assert.strictEqual(p.max_tokens, 4096);
  assert.strictEqual(p.temperature, 0.3);
  assert.deepStrictEqual(p.stop, ['STOP']);
  assert.deepStrictEqual(p.messages[0], { role: 'system', content: '你是助手' });
  assert.deepStrictEqual(p.messages[1], { role: 'user', content: '你好' });
  assert.strictEqual(p.tools[0].type, 'function');
  assert.strictEqual(p.tools[0].function.name, 'Bash');
  assert.deepStrictEqual(p.tools[0].function.parameters, { type: 'object', properties: {} });
});

test('toChatPayload: Anthropic tool_use / tool_result 往返成 chat tool_calls', () => {
  const body = {
    model: MODEL, max_tokens: 1024,
    messages: [
      { role: 'assistant', content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/tmp/a' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
      ] },
    ],
  };
  const p = toChatPayload(body, 'anthropic', 'fallback');
  assert.strictEqual(p.messages[0].content, '我查一下');
  assert.deepStrictEqual(p.messages[0].tool_calls, [{
    id: 'toolu_1', type: 'function',
    function: { name: 'Read', arguments: '{"path":"/tmp/a"}' },
  }]);
  assert.deepStrictEqual(p.messages[1], {
    role: 'tool', tool_call_id: 'toolu_1', content: 'file body',
  });
});

test('toChatPayload: Anthropic tool_choice 映射', () => {
  assert.strictEqual(toChatPayload({ tools: [], tool_choice: { type: 'any' } }, 'anthropic', MODEL).tool_choice, 'required');
  assert.deepStrictEqual(
    toChatPayload({ tools: [], tool_choice: { type: 'tool', name: 'Read' } }, 'anthropic', MODEL).tool_choice,
    { type: 'function', function: { name: 'Read' } });
});

test('toChatPayload: Responses instructions + input 字符串', () => {
  const p = toChatPayload({ model: MODEL, instructions: 'system', input: 'ping',
    max_output_tokens: 2048, stream: false }, 'responses', 'fallback');
  assert.deepStrictEqual(p.messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'ping' },
  ]);
  assert.strictEqual(p.max_tokens, 2048);
  assert.strictEqual(p.stream, false);
});

test('toChatPayload: Responses function_call / function_call_output', () => {
  const body = {
    model: MODEL,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] },
      { type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_9', output: 'a.txt' },
    ],
    tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
  };
  const p = toChatPayload(body, 'responses', 'fallback');
  assert.deepStrictEqual(p.messages[0], { role: 'user', content: 'ls' });
  assert.deepStrictEqual(p.messages[1].tool_calls[0].function,
    { name: 'Bash', arguments: '{"cmd":"ls"}' });
  assert.deepStrictEqual(p.messages[2], { role: 'tool', tool_call_id: 'call_9', content: 'a.txt' });
  assert.strictEqual(p.tools[0].function.name, 'Bash');
});

test('toChatPayload: 缺 model 时回落到代理默认模型，不透传 thinking 等私有字段', () => {
  const p = toChatPayload({ messages: [], thinking: { type: 'enabled' } }, 'anthropic', MODEL);
  assert.strictEqual(p.model, MODEL);
  assert.strictEqual(p.thinking, undefined);
});

// ---------------------------------------------------------------- 非流式响应
function completion(extra = {}) {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...extra,
  };
}

test('chatToAnthropic: 文本 + usage + stop_reason', () => {
  const out = chatToAnthropic(completion(), { model: MODEL });
  assert.strictEqual(out.type, 'message');
  assert.strictEqual(out.role, 'assistant');
  assert.deepStrictEqual(out.content, [{ type: 'text', text: '答案' }]);
  assert.strictEqual(out.stop_reason, 'end_turn');
  assert.deepStrictEqual(out.usage, { input_tokens: 11, output_tokens: 7 });
});

test('chatToAnthropic: tool_calls -> tool_use 块 + stop_reason=tool_use', () => {
  const out = chatToAnthropic(completion({
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'Read', arguments: '{"path":"/a"}' } }] } }],
  }), { model: MODEL });
  assert.strictEqual(out.stop_reason, 'tool_use');
  assert.deepStrictEqual(out.content[0], {
    type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/a' },
  });
});

test('chatToResponses: 文本 + output_text + usage + function_call item', () => {
  const out = chatToResponses(completion({
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '好的',
      tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{}' } }] } }],
  }), { model: MODEL });
  assert.strictEqual(out.object, 'response');
  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.output_text, '好的');
  assert.strictEqual(out.output[0].content[0].type, 'output_text');
  assert.strictEqual(out.output[1].type, 'function_call');
  assert.strictEqual(out.output[1].call_id, 'call_1');
  assert.deepStrictEqual(out.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
});

test('errorBody: Anthropic 错误形态与状态码映射', () => {
  const e = errorBody('anthropic', 401, 'key 无效');
  assert.strictEqual(e.type, 'error');
  assert.strictEqual(e.error.type, 'authentication_error');
  assert.strictEqual(e.error.message, 'key 无效');
  assert.strictEqual(errorBody('responses', 429, '限流').error.code, 429);
});

// ---------------------------------------------------------------- 流式状态机
const chatDelta = d => ({ choices: [{ index: 0, delta: d, finish_reason: null }] });

test('Anthropic 流: message_start -> text_delta -> message_stop', () => {
  const tr = createAnthropicStream({ model: MODEL });
  const events = [
    ...tr.start(),
    ...tr.chunk(chatDelta({ content: '你' })),
    ...tr.chunk(chatDelta({ content: '好' })),
    ...tr.chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ...tr.chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    ...tr.finish(),
  ];
  assert.deepStrictEqual(events.map(e => e.event), [
    'message_start', 'content_block_start', 'ping',
    'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.strictEqual(events[3].data.delta.text, '你');
  assert.strictEqual(events[6].data.delta.stop_reason, 'end_turn');
  assert.strictEqual(events[6].data.usage.output_tokens, 2);
  assert.deepStrictEqual(tr.finish(), []); // 幂等，不会重复收尾
});

test('Anthropic 流: tool_call 分片 -> tool_use 块 + input_json_delta', () => {
  const tr = createAnthropicStream({ model: MODEL });
  const events = [
    ...tr.start(),
    ...tr.chunk(chatDelta({ tool_calls: [{ index: 0, id: 'call_1',
      function: { name: 'Bash', arguments: '{"cmd":' } }] })),
    ...tr.chunk(chatDelta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] })),
    ...tr.chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ...tr.finish(),
  ];
  const start = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  assert.ok(start, '应产生 tool_use 块');
  assert.strictEqual(start.data.content_block.name, 'Bash');
  const parts = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta');
  assert.deepStrictEqual(parts.map(e => e.data.delta.partial_json), ['{"cmd":', '"ls"}']);
  assert.strictEqual(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('Responses 流: 事件序列与 output_text 累积', () => {
  const tr = createResponsesStream({ model: MODEL });
  const events = [
    ...tr.start(),
    ...tr.chunk(chatDelta({ content: 'A' })),
    ...tr.chunk(chatDelta({ content: 'B' })),
    ...tr.chunk({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
    ...tr.finish(),
  ];
  const names = events.map(e => e.event);
  assert.ok(names.includes('response.created'));
  assert.ok(names.includes('response.output_text.delta'));
  assert.ok(names.includes('response.content_part.done'));
  assert.strictEqual(names.at(-1), 'response.completed');
  const final = events.at(-1).data.response;
  assert.strictEqual(final.output_text, 'AB');
  assert.deepStrictEqual(final.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  assert.strictEqual(final.output[0].id,
    events.find(e => e.event === 'response.output_item.added').data.item.id);
});

test('Responses 流: function_call 事件与 arguments 拼接', () => {
  const tr = createResponsesStream({ model: MODEL });
  const events = [
    ...tr.start(),
    ...tr.chunk(chatDelta({ tool_calls: [{ index: 0, id: 'call_7',
      function: { name: 'Bash', arguments: '{"cmd":' } }] })),
    ...tr.chunk(chatDelta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] })),
    ...tr.finish(),
  ];
  assert.ok(events.some(e => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call'));
  assert.ok(events.some(e => e.event === 'response.function_call_arguments.delta'));
  const done = events.find(e => e.event === 'response.function_call_arguments.done');
  assert.strictEqual(done.data.arguments, '{"cmd":"ls"}');
  const final = events.at(-1).data.response;
  assert.strictEqual(final.output.at(-1).type, 'function_call');
});

// ---------------------------------------------------------------- ctx 适配层
function mockCtx() {
  const lines = [];
  const sent = [];
  let headers = false;
  const ctx = {
    req: { method: 'POST', url: '/v1/messages' }, res: {},
    rawBody: Buffer.from('{}'), size: 2, started: Date.now(),
    abortController: new AbortController(),
    clientGone: () => false,
    headersSent: () => headers,
    sseHeadersSent: () => headers,
    sseBytes: () => 0,
    ensureSseHeaders: () => { headers = true; },
    writeSseChunk: obj => ctx.writeSseLine(`data: ${JSON.stringify(obj)}\n\n`),
    writeSseLine: line => { lines.push(String(line)); },
    sendJson: (status, body) => { headers = true; sent.push({ status, body }); },
    sendError: (status, message) => { sent.push({ status, message }); },
    endResponse: () => {},
    dumpFailed: () => {},
    setExtraHeaders: () => {},
    setThinkingFields: () => {},
  };
  return { ctx, lines, sent };
}

test('wrapContext: 流式 chat 输出翻译成 Anthropic SSE 帧，[DONE] 触发收尾', () => {
  const original = { model: MODEL, max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'hi' }] };
  const chatRaw = Buffer.from(JSON.stringify(toChatPayload(original, 'anthropic', MODEL)));
  const { ctx, lines } = mockCtx();
  const wrapped = wrapContext(ctx, 'anthropic', original, chatRaw);

  assert.deepStrictEqual(JSON.parse(wrapped.rawBody.toString('utf8')).messages,
    [{ role: 'user', content: 'hi' }]);
  wrapped.writeSseChunk(chatDelta({ content: 'OK' }));
  wrapped.writeSseLine('data: [DONE]\n\n');

  const joined = lines.join('');
  assert.ok(joined.includes('event: message_start'));
  assert.ok(joined.includes('event: content_block_delta'));
  assert.ok(joined.includes('"text":"OK"'));
  assert.ok(joined.includes('event: message_stop'));
  assert.ok(!joined.includes('[DONE]'), '不应把 chat 的 [DONE] 透传给 Anthropic 客户端');
  assert.ok(!joined.includes('data: {"choices"'), '不应泄露 chat 原始帧');
});

test('wrapContext: 非流式 sendJson 转成 message / response 对象', () => {
  for (const [protocol, expected] of [['anthropic', 'message'], ['responses', 'response']]) {
    const original = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };
    const chatRaw = Buffer.from(JSON.stringify(toChatPayload(original, protocol, MODEL)));
    const { ctx, sent } = mockCtx();
    const wrapped = wrapContext(ctx, protocol, original, chatRaw);
    wrapped.sendJson(200, completion(), {});
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].body[expected === 'message' ? 'type' : 'object'] === expected);
  }
});

test('wrapContext: sendError 输出协议错误体；SSE 已开时发流式错误事件', () => {
  const original = { model: MODEL, messages: [] };
  const chatRaw = Buffer.from(JSON.stringify(toChatPayload(original, 'anthropic', MODEL)));
  const { ctx, sent } = mockCtx();
  const wrapped = wrapContext(ctx, 'anthropic', original, chatRaw);
  wrapped.sendError(429, '上游限流');
  assert.strictEqual(sent[0].status, 429);
  assert.strictEqual(sent[0].body.error.type, 'rate_limit_error');

  const second = mockCtx();
  const w2 = wrapContext(second.ctx, 'anthropic', original, chatRaw);
  w2.writeSseChunk(chatDelta({ content: 'x' }));
  w2.sendError(502, '上游中断');
  assert.ok(second.lines.join('').includes('event: error'));
  assert.strictEqual(second.sent.length, 0, '头已发出后不能再写 JSON 错误体');
});

test('wrapContext: usage 帧经 writeSseLine 也能进入状态机', () => {
  const original = { model: MODEL, messages: [], stream: true };
  const chatRaw = Buffer.from(JSON.stringify(toChatPayload(original, 'anthropic', MODEL)));
  const { ctx, lines } = mockCtx();
  const wrapped = wrapContext(ctx, 'anthropic', original, chatRaw);
  wrapped.writeSseLine(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`);
  wrapped.writeSseLine('data: [DONE]\n\n');
  const joined = lines.join('');
  assert.ok(joined.includes('"output_tokens":9'));
  assert.ok(joined.includes('event: message_stop'));
});
