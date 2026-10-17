// Qwen 缓存隔离:检查真实 HTTP 出口,包括同一 payload 重用与工具补救重发。
// 全程使用本地假上游,不读取凭据、不访问学校服务。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const baseConfig = require('../config');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');
const { createHttpServer, createTokenState } = require('../adapters/http-server');

const MODEL = 'qwen3.8-27b';
const TOOLS = [{ type: 'function', function: {
  name: 'get_weather', description: '查询天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
} }];
const HERMES = '<tool_call>\n<function=get_weather>\n<parameter=city>\n北京\n</parameter>\n</function>\n</tool_call>';
const frame = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end('data: [DONE]\n\n');
}
function completion(res, content) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const withoutSalt = payload => { const copy = { ...payload }; delete copy.cache_salt; return copy; };

test('Qwen 每次实际发往上游的请求使用独立缓存', async t => {
  let seen = [];
  let respond = (body, res) => sse(res, [frame({ content: '你好' }), frame({}, 'stop')]);
  const mock = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    seen.push(body);
    respond(body, res);
  });
  const mockPort = await listen(mock);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const config = {
    ...baseConfig, port, upstream: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
    tunnelMode: false, frameLog: false, dumpFailed: false, toolCallFix: true,
  };
  const getToken = () => ({ token: 'local-test-token', expiresAt: Date.now() + 3600e3 });
  const upstream = createUpstreamClient(config);
  const service = createProxyService({ config, tokenState: createTokenState(getToken), upstreamClient: upstream });
  const proxy = createHttpServer({ config, service, getToken });
  await new Promise(resolve => proxy.server.listen(port, '127.0.0.1', resolve));
  const chat = async extra => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], stream: true, ...extra }),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const uniqueSalts = bodies => {
    for (const body of bodies) assert.match(body.cache_salt || '', /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    assert.equal(new Set(bodies.map(body => body.cache_salt)).size, bodies.length);
  };

  try {
    await t.test('重复客户端请求仍收到正常思考,固定 salt 不能绕过隔离', async () => {
      seen = [];
      const cached = new Set(['fixed-client-salt']);
      respond = (body, res) => {
        const bad = !body.cache_salt || cached.has(body.cache_salt);
        cached.add(body.cache_salt);
        sse(res, [frame({ reasoning: bad ? '!乱码шำ' : '这是一次问候。' }), frame({ content: '你好' }, 'stop')]);
      };
      for (let i = 0; i < 2; i++) {
        const response = await chat({ tools: TOOLS, tool_choice: 'auto', cache_salt: 'fixed-client-salt' });
        assert(response.includes('"reasoning_content":"这是一次问候。"'));
        assert(!response.includes('!乱码'));
        assert(response.includes('[DONE]'));
      }
      uniqueSalts(seen);
      assert.equal(seen[0].tool_choice, 'auto');
      assert.deepEqual(seen[0].tools, TOOLS);
      assert.deepEqual(withoutSalt(seen[0]), withoutSalt(seen[1]));
      assert(seen.every(body => !Object.keys(body).some(key => key.startsWith('__'))));
    });

    await t.test('重用冻结 payload 时重新生成 salt,不改原对象或嵌套内容', async () => {
      seen = [];
      respond = (body, res) => sse(res, [frame({ content: 'ok' }, 'stop')]);
      const payload = Object.freeze({
        model: MODEL, stream: true, cache_salt: 'fixed-client-salt', __toolsDowngraded: true,
        messages: [{ role: 'user', content: 'hello' }], tools: TOOLS,
        max_tokens: 32000, reasoning_effort: 'xhigh', temperature: 0.6,
      });
      const before = JSON.stringify(payload);
      for (let i = 0; i < 2; i++) {
        const result = await upstream.request({ payload, token: 'local-test-token' });
        assert.equal(result.type, 'stream');
      }
      uniqueSalts(seen);
      const expected = JSON.parse(before);
      delete expected.__toolsDowngraded;
      delete expected.cache_salt;
      for (const body of seen) assert.deepEqual(withoutSalt(body), expected);
      assert.equal(JSON.stringify(payload), before);
    });

    await t.test('并发请求不共享 salt', async () => {
      seen = [];
      const payload = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hello' }] };
      const results = await Promise.all(Array.from({ length: 4 }, () => upstream.request({ payload, token: 'local-test-token' })));
      assert(results.every(result => result.type === 'stream'));
      assert.equal(seen.length, 4);
      uniqueSalts(seen);
      assert(!('cache_salt' in payload));
    });

    await t.test('关闭思考且不带 tools 时仍隔离,非流式聚合也生效', async () => {
      seen = [];
      const response = JSON.parse(await chat({ stream: false, enable_thinking: false }));
      assert.equal(response.choices[0].message.content, 'ok');
      uniqueSalts(seen);
      assert.equal(seen[0].chat_template_kwargs.enable_thinking, false);
      assert(!('tools' in seen[0]));
    });

    await t.test('工具补救重发取得新的 salt,仍交付可用的 tool_calls', async () => {
      seen = [];
      respond = (body, res) => {
        if (body.stream) sse(res, [frame({ role: 'assistant', content: '' }), frame({}, 'stop')]);
        else completion(res, HERMES);
      };
      const response = JSON.parse(await chat({ stream: false, tools: TOOLS, tool_choice: 'auto' }));
      assert.equal(seen.length, 2);
      assert.equal(seen[0].stream, true);
      assert.equal(seen[1].stream, false);
      uniqueSalts(seen);
      assert.equal(response.choices[0].finish_reason, 'tool_calls');
      const call = response.choices[0].message.tool_calls[0];
      assert.equal(call.function.name, 'get_weather');
      assert.deepEqual(JSON.parse(call.function.arguments), { city: '北京' });
    });

    await t.test('其它模型不注入 salt,客户端提供的值原样保留', async () => {
      seen = [];
      respond = (body, res) => sse(res, [frame({ content: 'ok' }, 'stop')]);
      for (const model of ['DeepSeek-V4.1-Flash', 'qwen-other']) {
        await chat({ model });
        await chat({ model, cache_salt: 'caller-owned' });
      }
      for (let i = 0; i < seen.length; i += 2) {
        assert(!('cache_salt' in seen[i]));
        assert.equal(seen[i + 1].cache_salt, 'caller-owned');
      }
    });
  } finally {
    await close(proxy.server);
    await close(mock);
  }
});
