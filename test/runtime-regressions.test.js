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
const native = name => ({ id: 'call-native', type: 'function', function: { name, arguments: '{}' } });
const completion = (content, calls) => ({ choices: [{ index: 0, message: {
  role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}),
}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tinyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrWQAAAAASUVORK5CYII=';
const imageMessages = count => [{ role: 'user', content: [{ type: 'text', text: 'hi' },
  ...Array.from({ length: count }, () => ({ type: 'image_url', image_url: { url: tinyImage } })),
] }];

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
    sendError(status, message, type, extra, code) { headers = true; Object.assign(out, { status, message, type, extra, code }); },
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
        if (next.body.usage) await args.onChunk({ choices: [], usage: next.body.usage });
        return { type: 'stream', usage: next.body.usage };
      }
      return next;
    } },
  });
  const ctx = context(body);
  await service.handleRequest(ctx);
  return { ctx, seen };
}

test('含图请求成功或失败时默认隐藏预算，调试模式保留分项', async t => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const cases = [
    { status: 200, response: { type: 'stream', body: completion('ok') } },
    { status: 429, response: { type: 'upstream-error', status: 429, body: {}, raw: '' } },
    { status: 413, response: { type: 'upstream-error', status: 413, body: {}, raw: '' } },
    { status: 502, response: { type: 'network-error', cause: 'synthetic connection failure' } },
  ];
  for (const { stream, debugBudget } of [
    { stream: false, debugBudget: false }, { stream: true, debugBudget: false },
    { stream: false, debugBudget: true }, { stream: true, debugBudget: true },
  ]) {
    for (const { status, response } of cases) {
      lines.length = 0;
      const { ctx, seen } = await run({ model: 'DeepSeek-V4.1-Flash', stream,
        max_tokens: 1048576, messages: imageMessages(64) }, [response], { debugBudget });
      assert.strictEqual(seen.length, 1);
      assert.ok(seen[0].max_tokens < 1048576, '日志开关不影响输出收缩');
      const summaries = lines.filter(line => line.includes('预算['));
      assert.strictEqual(summaries.length, debugBudget ? 1 : 0, `stream=${stream}, status=${status}, debug=${debugBudget}`);
      if (debugBudget) {
        for (const part of [/文本=\d+/, /模板=1024/, /工具=0/, /文本误差=0/, /窗口=1048576/]) {
          assert.match(summaries[0], part);
        }
        assert.ok(summaries[0].includes(`输出=${seen[0].max_tokens}`));
      } else {
        assert.doesNotMatch(lines.join('\n'), /预算|图像实测|估值差|图像策略/);
      }
      if (status === 200) {
        assert.strictEqual(delivered(ctx).choices[0].message.content, 'ok');
        assert.match(lines.join('\n'), / 200 \d+\.\d+s .*token 2\/3 累计 2\/3/);
        if (debugBudget) assert.match(lines.join('\n'), /输出预算 \d+/);
      } else {
        assert.strictEqual(ctx.out.status, status, '日志阶段标记不得成为客户端状态码');
      }
    }
  }
});

test('图像用量原样返回，相同请求的输出预算不受历史 usage 影响', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  for (const { stream, debugBudget } of [
    { stream: false, debugBudget: false }, { stream: true, debugBudget: false },
    { stream: false, debugBudget: true }, { stream: true, debugBudget: true },
  ]) {
    logs.length = 0;
    const sent = [];
    const service = createProxyService({ config: { ...config, debugBudget }, tokenState: () => auth,
      upstreamClient: { request: async args => {
        sent.push(args.payload.max_tokens);
        const body = completion('ok');
        body.usage = { prompt_tokens: 13000, completion_tokens: 3,
          prompt_tokens_details: { multimodal_tokens: { image: 11840 } } };
        if (stream) {
          await args.onChunk({ choices: [{ index: 0, delta: body.choices[0].message, finish_reason: 'stop' }] });
          await args.onChunk({ choices: [], usage: body.usage });
          return { type: 'stream', usage: body.usage };
        }
        return { type: 'completion', body };
      } },
    });
    for (let i = 0; i < 2; i++) {
      const messages = imageMessages(64);
      const ctx = context({ model: 'DeepSeek-V4.1-Flash', stream, max_tokens: 1048576, messages });
      await service.handleRequest(ctx);
      const result = delivered(ctx);
      assert.equal(result.choices[0].message.content, 'ok');
      assert.equal(result.usage.prompt_tokens_details.multimodal_tokens.image, 11840);
    }
    assert.equal(sent.length, 2, '两次用户请求只发两次上游，不另做计数探测');
    assert.equal(sent[1], sent[0], '预算不依赖前一请求的图片用量');
    const summaries = logs.filter(line => line.includes('预算['));
    assert.equal(summaries.length, debugBudget ? 2 : 0);
    assert.doesNotMatch(logs.join('\n'), /图像实测|估值差|图像策略/);
    if (debugBudget) {
      assert.match(summaries[0], /图像估值=11776 图像余量=512 来源=dimensions/);
    }
    if (!debugBudget) assert.doesNotMatch(logs.join('\n'), /预算/);
    assert.match(logs.join('\n'), /token 13000\/3 累计 26\.0K\/6/);
  }
});

test('含图请求的无效输出参数不会导致日志抛错或泄漏参数内容', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  for (const max_tokens of [{ toString: null }, 'PRIVATE_PARAMETER'.repeat(1000), null]) {
    logs.length = 0;
    const { ctx, seen } = await run({ model: 'DeepSeek-V4.1-Flash', max_tokens,
      messages: imageMessages(1) }, [{ type: 'upstream-error', status: 400,
      body: { message: 'invalid max_tokens' }, raw: '' }], { debugBudget: true });
    assert.equal(seen.length, 1, '参数交给已有上游校验路径，日志本身不能中断请求');
    assert.equal(ctx.out.status, 400);
    const summary = logs.find(line => line.includes('预算['));
    assert.match(summary, /输出=无效/);
    assert.doesNotMatch(summary, /PRIVATE_PARAMETER|toString/);
    assert.ok(summary.length < 500);
  }
});

test('纯文本预算收缩和本地超限默认静默，调试明细不进入客户端响应', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  for (const debugBudget of [false, true]) {
    for (const stream of [false, true]) {
      logs.length = 0;
      const body = { model: 'DeepSeek-V4.1-Flash', stream, max_tokens: 1048576 };
      const { ctx, seen } = await run(body, [{ type: 'completion', body: completion('ok') }], { debugBudget });
      assert.equal(seen.length, 1);
      assert.ok(seen[0].max_tokens < body.max_tokens);
      assert.equal(delivered(ctx).choices[0].message.content, 'ok');
      assert.match(logs.join('\n'), / 200 \d+\.\d+s .*token 2\/3 累计 2\/3/);
      if (debugBudget) {
        assert.match(logs.join('\n'), /预算\[文本=\d+.*窗口=1048576/);
        assert.match(logs.join('\n'), /输出预算 \d+/);
      } else {
        assert.doesNotMatch(logs.join('\n'), /预算|估值|余量|图像策略/);
      }

      logs.length = 0;
      const rejected = await run(body, [], { debugBudget,
        limitsFor: () => ({ contextWindow: 1024, maxOutputTokens: 1048576 }),
      });
      assert.equal(rejected.seen.length, 0, '真实文本超限仍由本地拒绝');
      assert.equal(rejected.ctx.out.status, 413);
      assert.equal(rejected.ctx.out.message, '对话内容过长，请缩短对话或新建会话后重试。');
      if (debugBudget) {
        assert.match(logs.join('\n'), /预算\[.*窗口=1024/);
      } else {
        assert.doesNotMatch(logs.join('\n'), /预算|估值|余量|1024|1048576/);
      }
    }
  }
});

for (const stream of [false, true]) {
  test(`Qwen 未知图片采用软预算，不把繁忙误报成超限，流式=${stream}`, async () => {
    const { ctx, seen } = await run({ stream, max_tokens: 262144, messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/review.png' } }] },
    ] }, [{ type: 'upstream-error', status: 200, body: { errorMessage: '服务器繁忙' }, raw: '' }]);
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].max_tokens > 243000 && seen[0].max_tokens < 246000,
      '无法读取远程图片尺寸时扣除软估值，仍应发送上游');
    assert.strictEqual(ctx.out.status, 429);
    assert.match(ctx.out.message, /服务器繁忙/);
    assert.doesNotMatch(ctx.out.message, /预算|估值|校准|接近上下文上限|疑似上下文超限/);
  });

  test(`64 张小图只请求上游一次，保留图片与客户端输出预算，流式=${stream}`, async () => {
    for (const extra of [{}, { max_tokens: 4096 }, { reasoning_effort: 'none', max_tokens: 16 }]) {
      const messages = imageMessages(64);
      const { ctx, seen } = await run({ model: 'DeepSeek-V4.1-Flash', stream, messages, ...extra },
        [{ type: 'stream', body: completion('ok') }]);
      assert.strictEqual(seen.length, 1);
      assert.deepEqual(seen[0].messages, messages, '图片不得丢失或被替换');
      assert.strictEqual(seen[0].max_tokens, extra.max_tokens);
      assert.strictEqual(Object.hasOwn(seen[0], 'max_tokens'), Object.hasOwn(extra, 'max_tokens'));
      assert.strictEqual(delivered(ctx).choices[0].message.content, 'ok');
    }
  });

  test(`远程图片透传上游，并保留上游真实拒绝，流式=${stream}`, async () => {
    const unknownImages = [{ role: 'user', content: Array.from({ length: 64 }, () => ({
      type: 'image_url', image_url: { url: 'https://example.invalid/unmeasured.png' },
    })) }];
    for (const status of [200, 413, 429]) {
      const { ctx, seen } = await run({ model: 'DeepSeek-V4.1-Flash', stream, max_tokens: 4096,
        messages: unknownImages }, [{ type: 'upstream-error', status,
        body: { errorMessage: '服务器繁忙' }, raw: '' }]);
      assert.strictEqual(seen.length, 1, '图片不得触发本地拒绝或额外重试');
      assert.strictEqual(ctx.out.status, status === 200 ? 429 : status);
      if (status === 200) assert.match(ctx.out.message, /服务器繁忙/);
    }
  });

  test(`文字和工具已超过窗口仍在本地拒绝，流式=${stream}`, async () => {
    for (const messages of [[{ role: 'user', content: 'hi' }], imageMessages(64)]) {
      const { ctx, seen } = await run({ model: 'DeepSeek-V4.1-Flash', stream, max_tokens: 4096, tools, messages }, [],
        { limitsFor: () => ({ contextWindow: 1200, maxOutputTokens: 4096, promptTokenMarginRatio: 0 }) });
      assert.strictEqual(ctx.out.status, 413);
      assert.strictEqual(seen.length, 0, '文字和工具本身超限时不发起上游调用');
    }
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
  test(`HTTP 200 JSON 内嵌 R1 上下文错误交付 400 与标准 code，流式=${stream}`, async t => {
    // 2026-10-17 R1 边界探测的响应；本地预算已调整时，上游仍可能按实际输入拒绝。
    const message = "Requested token count exceeds the model's maximum context length of 163840 tokens. You requested a total of 163849 tokens: 9 tokens from the input messages and 163840 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.";
    const body = { error: { object: 'error', message, type: 'BadRequestError', param: null, code: 400 } };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests++;
      assert.equal(JSON.parse(options.body).stream, true);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const service = createProxyService({ config, tokenState: () => auth,
      upstreamClient: createUpstreamClient(config) });
    const ctx = context({ model: 'DeepSeek-R1-W8A8', stream, max_tokens: 163840 });
    await service.handleRequest(ctx);
    assert.equal(requests, 1, '明确参数错误不应重试');
    assert.equal(ctx.out.status, 400);
    assert.equal(ctx.out.type, 'invalid_request_error');
    assert.equal(ctx.out.code, 'context_length_exceeded');
    assert.ok(ctx.out.message.includes(message));
    assert.deepEqual(ctx.out.chunks, []);
    assert.deepEqual(ctx.out.lines, [], '不得伪装成成功 SSE 或发送 DONE');
  });
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
