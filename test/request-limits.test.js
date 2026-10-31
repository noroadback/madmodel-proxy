'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../config');
const { createHttpServer } = require('../adapters/http-server');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');
const { getTokenizer } = require('../core/tokenizer');

const SETTINGS = [
  ['PROXY_BODY_LIMIT_MB', 'bodyLimit', 64 * 1048576],
  ['PROXY_BODY_BUDGET_MB', 'bodyBudget', 256 * 1048576],
  ['PROXY_HEADER_MS', 'upstreamHeaderTimeout', 300000],
  ['PROXY_IDLE_MS', 'streamIdleTimeout', 300000],
];

function loadConfig(values = {}) {
  const filename = require.resolve('../config');
  const cached = require.cache[filename];
  const saved = SETTINGS.map(([key]) => [key, process.env[key]]);
  try {
    for (const [key] of SETTINGS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    delete require.cache[filename];
    return require('../config');
  } finally {
    require.cache[filename] = cached;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('请求限制默认值、环境覆盖；容量非法值回退，时限非法值拒绝启动', () => {
  for (const value of [undefined, '']) {
    const cfg = loadConfig(Object.fromEntries(SETTINGS.map(([key]) => [key, value])));
    for (const [key, field, fallback] of SETTINGS) assert.equal(cfg[field], fallback, `${key}=${value}`);
  }
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    const cfg = loadConfig({ PROXY_BODY_LIMIT_MB: value, PROXY_BODY_BUDGET_MB: value });
    assert.equal(cfg.bodyLimit, 64 * 1048576);
    assert.equal(cfg.bodyBudget, 256 * 1048576);
    assert.throws(() => loadConfig({ PROXY_HEADER_MS: value }), { code: 'INVALID_TIMEOUT_CONFIG' });
  }
  const cfg = loadConfig({ PROXY_BODY_LIMIT_MB: '1.5', PROXY_HEADER_MS: '4321',
    PROXY_IDLE_MS: '5678' });
  assert.equal(cfg.bodyLimit, 1.5 * 1048576);
  assert.equal(cfg.upstreamHeaderTimeout, 4321);
  assert.equal(cfg.streamIdleTimeout, 5678);
  assert.equal(loadConfig({ PROXY_BODY_BUDGET_MB: '128' }).bodyBudget, 128 * 1048576);
  assert.equal(loadConfig({ PROXY_BODY_LIMIT_MB: '512', PROXY_BODY_BUDGET_MB: '128' }).bodyBudget,
    512 * 1048576, '总量预算至少容纳一条配置最大请求');
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function within(promise, ms = 5000) {
  let timer;
  const timeout = new Error('本地测试等待超时');
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeout), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function openUpload(port, headers) {
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions',
      method: 'POST', agent: false, headers: { Host: 'localhost', 'Content-Type': 'application/json',
        ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        req.destroy();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
  return { req, result };
}

function upload(port, body, chunked, headerOnly = false) {
  const { req, result } = openUpload(port,
    chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': body.length });
  if (headerOnly) req.flushHeaders();
  else if (chunked) { req.write(body.subarray(0, body.length - 1)); req.end(body.subarray(-1)); }
  else req.end(body);
  return result;
}

test('Content-Length 与 chunked 请求体均允许恰好上限，超一字节拒绝', async () => {
  const limit = 256;
  const received = [];
  const service = { logReq() {}, async handleRequest(ctx) {
    received.push(ctx.rawBody);
    ctx.sendJson(200, { size: ctx.size });
  } };
  const { server } = createHttpServer({ config: { ...config, port: 0, bodyLimit: limit }, service,
    getToken: () => { throw new Error('请求体测试不应读取凭据'); } });
  await listen(server);
  try {
    // 使用多字节文本确认限制按 UTF-8 字节计量，空白填充保持 JSON 合法。
    const json = Buffer.from(JSON.stringify({ text: '图片' }));
    const exact = Buffer.concat([json, Buffer.alloc(limit - json.length, 32)]);
    const over = Buffer.concat([exact, Buffer.from(' ')]);
    for (const chunked of [false, true]) {
      const ok = await within(upload(server.address().port, exact, chunked));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.size, limit);
      // Content-Length 超限只发送请求头，验证无需等上传即能拒绝。
      const rejected = await within(upload(server.address().port, over, chunked, !chunked));
      assert.equal(rejected.status, 413);
      assert.match(rejected.body.error.message, /本地.*MiB.*上限/);
    }
    assert.deepEqual(received, [exact, exact], '超限请求不得进入业务层');
  } finally { await close(server); }
});

async function bodyServer(t, handleRequest, overrides = {}) {
  const { server } = createHttpServer({ config: { ...config, port: 0, bodyLimit: 64,
    bodyBudget: 64, ...overrides }, service: { logReq() {}, handleRequest }, getToken: () => null });
  t.after(() => close(server));
  await listen(server);
  return server;
}

test('HTTP 内部异常不泄露凭据或路径，故障后容量额度可重用', async t => {
  const logs = [];
  let calls = 0;
  const { server } = createHttpServer({ config: { ...config, bodyLimit: 64, bodyBudget: 64 },
    getToken: () => null, service: { logReq(...args) { logs.push(args); }, async handleRequest(ctx) {
      if (++calls === 1) throw new Error('SECRET_TOKEN file=C:/private/creds.json');
      ctx.sendJson(200, { ok: true });
    } } });
  await listen(server);
  t.after(() => close(server));
  const result = await upload(server.address().port, Buffer.alloc(64, 32), false);
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.body) + JSON.stringify(logs.map(args => args.slice(1))), /SECRET_TOKEN|private|creds.json/);
  assert.equal((await upload(server.address().port, Buffer.alloc(64, 32), false)).status, 200);
});

test('计数不可用时，上游繁忙不根据缺失的预算证据改写为 413', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const cfg = { ...config, debugBudget: true,
    limitsFor: () => ({ contextWindow: 1024, maxOutputTokens: 2048 }) };
  const service = createProxyService({ config: cfg,
    tokenState: () => ({ token: 'synthetic', expiresAt: Date.now() + 60000 }),
    countPrompt: async () => ({ exact: false, reason: 'worker-timeout' }),
    upstreamClient: { async request() { return { type: 'upstream-error', status: 200,
      body: { errorMessage: '服务器繁忙' } }; } } });
  const { server } = createHttpServer({ config: cfg, service, getToken: () => null });
  await listen(server);
  t.after(() => close(server));
  for (const stream of [false, true]) {
    const response = await upload(server.address().port, Buffer.from(JSON.stringify({
      model: 'unknown', max_tokens: 2048, stream, messages: [{ role: 'user', content: 'hello' }] })), false);
    assert.equal(response.status, 429);
    assert.doesNotMatch(response.body.error.message, /超限/);
  }
  assert.doesNotMatch(logs.join('\n'), /文本=0|疑似上下文超限/);
});

test('病态长输入交给上游预算校验，不阻塞健康检查或误报本地 413', { timeout: 20000 }, async t => {
  const { PromptCounter } = require('../core/prompt-counter');
  const counter = new PromptCounter();
  t.after(() => counter.close());
  const counting = deferred();
  const text = '中'.repeat(2 * 1024 * 1024);
  let upstreamCalls = 0;
  const cfg = { ...config, limitsFor: () => ({ contextWindow: 1024, maxOutputTokens: 100 }) };
  const service = createProxyService({ config: cfg,
    tokenState: () => ({ token: 'synthetic', expiresAt: Date.now() + 60000 }),
    countPrompt: (body, opts) => { const result = counter.count(body, opts); counting.resolve(); return result; },
    upstreamClient: { async request({ payload }) {
      upstreamCalls++;
      assert.equal(payload.messages[0].content, text);
      assert.equal(payload.max_tokens, 100);
      return { type: 'completion', body: { id: 'fake', choices: [{ message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop' }], usage: { prompt_tokens: 2000000, completion_tokens: 1 } } };
    } } });
  const { server } = createHttpServer({ config: cfg, service, getToken: () => null });
  await listen(server);
  t.after(() => close(server));
  const request = upload(server.address().port, Buffer.from(JSON.stringify({ model: 'DeepSeek-V4.1-Flash',
    max_tokens: 100, messages: [{ role: 'user', content: text }] })), false);
  await within(counting.promise);
  const start = performance.now();
  const health = await within(new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/healthz`, { headers: { Host: 'localhost' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  }), 2000);
  t.diagnostic(`health during 6 MiB CJK input: ${Math.round(performance.now() - start)}ms`);
  assert.equal(health, 200);
  assert.equal((await within(request, 10000)).status, 200);
  assert.equal(upstreamCalls, 1);
});

test('请求体总预算覆盖业务处理阶段，成功及异常结束后均可重用', async t => {
  for (const chunked of [false, true]) for (const fail of [false, true]) {
    await t.test(`chunked=${chunked}, fail=${fail}`, async t => {
      const entered = deferred(), finish = deferred();
      let calls = 0;
      const server = await bodyServer(t, async ctx => {
        if (++calls === 1) {
          entered.resolve();
          await finish.promise;
          if (fail) throw new Error('synthetic failure');
        }
        ctx.sendJson(200, { ok: true });
      });
      const port = server.address().port;
      const first = upload(port, Buffer.alloc(64, 32), chunked);
      try {
        await within(entered.promise);
        const rejected = await within(upload(port, Buffer.from('x'), chunked, !chunked));
        assert.equal(rejected.status, 429);
        assert.equal(rejected.body.error.type, 'rate_limit');
        assert.equal(calls, 1, '预算已满时不得进入业务处理');
      } finally { finish.resolve(); }
      assert.equal((await within(first)).status, fail ? 500 : 200);
      assert.equal((await within(upload(port, Buffer.alloc(64, 32), chunked))).status, 200);
    });
  }
});

test('总预算允许多个请求恰好填满；超额 chunked 不保留部分额度', async t => {
  const entered = [deferred(), deferred()], finish = deferred();
  let calls = 0;
  const server = await bodyServer(t, async ctx => {
    const i = calls++;
    if (i < 2) { entered[i].resolve(); await finish.promise; }
    ctx.sendJson(200, { ok: true });
  });
  const port = server.address().port;
  const first = upload(port, Buffer.alloc(32, 32), false);
  await within(entered[0].promise);
  // 第二个请求已经接收一部分后才超过剩余预算，拒绝后须归还其全部额度。
  const partialReceived = deferred();
  server.once('request', req => req.once('data', partialReceived.resolve));
  const partial = openUpload(port, { 'Transfer-Encoding': 'chunked' });
  partial.req.write(Buffer.alloc(32, 32));
  await within(partialReceived.promise);
  partial.req.end(' ');
  const rejected = await within(partial.result);
  assert.equal(rejected.status, 429);
  const second = upload(port, Buffer.alloc(32, 32), true);
  try {
    await within(entered[1].promise);
    assert.equal((await within(upload(port, Buffer.from('x'), false, true))).status, 429);
  } finally { finish.resolve(); }
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal((await within(upload(port, Buffer.alloc(64, 32), false))).status, 200);
});

test('上传超时、主动断开及单请求超限均归还总预算', async t => {
  for (const mode of ['timeout', 'abort', 'overflow']) {
    await t.test(mode, async t => {
      const server = await bodyServer(t, async ctx => ctx.sendJson(200, { ok: true }), { bodyTimeout: 500 });
      const port = server.address().port;
      if (mode === 'timeout') {
        assert.equal((await within(upload(port, Buffer.alloc(64), false, true))).status, 408);
      } else if (mode === 'abort') {
        const arrived = deferred(), disconnected = deferred();
        server.once('request', req => {
          req.once('aborted', disconnected.resolve);
          arrived.resolve();
        });
        const req = http.request({ host: '127.0.0.1', port, method: 'POST',
          path: '/v1/chat/completions', headers: { Host: 'localhost', 'Content-Length': 64 } });
        req.on('error', () => {});
        req.flushHeaders();
        await within(arrived.promise);
        req.destroy();
        await within(disconnected.promise);
      } else {
        assert.equal((await within(upload(port, Buffer.alloc(65), true))).status, 413);
      }
      assert.equal((await within(upload(port, Buffer.alloc(64, 32), false))).status, 200);
    });
  }
});

function serviceContext(rawBody = Buffer.from('{"model":"DeepSeek-V4.1-Flash","messages":[]}')) {
  const out = {};
  return { out, rawBody, size: 1, started: Date.now(), req: {},
    abortController: new AbortController(), setExtraHeaders() {}, clientGone: () => false,
    headersSent: () => false, sseHeadersSent: () => false, sseBytes: () => 0,
    sendError(status) { out.status = status; }, sendJson(status) { out.status = status; } };
}
const testCompletion = { type: 'completion', body: {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
} };
const testAuth = () => ({ ok: true, token: 'synthetic', msLeft: 3600000 });

test('并发已满时不解析 JSON、不分词；释放后正常请求可继续', async t => {
  const finish = deferred();
  let count = 0, calls = 0;
  t.mock.method(console, 'log', () => {});
  t.mock.method(getTokenizer(), 'countPromptTokens', () => { count++; return 4; });
  const service = createProxyService({ config: { ...config, inflightHardLimit: 1 }, tokenState: testAuth,
    upstreamClient: { async request() { calls++; await finish.promise; return testCompletion; } } });
  const first = service.handleRequest(serviceContext());
  try {
    const second = serviceContext({ toString() { throw new Error('不应解析'); } });
    await service.handleRequest(second);
    assert.equal(second.out.status, 429);
    assert.equal(count, 1);
    assert.equal(calls, 1);
  } finally { finish.resolve(); }
  await first;
  const next = serviceContext();
  await service.handleRequest(next);
  assert.equal(next.out.status, 200);
});

test('解析、预算及异常出口归还并发槽', async t => {
  t.mock.method(console, 'log', () => {});
  for (const failure of ['json', 'budget', 'tokenizer', 'upstream']) {
    let failing = true;
    const mock = t.mock.method(getTokenizer(), 'countPromptTokens', () => {
      if (failing && failure === 'tokenizer') throw new Error('synthetic tokenizer');
      return failing && failure === 'budget' ? 2000000 : 4;
    });
    const service = createProxyService({ config: { ...config, inflightHardLimit: 1 }, tokenState: testAuth,
      upstreamClient: { async request() {
        if (failing && failure === 'upstream') throw new Error('synthetic upstream');
        return testCompletion;
      } } });
    try {
      const bad = serviceContext(failure === 'json' ? Buffer.from('{') : undefined);
      if (['tokenizer', 'upstream'].includes(failure)) {
        await assert.rejects(service.handleRequest(bad), /synthetic/);
      } else {
        await service.handleRequest(bad);
        assert.equal(bad.out.status, failure === 'json' ? 400 : 413);
      }
      failing = false;
      const good = serviceContext();
      await service.handleRequest(good);
      assert.equal(good.out.status, 200, failure);
    } finally { mock.mock.restore(); }
  }
});

const CHUNK = { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
const SSE = `data: ${JSON.stringify(CHUNK)}\n\ndata: [DONE]\n\n`;
function delayed(res, action) {
  const timer = setTimeout(action, 1000);
  res.once('close', () => clearTimeout(timer));
}

async function withUpstream(handler, overrides, run) {
  const arrived = deferred(), closed = deferred();
  const server = http.createServer((req, res) => {
    // 头前取消在上传完成后触发，专门验证等待响应头阶段。
    req.once('end', arrived.resolve);
    req.resume();
    res.once('close', closed.resolve);
    handler(res);
  });
  await listen(server);
  const cfg = { ...config, upstream: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    tunnelMode: false, upstreamHeaderTimeout: 2500, streamIdleTimeout: 2500,
    streamTotalTimeout: 10000, ...overrides };
  const client = createUpstreamClient(cfg);
  const request = options => client.request({ payload: {}, token: 'synthetic-token', ...options });
  try { await run({ cfg, client, request, arrived: arrived.promise, closed: closed.promise }); }
  finally { await close(server); }
}

test('慢响应头与头后慢首数据在各自预算内完成', async t => {
  for (const phase of ['headers', 'idle']) {
    await t.test(phase, async () => {
      await withUpstream(res => {
        if (phase === 'idle') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.flushHeaders();
        }
        delayed(res, () => {
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(SSE);
        });
      }, phase === 'headers' ? { streamIdleTimeout: 400 } : { upstreamHeaderTimeout: 400 },
      async ({ request }) => {
        const chunks = [];
        const result = await within(request({ onChunk: chunk => chunks.push(chunk) }));
        assert.equal(result.type, 'stream');
        assert.deepEqual(chunks, [CHUNK]);
      });
    });
  }
});

test('响应头与首数据超时仍截止并关闭上游连接', async t => {
  for (const phase of ['headers', 'idle']) {
    await t.test(phase, async () => {
      await withUpstream(res => {
        if (phase === 'idle') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.flushHeaders();
        }
      }, phase === 'headers' ? { upstreamHeaderTimeout: 400 } : { streamIdleTimeout: 400 },
      async ({ request, closed }) => {
        assert.deepEqual(await within(request()), { type: 'timeout', phase });
        await within(closed);
      });
    });
  }
});

test('外部取消在响应头前和首数据前均立即结束请求', async t => {
  for (const phase of ['headers', 'idle']) {
    await t.test(phase, async () => {
      await withUpstream(res => {
        if (phase === 'idle') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.flushHeaders();
        }
      }, {}, async ({ request, arrived, closed }) => {
        const opened = deferred();
        const ac = new AbortController();
        const pending = request({ signal: ac.signal, onOpen: opened.resolve });
        await within(phase === 'headers' ? arrived : opened.promise);
        ac.abort();
        assert.deepEqual(await within(pending), { type: 'aborted' });
        await within(closed);
      });
    });
  }
});
