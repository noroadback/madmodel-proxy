// 孤立工具参数前缀的有限重生成：真实本机 HTTP 请求、交付时序与取消。
// 凭据仅来自内存，不读取用户 token，不连接真实上游。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { listenTestHttp } = require('../scripts/listen-test-http');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');
const { createHttpServer, createTokenState } = require('../adapters/http-server');
const baseConfig = require('../config');

const MODEL = 'DeepSeek-V4.1-Flash';
// selector 有定义但不必填；不能因此把上游的孤立 { 擅自补成 {}。
const TOOLS = [{ type: 'function', function: { name: 'inspect_element',
  description: 'Read a page element without modifying it.',
  parameters: { type: 'object', properties: {
    selector: { type: 'string', description: 'CSS selector of the requested element.' },
  }, additionalProperties: false } } }];
const MESSAGES = [{ role: 'system', content: 'Use the declared tool when needed.' },
  { role: 'user', content: 'Read the element matching #submit.' }];
const BAD_ID = 'call_discarded_first';
const GOOD_ID = 'call_regenerated';
const FIRST_REASONING = '先检查当前页面状态再确定要操作的元素';
const FIRST_CONTENT = '\n \t';
const GOOD_REASONING = '已经定位目标';
const GOOD_CONTENT = '完成。';
const GOOD_ARGUMENTS = '{"selector":"#submit"}';
const FIRST_USAGE = { prompt_tokens: 101, completion_tokens: 103, total_tokens: 204 };
const GOOD_USAGE = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chunk = (delta, finish = null, usage) => ({
  id: 'chatcmpl-prefix-test', object: 'chat.completion.chunk', created: 1, model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
});
const tool = (args, id = BAD_ID, index = 0) => ({ index, id, type: 'function',
  function: { name: 'inspect_element', arguments: args } });
const toolChunk = (args, first = false, finish = null, usage, id = BAD_ID) => chunk({
  tool_calls: [first ? tool(args, id) : { index: 0, function: { arguments: args } }],
}, finish, usage);
const openSse = res => res.writeHead(200, { 'content-type': 'text/event-stream' });
const writeSse = (res, value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
const endSse = res => res.end('data: [DONE]\n\n');
const completion = (args, id, content, reasoning, usage, finish = 'tool_calls') => ({
  id: `chatcmpl-${id}`, object: 'chat.completion', model: MODEL, created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content,
    reasoning_content: reasoning, tool_calls: [{ ...tool(args, id), index: undefined }] },
  ...(finish === undefined ? {} : { finish_reason: finish }) }], usage,
});

function respondBad(res, format = 'sse', finish = 'tool_calls') {
  if (format === 'json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(' \t{\r\n', BAD_ID, FIRST_CONTENT, FIRST_REASONING, FIRST_USAGE, finish)));
    return;
  }
  openSse(res);
  writeSse(res, chunk({ reasoning_content: FIRST_REASONING }));
  writeSse(res, chunk({ content: FIRST_CONTENT }));
  writeSse(res, toolChunk('', true));
  writeSse(res, toolChunk(' \t{\r\n', false, finish, FIRST_USAGE));
  endSse(res);
}

function respondGood(res, format = 'sse', finish = 'tool_calls') {
  if (format === 'json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(GOOD_ARGUMENTS, GOOD_ID, GOOD_CONTENT, GOOD_REASONING, GOOD_USAGE, finish)));
    return;
  }
  openSse(res);
  writeSse(res, chunk({ content: GOOD_CONTENT, reasoning_content: GOOD_REASONING,
    tool_calls: [tool(GOOD_ARGUMENTS, GOOD_ID)] }, finish, GOOD_USAGE));
  endSse(res);
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function deadline(promise, ms = 3000, label = '等待测试事件超时') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate, label, ms = 3000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started >= ms) throw new Error(label);
    await delay(5);
  }
}

// 在真实 data 事件里记录帧到达时间；最终响应文本不能证明实时交付。
function openClient(url, extra = {}) {
  const body = JSON.stringify({ model: MODEL, messages: MESSAGES, tools: TOOLS,
    max_tokens: 512, stream: true, ...extra });
  const settled = deferred(), listeners = new Set();
  const client = { status: null, response: null, request: null, text: '', events: [],
    ended: false, error: null, done: settled.promise };
  let pending = '';
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const finish = error => {
    if (client.ended) return;
    client.ended = true;
    client.error = error || null;
    settled.resolve(client);
    notify();
  };
  client.cancel = () => { client.response?.destroy(); client.request.destroy(); };
  client.waitFor = (predicate, label = '客户端未收到预期帧', ms = 3000) => {
    let listener;
    const ready = new Promise((resolve, reject) => {
      listener = () => {
        if (predicate(client)) resolve(client);
        else if (client.ended) reject(new Error(`${label}；响应已结束：${client.text.slice(-400)}`));
      };
      listeners.add(listener);
      listener();
    });
    return deadline(ready, ms, label).finally(() => listeners.delete(listener));
  };
  client.request = http.request(url, { method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    client.status = res.statusCode;
    client.response = res;
    res.setEncoding('utf8');
    res.on('data', data => {
      client.text += data;
      pending += data;
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, boundary).replace(/\r/g, '');
        pending = pending.slice(boundary + 2);
        const lines = block.split('\n');
        const dataText = lines.filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim()).join('\n');
        if (!dataText) continue;
        const at = performance.now();
        if (dataText === '[DONE]') client.events.push({ done: true, at });
        else {
          try { client.events.push({ at, value: JSON.parse(dataText),
            event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() || null }); }
          catch (error) { client.error = error; }
        }
      }
      notify();
    });
    res.on('end', () => finish(client.error));
    res.on('error', finish);
    res.on('close', () => { if (!client.ended) finish(new Error('客户端响应提前关闭')); });
    notify();
  });
  client.request.on('error', finish);
  client.request.end(body);
  return client;
}

function values(client) { return client.events.filter(event => event.value).map(event => event.value); }
function modelFrames(client) { return values(client).filter(value => Array.isArray(value.choices)); }
function argumentDeltas(client) {
  return values(client).flatMap(value => value.choices?.[0]?.delta?.tool_calls || [])
    .map(call => call.function?.arguments).filter(value => typeof value === 'string');
}
function noSuccessTerminal(client) {
  assert.deepEqual(values(client).map(value => value.choices?.[0]?.finish_reason).filter(Boolean), []);
  assert.equal(values(client).filter(value => value.usage).length, 0, '失败不得交付 usage');
  assert.equal(client.events.filter(event => event.done).length, 0, '失败不得交付 DONE');
}
function assertFailure(client, expected = /工具调用参数不是有效 JSON/) {
  assert.equal(client.error, null, client.error?.message);
  if (client.status === 200) {
    const errors = client.events.filter(event => event.event === 'error');
    assert.equal(errors.length, 1, client.text);
    assert.match(errors[0].value.error.message, expected);
    noSuccessTerminal(client);
  } else {
    assert.equal(client.status, 502, client.text);
    assert.match(JSON.parse(client.text).error.message, expected);
  }
}
function assertSuccess(client, stream, args = GOOD_ARGUMENTS) {
  assert.equal(client.status, 200, client.text);
  assert.equal(client.error, null);
  if (!stream) {
    const body = JSON.parse(client.text), choice = body.choices[0];
    assert.equal(choice.message.tool_calls[0].function.arguments, args);
    assert.equal(choice.message.tool_calls[0].id, GOOD_ID);
    assert.equal(choice.message.content, GOOD_CONTENT);
    assert.equal(choice.message.reasoning_content, GOOD_REASONING);
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.deepEqual(body.usage, GOOD_USAGE);
    return;
  }
  assert.equal(argumentDeltas(client).join(''), args);
  const deltas = values(client).map(value => value.choices?.[0]?.delta || {});
  assert.deepEqual(deltas.flatMap(delta => delta.tool_calls || []).map(call => call.id).filter(Boolean), [GOOD_ID]);
  assert.equal(deltas.map(delta => delta.content || '').join(''), GOOD_CONTENT);
  assert.equal(deltas.map(delta => delta.reasoning_content || '').join(''), GOOD_REASONING);
  assert.deepEqual(values(client).map(value => value.choices?.[0]?.finish_reason).filter(Boolean), ['tool_calls']);
  assert.deepEqual(values(client).filter(value => value.usage).map(value => value.usage), [GOOD_USAGE]);
  assert.equal(client.events.filter(event => event.done).length, 1);
  assert.equal(client.events.at(-1).done, true);
  assert.equal(values(client).filter(value => value.error).length, 0);
}
function assertOriginalPayloads(h, expectedCount) {
  assert.equal(h.seen.length, expectedCount, '真实 HTTP 上游读取次数');
  assert.equal(h.stats.requests, expectedCount, 'upstream-client 调用次数');
  for (const sent of h.seen) {
    assert.deepEqual(sent.payload.messages, MESSAGES, '不得注入补救提示或失败调用');
    assert.deepEqual(sent.payload.tools, TOOLS, '可选 selector schema 必须完整保留');
    assert.equal(sent.payload.stream, true);
    assert.equal(sent.raw, h.seen[0].raw, '重生成必须重新发送同一归一后的请求体');
  }
}

async function harness(t, overrides = {}, deps = {}, decorateContext) {
  let handler = (_req, res) => { res.writeHead(500); res.end('missing local handler'); };
  const seen = [], sockets = new Set(), clients = new Set();
  const stats = { requests: 0, chunks: 0, results: [] };
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', data => { raw += data; });
    req.on('end', () => {
      const payload = JSON.parse(raw);
      seen.push({ raw, payload, headers: req.headers });
      handler(req, res, payload, seen.length);
    });
  });
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listenTestHttp(upstream);
  // HTTP adapter 在构造时固定可接受的 Host，因此监听前就要提供实际端口。
  const portProbe = http.createServer();
  const port = await listenTestHttp(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const config = { ...baseConfig, host: '127.0.0.1', port, apiKeys: [], tunnelMode: false,
    upstream: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
    upstreamHeaderTimeout: 3000, streamIdleTimeout: 3000, streamTotalTimeout: 6000,
    nonstreamTotalTimeout: 6000, inflightHardLimit: 1, dumpFailed: false,
    diagnosticsEnabled: false, debugBudget: false, ...overrides };
  const getToken = () => ({ token: 'local-prefix-test-token', expiresAt: Date.now() + 3600000 });
  const realClient = createUpstreamClient(config);
  const upstreamClient = { async request(args) {
    stats.requests++;
    const result = await realClient.request({ ...args, onChunk: async (obj, timing) => {
      stats.chunks++;
      if (args.onChunk) await args.onChunk(obj, timing);
    } });
    stats.results.push(result);
    return result;
  } };
  const service = createProxyService({ config, tokenState: createTokenState(getToken), upstreamClient, ...deps });
  const { server } = createHttpServer({ config, service: decorateContext ? { ...service,
    handleRequest(ctx) { decorateContext(ctx); return service.handleRequest(ctx); },
  } : service, getToken });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) client.cancel();
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, upstream].map(value => new Promise(resolve => {
      value.close(resolve);
      value.closeAllConnections?.();
    })));
  });
  return { config, seen, stats, set: value => { handler = value; }, open(extra) {
    const client = openClient(`http://127.0.0.1:${port}/v1/chat/completions`, extra);
    clients.add(client);
    return client;
  } };
}

test('工具参数仅孤立左花括号时的有限透明重生成 HTTP 回归', async t => {
  t.mock.method(console, 'log', () => {});

  await t.test('默认开启，默认仍是 incremental', () => {
    assert.equal(baseConfig.toolRetryEnabled, true);
    assert.equal(baseConfig.toolStreamMode, 'incremental');
    assert.equal(FIRST_REASONING.length, 18);
    assert.equal(TOOLS[0].function.parameters.required, undefined);
    const configPath = require.resolve('../config'), previous = process.env.PROXY_TOOL_RETRY;
    try {
      process.env.PROXY_TOOL_RETRY = '0';
      delete require.cache[configPath];
      assert.equal(require('../config').toolRetryEnabled, false);
    } finally {
      if (previous === undefined) delete process.env.PROXY_TOOL_RETRY;
      else process.env.PROXY_TOOL_RETRY = previous;
      delete require.cache[configPath];
    }
  });

  const routes = [
    { name: 'incremental SSE', format: 'sse', stream: true, config: {} },
    { name: 'buffered SSE', format: 'sse', stream: true, config: { toolStreamMode: 'buffered' } },
    { name: 'nonstream SSE', format: 'sse', stream: false, config: {} },
    { name: 'JSON 备用转 SSE', format: 'json', stream: true, config: {} },
    { name: 'JSON 备用直答', format: 'json', stream: false, config: {} },
  ];
  for (const route of routes) {
    await t.test(`${route.name}：丢弃首轮并原样重生成一次，selector 不丢失`, async t => {
      const h = await harness(t, route.config), second = deferred();
      h.set((_req, res, _payload, attempt) => {
        if (attempt === 1) respondBad(res, route.format);
        else second.resolve(res);
      });
      const client = h.open({ stream: route.stream });
      const res = await deadline(second.promise, 3000, '符合条件的第一轮未发起重生成');
      assert.equal(modelFrames(client).length, 0, '重生成开始前不能漏出首次模型帧');
      assert.equal(client.text, '', '第一次思考、空白正文、调用和 usage 均应丢弃');
      respondGood(res, route.format);
      await deadline(client.done);
      assertSuccess(client, route.stream);
      assert.ok(!client.text.includes(BAD_ID));
      assert.ok(!client.text.includes(FIRST_REASONING));
      assertOriginalPayloads(h, 2);
      assert.deepEqual(h.stats.results.map(result => result.type),
        route.format === 'sse' ? ['stream', 'stream'] : ['completion', 'completion']);
    });

    await t.test(`${route.name}：第二轮仍失败必须报错，绝不第三次或补 JSON`, async t => {
      const h = await harness(t, route.config);
      h.set((_req, res) => respondBad(res, route.format));
      const client = h.open({ stream: route.stream });
      await deadline(client.done);
      assertFailure(client);
      assertOriginalPayloads(h, 2);
      assert.ok(!client.text.includes('"arguments":"{}"'), '不得将可选字段工具补成空对象');
      noSuccessTerminal(client);
    });

    await t.test(`${route.name}：显式禁用时仅一次读取`, async t => {
      const h = await harness(t, { ...route.config, toolRetryEnabled: false });
      h.set((_req, res) => respondBad(res, route.format));
      const client = h.open({ stream: route.stream });
      await deadline(client.done);
      assertFailure(client);
      assertOriginalPayloads(h, 1);
    });
  }

  await t.test('现场 18 字思考、空白正文和 [空串, {] 在 175ms 内结束可透明重试', async t => {
    const h = await harness(t), first = deferred();
    h.set((_req, res, _payload, attempt) => {
      if (attempt > 1) return respondGood(res);
      openSse(res);
      writeSse(res, chunk({ reasoning_content: FIRST_REASONING }));
      writeSse(res, chunk({ content: FIRST_CONTENT }));
      writeSse(res, toolChunk('', true));
      first.resolve(res);
    });
    const client = h.open(), res = await deadline(first.promise);
    await until(() => h.stats.chunks === 3, '首轮上游帧未读取');
    await delay(175);
    assert.equal(modelFrames(client).length, 0);
    writeSse(res, toolChunk('{', false, 'stop', FIRST_USAGE));
    endSse(res);
    await deadline(client.done);
    assertSuccess(client, true);
    assertOriginalPayloads(h, 2);
  });

  for (const stream of [true, false]) {
    await t.test(`显式 stop 且完整 JSON 备用可重试，stream=${stream}`, async t => {
      const h = await harness(t);
      h.set((_req, res, _payload, attempt) => attempt === 1
        ? respondBad(res, 'json', 'stop') : respondGood(res, 'json', 'stop'));
      const client = h.open({ stream });
      await deadline(client.done);
      assertSuccess(client, stream);
      assertOriginalPayloads(h, 2);
    });
  }

  const rejected = [
    { name: 'length', finish: 'length' },
    { name: '没有 finish_reason', finish: null },
    { name: '没有 DONE', noDone: true },
    { name: '读取中网络中断', disconnect: true },
    { name: '同一索引 ID 冲突', idConflict: true },
    { name: '字段缺失', missingName: true },
    { name: '未声明 function 工具', tools: [] },
    { name: '已出现键值的半截参数', args: '{"selector":"#sub' },
    { name: '只有空白而没有左花括号', args: ' \t\r\n' },
    { name: '另一个调用参数非法', otherArguments: '[]' },
    { name: '多个调用重复 ID', duplicateId: true },
  ];
  for (const rejectedCase of rejected) {
    for (const stream of [true, false]) {
      await t.test(`${rejectedCase.name} 不重试，stream=${stream}`, async t => {
        const h = await harness(t), first = deferred();
        h.set((_req, res) => {
          openSse(res);
          const call = tool(rejectedCase.args ?? '{');
          if (rejectedCase.missingName) delete call.function.name;
          const calls = [call];
          if (rejectedCase.otherArguments) calls.push(tool(rejectedCase.otherArguments, 'call_other', 1));
          if (rejectedCase.duplicateId) calls.push(tool('{}', BAD_ID, 1));
          writeSse(res, chunk({ tool_calls: calls }));
          if (rejectedCase.idConflict) writeSse(res, chunk({ tool_calls: [
            { index: 0, id: 'call_conflict', function: { arguments: '' } },
          ] }));
          if (rejectedCase.disconnect) { first.resolve(res); return; }
          writeSse(res, chunk({}, Object.hasOwn(rejectedCase, 'finish') ? rejectedCase.finish : 'tool_calls', FIRST_USAGE));
          if (rejectedCase.noDone) res.end();
          else endSse(res);
        });
        const client = h.open({ stream, ...(rejectedCase.tools ? { tools: rejectedCase.tools } : {}) });
        if (rejectedCase.disconnect) {
          const res = await deadline(first.promise);
          await until(() => h.stats.chunks > 0, '中断前首帧未读取');
          res.destroy();
        }
        await deadline(client.done);
        assertFailure(client, /./);
        assert.equal(h.seen.length, 1);
        assert.equal(h.stats.requests, 1);
      });
    }
  }

  for (const finish of ['stop', 'tool_calls']) {
    for (const stream of [true, false]) {
      await t.test(`length 后再发 ${finish} 不能覆盖截断事实，stream=${stream}`, async t => {
        const h = await harness(t);
        h.set((_req, res) => {
          openSse(res);
          writeSse(res, toolChunk('{', true));
          writeSse(res, chunk({}, 'length'));
          writeSse(res, chunk({}, finish, FIRST_USAGE));
          endSse(res);
        });
        const client = h.open({ stream });
        await deadline(client.done);
        assertFailure(client);
        assertOriginalPayloads(h, 1);
      });
    }
  }

  await t.test('首个实际参数字符到达立即释放，长参数仍逐片实时交付', async t => {
    const h = await harness(t), opened = deferred();
    h.set((_req, res) => { openSse(res); writeSse(res, toolChunk('', true, null, undefined, GOOD_ID)); opened.resolve(res); });
    const client = h.open(), res = await deadline(opened.promise);
    await until(() => h.stats.chunks === 1, '工具头帧未读取');
    await delay(30);
    assert.equal(modelFrames(client).length, 0, '空参数头帧可短暂等待');
    writeSse(res, toolChunk('{'));
    await until(() => h.stats.chunks === 2, '左花括号帧未读取');
    assert.equal(modelFrames(client).length, 0);
    const actualAt = performance.now();
    writeSse(res, toolChunk('"selector":"'));
    await client.waitFor(value => argumentDeltas(value).join('') === '{"selector":"',
      '出现实际参数后仍在等待完整 JSON', 200);
    assert.ok(performance.now() - actualAt < 220, '实际参数必须在 250ms 窗口结束前释放');
    const pieces = ['a'.repeat(12000), 'b'.repeat(12000), 'c'.repeat(12000), '"}'];
    let expected = '{"selector":"';
    for (const piece of pieces) {
      expected += piece;
      writeSse(res, toolChunk(piece));
      await client.waitFor(value => argumentDeltas(value).join('') === expected,
        '长工具参数片段未在上游结束前抵达客户端');
      assert.equal(client.ended, false);
      noSuccessTerminal(client);
    }
    writeSse(res, chunk({ content: GOOD_CONTENT, reasoning_content: GOOD_REASONING }, 'tool_calls', GOOD_USAGE));
    endSse(res);
    await deadline(client.done);
    assertSuccess(client, true, expected);
    assertOriginalPayloads(h, 1);
  });

  await t.test('实际参数交付后即使另一个调用仅 { 也不得重新生成', async t => {
    const h = await harness(t), opened = deferred();
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, toolChunk(GOOD_ARGUMENTS, true));
      opened.resolve(res);
    });
    const client = h.open(), res = await deadline(opened.promise);
    await client.waitFor(value => argumentDeltas(value).join('') === GOOD_ARGUMENTS);
    writeSse(res, chunk({ tool_calls: [tool('{', 'call_late_prefix', 1)] }, 'tool_calls', FIRST_USAGE));
    endSse(res);
    await deadline(client.done);
    assertFailure(client);
    assertOriginalPayloads(h, 1);
  });

  await t.test('250ms 从首帧起算，等待新帧期间主动释放，后续孤立 { 不再重试', async t => {
    const h = await harness(t), opened = deferred();
    h.set((_req, res) => { openSse(res); opened.resolve(res); });
    const client = h.open(), res = await deadline(opened.promise);
    const firstAt = performance.now();
    writeSse(res, chunk({ reasoning_content: FIRST_REASONING }));
    await until(() => h.stats.chunks === 1, '首帧未读取');
    await delay(100);
    writeSse(res, toolChunk('', true));
    await delay(65);
    assert.equal(modelFrames(client).length, 0, '250ms 之前不得提前冲刷孤立前缀');
    await client.waitFor(value => value.text.includes(FIRST_REASONING), '250ms 后无后续帧时未主动冲刷', 350);
    const firstEvent = client.events.find(event => event.value?.choices);
    assert.ok(firstEvent.at - firstAt >= 220, `窗口过早结束：${firstEvent.at - firstAt}ms`);
    assert.ok(firstEvent.at - firstAt < 500, `窗口没有及时结束：${firstEvent.at - firstAt}ms`);
    assert.equal(client.ended, false);
    writeSse(res, toolChunk('{', false, 'tool_calls', FIRST_USAGE));
    endSse(res);
    await deadline(client.done);
    assertFailure(client);
    assertOriginalPayloads(h, 1);
  });

  for (const limit of ['bytes', 'frames']) {
    await t.test(`${limit} 达到前缀缓冲界限后及时释放且不重试`, async t => {
      const h = await harness(t), opened = deferred();
      h.set((_req, res) => { openSse(res); opened.resolve(res); });
      const client = h.open(), res = await deadline(opened.promise);
      const started = performance.now();
      writeSse(res, toolChunk('{', true));
      if (limit === 'bytes') writeSse(res, chunk({ content: ' '.repeat(9000) }));
      else for (let i = 0; i < 32; i++) writeSse(res, chunk({ content: ' ' }));
      await client.waitFor(value => argumentDeltas(value).join('') === '{', '缓冲界限未解除暂存', 220);
      assert.ok(performance.now() - started < 240, '不能等到时间阈值才释放容量超限的缓冲');
      assert.equal(client.ended, false);
      writeSse(res, chunk({}, 'tool_calls', FIRST_USAGE));
      endSse(res);
      await deadline(client.done);
      assertFailure(client);
      assertOriginalPayloads(h, 1);
    });
  }

  for (const stage of ['DONE 后最终交付', '上游总时限']) {
    await t.test(`250ms 主动冲刷遇背压，${stage}仍能解除等待并归还槽位`, async t => {
      const blocked = deferred(), opened = deferred();
      let blockedWrites = 0, cancelledWrites = 0;
      const h = await harness(t, { streamTotalTimeout: 450 }, {}, ctx => {
        const payload = JSON.parse(ctx.rawBody);
        if (payload.messages[0].content === 'probe') return;
        const write = ctx.writeSseLine;
        ctx.writeSseLine = line => {
          if (!line.includes('"delta"')) return write(line);
          blockedWrites++;
          blocked.resolve();
          return new Promise((_, reject) => {
            const abort = () => { cancelledWrites++; reject(new Error('受控慢客户端已取消')); };
            if (ctx.abortController.signal.aborted) abort();
            else ctx.abortController.signal.addEventListener('abort', abort, { once: true });
          });
        };
      });
      h.set((_req, res, payload) => {
        openSse(res);
        if (payload.messages[0].content === 'probe') {
          writeSse(res, chunk({ content: 'ok' }, 'stop', GOOD_USAGE));
          return endSse(res);
        }
        // 正文也属于前缀小窗口；先提供终态，DONE 稍后独立到达。
        writeSse(res, chunk({ content: '等待交付' }, 'stop', GOOD_USAGE));
        opened.resolve(res);
      });
      const client = h.open(), res = await deadline(opened.promise);
      await deadline(blocked.promise, 1500, '250ms 定时冲刷未进入受控写入');
      if (stage === 'DONE 后最终交付') endSse(res);
      await deadline(client.done, 1800, '异步前缀冲刷的写等待没有受时限保护');
      assertFailure(client, /超时/);
      assert.equal(blockedWrites, 1, '终止后不得继续交付模型帧');
      assert.equal(cancelledWrites, 1, '必须中止尚在等待的写入');
      assert.equal(h.seen.length, 1, '背压失败不属于工具重生成条件');
      await until(() => h.stats.results.length === 1, '上游未结算');
      assert.equal(h.stats.results[0].type, stage === 'DONE 后最终交付' ? 'stream' : 'timeout');
      const probe = h.open({ messages: [{ role: 'user', content: 'probe' }], tools: [] });
      await deadline(probe.done, 1500, '背压收尾后并发槽未归还');
      assert.equal(probe.status, 200, probe.text);
      assert.ok(probe.text.includes('"content":"ok"'));
      assert.equal(probe.events.filter(event => event.done).length, 1);
      assert.equal(h.seen.length, 2, '探测请求必须真正到达上游');
    });
  }

  for (const stage of ['暂存期间', '第二轮开始后']) {
    await t.test(`客户端在${stage}取消，不重试并关闭本机上游`, async t => {
      const h = await harness(t), opened = deferred(), closed = deferred();
      h.set((_req, res, _payload, attempt) => {
        if (stage === '第二轮开始后' && attempt === 1) return respondBad(res);
        res.on('close', () => closed.resolve());
        openSse(res);
        writeSse(res, toolChunk('', true, null, undefined, stage === '第二轮开始后' ? GOOD_ID : BAD_ID));
        opened.resolve(res);
      });
      const client = h.open();
      await deadline(opened.promise, 3000, '预期轮次未开始');
      await until(() => h.stats.chunks > (stage === '第二轮开始后' ? 4 : 0), '待取消上游帧未读取');
      client.cancel();
      await deadline(client.done);
      await deadline(closed.promise, 1500, '取消未关闭上游读取');
      await until(() => h.stats.results.length === h.stats.requests, '取消未结算 upstream-client');
      await delay(300);
      const count = stage === '第二轮开始后' ? 2 : 1;
      assert.equal(h.stats.requests, count);
      assert.equal(h.seen.length, count);
      assert.equal(h.stats.results.at(-1).type, 'aborted');
      if (stage === '暂存期间') assert.equal(modelFrames(client).length, 0);
      else {
        assert.ok(!client.text.includes(BAD_ID), '取消前也不能交付首次失败调用');
        assert.ok(!client.text.includes(FIRST_REASONING), '取消前也不能交付首次失败思考');
      }
      noSuccessTerminal(client);
    });
  }

  await t.test('非流式两轮共用 400ms 预算，重生成不得重置总时限', async t => {
    const h = await harness(t, { nonstreamTotalTimeout: 400 });
    const secondStarted = deferred(), secondClosed = deferred(), timers = new Set();
    let sentSecondSuccess = false;
    t.after(() => { for (const timer of timers) clearTimeout(timer); });
    h.set((_req, res, _payload, attempt) => {
      if (attempt === 1) {
        const timer = setTimeout(() => respondBad(res), 150);
        timers.add(timer);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      openSse(res);
      res.flushHeaders();
      const timer = setTimeout(() => {
        sentSecondSuccess = true;
        writeSse(res, chunk({ content: GOOD_CONTENT, reasoning_content: GOOD_REASONING,
          tool_calls: [tool(GOOD_ARGUMENTS, GOOD_ID)] }, 'tool_calls', GOOD_USAGE));
        endSse(res);
      }, 350);
      timers.add(timer);
      res.once('close', () => { clearTimeout(timer); secondClosed.resolve(); });
      secondStarted.resolve();
    });
    const client = h.open({ stream: false });
    await deadline(secondStarted.promise, 1500, '首轮孤立前缀没有触发重生成');
    await deadline(client.done, 1500, '共享非流式时限没有结束请求');
    assert.equal(client.status, 504, client.text);
    assert.equal(client.error, null);
    assert.match(JSON.parse(client.text).error.message, /生成超时/);
    await deadline(secondClosed.promise, 1000, '非流式预算用尽后未取消第二轮上游');
    await until(() => h.stats.results.length === 2, '第二轮取消未结算');
    assert.equal(sentSecondSuccess, false, '两轮总耗时超过 400ms 前必须取消第二轮');
    assert.deepEqual(h.stats.results.map(result => result.type), ['stream', 'aborted']);
    assertOriginalPayloads(h, 2);
    assert.ok(!client.text.includes(BAD_ID));
    assert.ok(!client.text.includes(GOOD_ID));
    noSuccessTerminal(client);
  });

  await t.test('tool_choice=none 禁用工具重生成和首段短暂缓冲', async t => {
    const h = await harness(t), opened = deferred();
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, chunk({ reasoning_content: FIRST_REASONING }));
      writeSse(res, toolChunk('{', true));
      opened.resolve(res);
    });
    const client = h.open({ tool_choice: 'none' }), res = await deadline(opened.promise);
    await client.waitFor(value => value.text.includes(FIRST_REASONING),
      'tool_choice=none 的正文或思考仍被首段窗口扣留', 200);
    assert.equal(client.ended, false);
    writeSse(res, chunk({}, 'tool_calls', FIRST_USAGE));
    endSse(res);
    await deadline(client.done);
    assertFailure(client);
    assertOriginalPayloads(h, 1);
    assert.equal(h.seen[0].payload.tool_choice, 'none');
  });

  for (const stream of [true, false]) {
    await t.test(`工具重生成计数跨认证更新保留，stream=${stream}`, async t => {
      let waits = 0;
      const h = await harness(t, { tunnelMode: true }, { waitForCredentials: async () => {
        waits++;
        return { token: 'local-refreshed-token', cookie: 'session=local-refreshed' };
      } });
      h.set((_req, res, _payload, attempt) => {
        if (attempt === 2) { res.writeHead(302, { location: '/login' }); res.end(); }
        else respondBad(res);
      });
      const client = h.open({ stream });
      await deadline(client.done);
      assertFailure(client);
      assert.equal(waits, 1);
      assertOriginalPayloads(h, 3);
      assert.equal(h.seen[2].headers.authorization, 'Bearer local-refreshed-token');
      assert.equal(h.seen[2].headers.cookie, 'session=local-refreshed');
    });
  }
});
