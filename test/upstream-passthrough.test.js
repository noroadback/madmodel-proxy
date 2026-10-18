// 缓存隔离在真实本地 HTTP 出口验证，不访问外部服务或读取真实凭据。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const baseConfig = require('../config');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPLETION = { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
const CHUNK = { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function respond(res, stream) {
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(CHUNK)}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(COMPLETION));
  }
}

async function localUpstream(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
    seen.push({ payload, headers: req.headers });
    if (handler) handler(req, res, payload, seen.length);
    else respond(res, payload.stream);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...baseConfig,
    upstream: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    tunnelMode: false,
    upstreamHeaderTimeout: 5000, streamIdleTimeout: 5000, streamTotalTimeout: 10000,
  };
  return { config, seen };
}

function assertIsolated(outgoing, original) {
  assert.match(outgoing.cache_salt, UUID, '出口应携带新的随机盐');
  if (Object.hasOwn(original, 'cache_salt')) assert.notDeepEqual(outgoing.cache_salt, original.cache_salt);
  const expected = Object.fromEntries(Object.entries(original)
    .filter(([key]) => key !== 'cache_salt' && !key.startsWith('__')));
  const { cache_salt, ...rest } = outgoing;
  assert.deepEqual(rest, expected, '除了出口盐与保留字段，其他请求内容应完整保留');
  assert.ok(Object.keys(outgoing).every(key => !key.startsWith('__')), '内部字段不能泄漏到上游');
}

test('Qwen 每次实际发送使用独立缓存盐，其他请求内容透传', async t => {
  const { config, seen } = await localUpstream(t);
  const upstream = createUpstreamClient(config);
  const send = async payload => {
    const chunks = [];
    const opened = [];
    const result = await upstream.request({ payload, token: 'local-test-token',
      onChunk: chunk => { chunks.push(chunk); }, onOpen: isSse => { opened.push(isSse); } });
    assert.deepEqual(opened, [payload.stream]);
    if (payload.stream) {
      assert.equal(result.type, 'stream');
      assert.deepEqual(chunks, [CHUNK]);
    } else {
      assert.equal(result.type, 'completion');
      assert.deepEqual(result.body, COMPLETION);
    }
  };
  const capture = async payload => {
    const index = seen.length;
    await send(payload);
    assert.equal(seen.length, index + 1);
    return seen[index].payload;
  };
  const request = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hello' }] };

  for (const stream of [false, true]) {
    const mode = stream ? 'SSE' : 'JSON';
    await t.test(`${mode}：未提供 cache_salt 时自动注入，原对象保持缺省`, async () => {
      const payload = deepFreeze({ ...request, stream });
      assertIsolated(await capture(payload), payload);
      assert.equal(Object.hasOwn(payload, 'cache_salt'), false);
    });

    await t.test(`${mode}：客户端固定盐及无效盐都被覆盖，原值不变`, async () => {
      for (const cache_salt of ['fixed-client-salt', '11111111-1111-4111-8111-111111111111',
        '', null, undefined, 0, false, { fixed: true }, []]) {
        const payload = deepFreeze({ ...request, stream, cache_salt });
        const before = structuredClone(payload);
        assertIsolated(await capture(payload), payload);
        assert.deepEqual(payload, before);
      }
    });

    await t.test(`${mode}：重复及并发发送同一深冻结对象，每次盐唯一且嵌套内容不变`, async () => {
      const payload = deepFreeze({
        ...request, stream, cache_salt: 'fixed-client-salt',
        __diagnostic: 'local-only', __retry: { attempt: 1 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {
          type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
        } } }],
        tool_choice: 'auto', max_tokens: 32000, reasoning_effort: 'xhigh', temperature: 0.6,
      });
      const before = structuredClone(payload);
      const start = seen.length;
      await send(payload);
      await send(payload);
      await Promise.all(Array.from({ length: 8 }, () => send(payload)));
      const sent = seen.slice(start).map(item => item.payload);
      assert.equal(sent.length, 10);
      for (const outgoing of sent) assertIsolated(outgoing, payload);
      assert.equal(new Set(sent.map(item => item.cache_salt)).size, sent.length);
      assert.deepEqual(payload, before, '同一对象及所有嵌套内容均不得被出口改写');
    });

    await t.test(`${mode}：其他模型无盐不注入，有盐保持原值`, async () => {
      for (const model of ['DeepSeek-V4.1-Flash', 'DeepSeek-R1-W8A8', 'custom-model']) {
        for (const extra of [{}, { cache_salt: 'client-fixed-salt' }, { cache_salt: null }]) {
          const payload = deepFreeze({ ...request, model, stream, ...extra, __diagnostic: 'local-only' });
          const before = structuredClone(payload);
          const { __diagnostic, ...expected } = payload;
          assert.deepEqual(await capture(payload), expected);
          assert.deepEqual(payload, before);
        }
      }
    });
  }
  const qwenSalts = seen.filter(item => item.payload.model === request.model).map(item => item.payload.cache_salt);
  assert.equal(new Set(qwenSalts).size, qwenSalts.length, '跨顺序、并发和响应格式也不能重用盐');
});

test('WebVPN 会话失效后用真实上游客户端重试，每次 HTTP 发送更换 Qwen 盐', async t => {
  t.mock.method(console, 'log', () => {});
  for (const stream of [false, true]) {
    await t.test(stream ? 'SSE 成功响应' : 'JSON 成功响应', async t => {
      const { config, seen } = await localUpstream(t, (_req, res, _payload, attempt) => {
        if (attempt === 1) {
          res.writeHead(302, { location: '/login' });
          res.end();
        } else respond(res, stream);
      });
      const tunnelConfig = { ...config, tunnelMode: true };
      const originalAuth = { token: 'local-old-token', cookie: 'session=old', msLeft: 3600000 };
      const freshAuth = { token: 'local-new-token', cookie: 'session=new' };
      const waits = [];
      const service = createProxyService({
        config: tunnelConfig,
        tokenState: () => originalAuth,
        upstreamClient: createUpstreamClient(tunnelConfig),
        waitForCredentials: async (...args) => { waits.push(args); return freshAuth; },
      });
      const payload = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hello' }],
        stream: false, max_tokens: 512, cache_salt: 'client-fixed-salt', __diagnostic: 'local-only' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      let delivered;
      const ctx = {
        rawBody, req: { method: 'POST', url: '/v1/chat/completions' },
        size: rawBody.length, started: Date.now(), abortController: new AbortController(),
        clientGone: () => false, headersSent: () => false, sseHeadersSent: () => false,
        setExtraHeaders() {}, dumpFailed() {},
        sendJson(status, body) { delivered = { status, body }; },
        sendError(status, message) { delivered = { status, message }; },
      };
      await service.handleRequest(ctx);
      assert.equal(delivered?.status, 200, JSON.stringify(delivered));
      assert.equal(delivered.body.choices[0].message.content, 'ok');
      assert.deepEqual(waits, [[originalAuth.token, originalAuth.cookie, tunnelConfig.waitRetryBudgetMs]]);
      assert.equal(seen.length, 2, '真实 HTTP 出口应恰好发送初次请求与一次凭据重试');
      assert.deepEqual(seen.map(item => item.headers.authorization),
        [`Bearer ${originalAuth.token}`, `Bearer ${freshAuth.token}`]);
      assert.deepEqual(seen.map(item => item.headers.cookie), [originalAuth.cookie, freshAuth.cookie]);
      for (const item of seen) {
        assert.match(item.payload.cache_salt, UUID);
        assert.notEqual(item.payload.cache_salt, payload.cache_salt);
        assert.equal(Object.hasOwn(item.payload, '__diagnostic'), false);
      }
      assert.notEqual(seen[0].payload.cache_salt, seen[1].payload.cache_salt, '重认证重试也必须更换缓存盐');
      const { cache_salt: firstSalt, ...first } = seen[0].payload;
      const { cache_salt: secondSalt, ...second } = seen[1].payload;
      assert.deepEqual(first, second, '凭据重试不改变其他已归一请求字段');
      assert.deepEqual(JSON.parse(ctx.rawBody.toString('utf8')), payload, '原始客户端请求不被改写');
    });
  }
});
