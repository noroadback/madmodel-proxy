// Qwen 请求内容保持原样；通过本地 HTTP 出口验证，不访问外部服务。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const baseConfig = require('../config');
const { createUpstreamClient } = require('../core/upstream-client');

test('Qwen 请求出口透传', async t => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    seen.push(Buffer.concat(parts).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  t.after(() => new Promise(resolve => { mock.close(resolve); mock.closeAllConnections(); }));
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const upstream = createUpstreamClient({
    ...baseConfig,
    upstream: `http://127.0.0.1:${mock.address().port}/v1/chat/completions`,
    tunnelMode: false,
  });
  const send = async payload => {
    const result = await upstream.request({ payload, token: 'local-test-token' });
    assert.equal(result.type, 'completion');
    assert.equal(result.body.choices[0].message.content, 'ok');
    return JSON.parse(seen.at(-1));
  };
  const request = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hello' }], stream: true };

  await t.test('未提供 cache_salt 时不注入', async () => {
    assert.deepEqual(await send(request), request);
  });

  await t.test('客户端固定 cache_salt 原样透传', async () => {
    const payload = { ...request, stream: false, cache_salt: 'fixed-client-salt' };
    assert.deepEqual(await send(payload), payload);
  });

  await t.test('重复发送同一 payload 保持内容不变且不泄漏内部字段', async () => {
    const payload = Object.freeze({
      ...request, __diagnostic: 'local-only', cache_salt: 'fixed-client-salt',
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      tool_choice: 'auto', max_tokens: 32000, reasoning_effort: 'xhigh', temperature: 0.6,
    });
    const before = JSON.stringify(payload);
    const { __diagnostic, ...expected } = payload;
    const first = await send(payload);
    const second = await send(payload);
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.equal(seen.at(-1), seen.at(-2));
    assert.equal(JSON.stringify(payload), before);
  });
});
