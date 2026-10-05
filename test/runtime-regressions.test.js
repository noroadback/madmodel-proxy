'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createProxyService } = require('../core/proxy-service');
const { createUpstreamClient } = require('../core/upstream-client');
const { createAggregator } = require('../core/completion-aggregator');
const { createTokenCache, createHttpServer } = require('../adapters/http-server');
const { createDiscoveryRunner, parseModelList } = require('../core/model-discovery');
const { createModelRegistry, getModelMeta } = require('../core/model-registry');
const { isProxyRunning } = require('../core/proxy-status');
const config = require('../config');

const auth = { ok: true, token: 'synthetic-token', msLeft: 3600000 };
const tools = ['Read', 'Write'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const markup = name => `<｜DSML｜tool_use><｜DSML｜tool call="${name}"></｜DSML｜invoke></｜DSML｜tool_use>`;
const native = name => ({ id: 'call-native', type: 'function', function: { name, arguments: '{}' } });
const completion = (content, calls) => ({ choices: [{ index: 0, message: {
  role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}),
}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function context(body) {
  const out = { chunks: [], lines: [] };
  let headers = false;
  return {
    out, rawBody: Buffer.from(JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'test' }], ...body })),
    req: { method: 'POST', url: '/v1/chat/completions' }, size: 1, started: Date.now(),
    abortController: new AbortController(), clientGone: () => false,
    headersSent: () => headers, sseHeadersSent: () => headers, sseBytes: () => 0,
    setExtraHeaders() {}, setThinkingFields() {}, dumpFailed() {},
    ensureSseHeaders() { headers = true; },
    async writeSseChunk(obj) { headers = true; out.chunks.push(obj); },
    async writeSseLine(line) { headers = true; out.lines.push(line); },
    endResponse() { out.ended = true; },
    sendJson(status, body, extra) { headers = true; Object.assign(out, { status, body, extra }); },
    sendError(status, message, type, extra) { headers = true; Object.assign(out, { status, message, type, extra }); },
  };
}
function delivered(ctx) {
  if (ctx.out.body) return ctx.out.body;
  const agg = createAggregator();
  for (const chunk of ctx.out.chunks) agg.feed(chunk);
  assert.ok(ctx.out.lines.includes('data: [DONE]\n\n'));
  return agg.result();
}
async function run(body, responses, overrides = {}) {
  const seen = [];
  const service = createProxyService({ config: { ...config, ...overrides }, tokenState: () => auth,
    upstreamClient: { request: async args => {
      seen.push(args.payload);
      const next = responses[seen.length - 1];
      assert.ok(next, '不得发生未预期的重试');
      if (next.type === 'stream') {
        const ch = next.body.choices[0];
        await args.onChunk({ choices: [{ index: 0, delta: ch.message, finish_reason: ch.finish_reason }] });
        return { type: 'stream', usage: next.body.usage };
      }
      return next;
    } },
  });
  const ctx = context(body);
  await service.handleRequest(ctx);
  return { ctx, seen };
}

for (const stream of [false, true]) {
  for (const transport of ['stream', 'completion']) {
    test(`完整变体标记直接恢复，客户端流式=${stream}，上游=${transport}`, async () => {
      const { ctx, seen } = await run({ stream, tools }, [{ type: transport, body: completion(markup('Write')) }]);
      const body = delivered(ctx);
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Write');
      assert.equal(body.choices[0].message.content, null);
      assert.equal(seen.length, 1);
    });
    test(`指定工具名不会恢复其他工具，客户端流式=${stream}，上游=${transport}`, async () => {
      const { ctx, seen } = await run({ stream, tools, tool_choice: { type: 'function', function: { name: 'Write' } } },
        [{ type: transport, body: completion(markup('Read')) }]);
      assert.equal(delivered(ctx).choices[0].message.tool_calls, undefined);
      assert.equal(seen[0].tool_choice, 'none', 'Qwen 上游兼容降级仍生效');
    });
    for (const mode of ['none', 'disabled']) {
      test(`工具恢复关闭不解析也不重试，${mode}，客户端=${stream}，上游=${transport}`, async () => {
        const { ctx, seen } = await run({ stream, tools, tool_choice: mode === 'none' ? 'none' : 'auto' },
          [{ type: transport, body: completion(markup('Write')) }], { toolCallFix: mode !== 'disabled' });
        assert.equal(delivered(ctx).choices[0].message.content, markup('Write'));
        assert.equal(delivered(ctx).choices[0].message.tool_calls, undefined);
        assert.equal(seen.length, 1);
      });
    }
  }
  for (const name of ['Write', 'Read']) {
    test(`重试保留合法原生调用并约束名称 ${name}，流式=${stream}`, async () => {
      const { ctx, seen } = await run({ stream, tools, tool_choice: { type: 'function', function: { name: 'Write' } } }, [
        { type: 'completion', body: completion('') },
        { type: 'completion', body: completion('已准备', [native(name)]) },
      ]);
      const msg = delivered(ctx).choices[0].message;
      assert.equal(msg.tool_calls?.[0]?.function.name, name === 'Write' ? 'Write' : undefined);
      assert.equal(seen.length, 2);
    });
  }
  test(`重试的截断调用不得执行，流式=${stream}`, async () => {
    const retryBody = completion('', [native('Write')]);
    retryBody.choices[0].finish_reason = 'length';
    const { ctx } = await run({ stream, tools }, [
      { type: 'completion', body: completion('') }, { type: 'completion', body: retryBody },
    ]);
    assert.equal(delivered(ctx).choices[0].message.tool_calls, undefined);
  });
}

test('上游工具索引拒绝原型键及无效数字，不污染对象原型', () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const index of ['__proto__', 'constructor', -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const agg = createAggregator();
    assert.throws(() => agg.feed({ choices: [{ delta: { tool_calls: [{ index, id: 'pollution' }] } }] }), /索引无效/);
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  const agg = createAggregator();
  agg.feed({ choices: [{ delta: { tool_calls: [native('Write')] } }] });
  assert.equal(agg.result().choices[0].message.tool_calls[0].id, 'call-native');
});

test('凭据临时不可读后，mtime 未变也能恢复；成功结果仍缓存', () => {
  const file = path.join(process.env.MADMODEL_STATE_DIR, 'metadata.json');
  fs.writeFileSync(file, '{}');
  let clock = 0, reads = 0, unlocked = false;
  const token = { token: 'synthetic-token', expiresAt: 9999 };
  const getToken = createTokenCache({ tokenFile: file }, { now: () => clock, negativeTtlMs: 2000,
    readToken: () => { reads++; return unlocked ? token : null; } });
  assert.equal(getToken(), null);
  unlocked = true;
  clock = 1999;
  assert.equal(getToken(), null);
  assert.equal(reads, 1);
  clock = 2000;
  assert.equal(getToken(), token);
  clock = 10000;
  assert.equal(getToken(), token);
  assert.equal(reads, 2);
});

test('凭据出现后探测一次；并发 tick 合并，完成后不重复探测', async () => {
  let credentials = null, calls = 0;
  const gate = deferred(), published = [];
  const runner = createDiscoveryRunner({ now: () => 100, getCredentials: () => credentials,
    probe: async () => { calls++; await gate.promise; return [{ id: 'late-model', ok: true }]; },
    publish: r => published.push(r) });
  await runner.tick();
  credentials = { token: 'expired', expiresAt: 99 };
  await runner.tick();
  assert.equal(calls, 0);
  credentials = { token: 'valid', expiresAt: 200 };
  const first = runner.tick();
  assert.equal(runner.tick(), first);
  gate.resolve();
  await first;
  await runner.tick();
  assert.equal(calls, 1);
  assert.equal(published[0][0].id, 'late-model');
  assert.equal(runner.complete, true);
});

test('探测遇会话失败不循环请求，新 cookie 到达后自动重试', async () => {
  let credentials = { token: 'same', cookie: 'old', expiresAt: 200 };
  const seen = [];
  const runner = createDiscoveryRunner({ now: () => 100, getCredentials: () => credentials, wait: async () => {},
    probe: async c => { seen.push(c.cookie); return [{ id: 'm', ok: c.cookie === 'fresh', reason: 'session' }]; },
    publish() {} });
  await runner.tick();
  await runner.tick();
  assert.deepEqual(seen, ['old', 'old']);
  credentials = { ...credentials, cookie: 'fresh' };
  await runner.tick();
  assert.deepEqual(seen, ['old', 'old', 'fresh']);
  assert.equal(runner.complete, true);
});

test('凭据等待释放槽位，恢复时仍遵守本地并发上限', async () => {
  const waiting = deferred(), fresh = deferred(), occupied = deferred(), finish = deferred();
  let count = 0;
  const service = createProxyService({ config: { ...config, tunnelMode: true, inflightHardLimit: 1 }, tokenState: () => auth,
    waitForCredentials: async () => { waiting.resolve(); return fresh.promise; },
    upstreamClient: { request: async () => {
      count++;
      if (count === 1) return { type: 'upstream-error', status: 302, location: '/login' };
      occupied.resolve();
      await finish.promise;
      return { type: 'completion', body: completion('ok') };
    } },
  });
  const a = context({}), b = context({});
  const first = service.handleRequest(a);
  await waiting.promise;
  const second = service.handleRequest(b);
  await occupied.promise;
  fresh.resolve({ token: 'new', cookie: 'new' });
  await first;
  assert.equal(a.out.status, 429);
  assert.equal(count, 2, '重签后不能越过正在占用的槽位');
  finish.resolve();
  await second;
  const c = context({});
  await service.handleRequest(c);
  assert.equal(c.out.status, 200, '完成后槽位释放');
});

for (const stream of [true, false]) {
  test(`上游并发错误映射 429 且保留 Retry-After，流式=${stream}`, async () => {
    const { ctx } = await run({ stream }, [{ type: 'upstream-error', status: 200,
      body: { errorMessage: '您的同时进行中的请求过多，请等待已有请求完成后再试' }, retryAfter: '7' }]);
    assert.equal(ctx.out.status, 429);
    assert.equal(ctx.out.extra['Retry-After'], '7');
  });
}

test('运行状态核验代理标识，不把其他 OpenAI 服务当成本代理', async () => {
  for (const [status, body, expected] of [
    [200, { data: [] }, false], [200, { proxy: 'other' }, false],
    [200, { proxy: 'madmodel' }, true], [500, { proxy: 'madmodel' }, false],
  ]) {
    assert.equal(await isProxyRunning(12345, async url => {
      assert.equal(url, 'http://127.0.0.1:12345/healthz');
      return { status, json: async () => body };
    }), expected);
  }
});

test('模型列表与请求共用回退能力，部分探测字段不抹掉已知值', async () => {
  const cfg = { ...config, port: 0 };
  const registry = createModelRegistry(cfg);
  const partial = parseModelList('modelList:[{label:"Qwen",value:"qwen3.8-27b",thinkingField:"custom_reasoning"}]')[0];
  registry.publish([{ id: 'qwen3.8-27b', ok: true, meta: partial }]);
  const meta = getModelMeta(cfg, registry, 'qwen3.8-27b');
  assert.equal(meta.thinkingParam, 'enable_thinking');
  assert.equal(meta.thinkingField, 'custom_reasoning');
  assert.deepEqual(meta.effortOptions, ['low', 'medium', 'xhigh']);
  const seen = [];
  const service = createProxyService({ config: cfg, modelRegistry: registry, tokenState: () => auth,
    upstreamClient: { request: async ({ payload }) => {
      seen.push(payload);
      return { type: 'completion', body: completion('ok') };
    } } });
  const { server } = createHttpServer({ config: cfg, modelRegistry: registry, service, getToken: () => null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = await new Promise((resolve, reject) => {
      require('http').get(`http://127.0.0.1:${server.address().port}/v1/models`, { headers: { Host: 'localhost' } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const row = body.data[0];
    assert.equal(row.reasoning.thinking_param, meta.thinkingParam);
    assert.deepEqual(row.reasoning.effort_options, meta.effortOptions);
    assert.equal(row.supports_vision, null);
    const ctx = context({ reasoning_effort: 'xhigh' });
    await service.handleRequest(ctx);
    assert.equal(seen[0].chat_template_kwargs.enable_thinking, true);
    assert.equal(seen[0].reasoning_effort, 'xhigh');
    registry.publish([{ id: 'qwen3.8-27b', ok: true, meta: { thinkingParam: null } }]);
    assert.equal(getModelMeta(cfg, registry, 'qwen3.8-27b').thinkingParam, null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('与原型属性重名的未知模型也使用保守预算', () => {
  for (const model of ['constructor', '__proto__', 'toString']) {
    assert.deepEqual(config.limitsFor(model), { contextWindow: 131072, maxOutputTokens: 65536 });
  }
});

for (const status of [200, 503]) {
  test(`JSON/错误响应持续到达时重置空闲计时，HTTP ${status}`, async t => {
    const body = JSON.stringify(status === 200 ? completion('ok') : { message: 'error' });
    let timer;
    const stream = new ReadableStream({ start(controller) {
      let at = 0;
      timer = setInterval(() => {
        const end = Math.min(at + Math.ceil(body.length / 8), body.length);
        controller.enqueue(Buffer.from(body.slice(at, end)));
        at = end;
        if (at === body.length) { clearInterval(timer); controller.close(); }
      }, 100);
    }, cancel() { clearInterval(timer); } });
    t.mock.method(globalThis, 'fetch', async () => new Response(stream, { status,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } }));
    try {
      const result = await createUpstreamClient({ ...config, streamIdleTimeout: 500, streamTotalTimeout: 5000 })
        .request({ payload: {}, token: 'synthetic' });
      assert.equal(result.type, status === 200 ? 'completion' : 'upstream-error');
      if (status === 503) assert.equal(result.retryAfter, '5');
    } finally { clearInterval(timer); }
  });
  test(`持续错误/JSON 字节仍受总时限保护，HTTP ${status}`, async t => {
    let timer, cancelled = false;
    const stream = new ReadableStream({ start(controller) {
      timer = setInterval(() => controller.enqueue(Buffer.from(' ')), 50);
    }, cancel() { cancelled = true; clearInterval(timer); } });
    t.mock.method(globalThis, 'fetch', async () => new Response(stream, { status }));
    try {
      const result = await createUpstreamClient({ ...config, streamIdleTimeout: 1000, streamTotalTimeout: 400 })
        .request({ payload: {}, token: 'synthetic' });
      assert.deepEqual(result, { type: 'timeout', phase: 'total' });
      assert.equal(cancelled, true);
    } finally { clearInterval(timer); }
  });
}
