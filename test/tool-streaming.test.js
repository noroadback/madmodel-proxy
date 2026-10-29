// 原生工具参数实时交付：真实 HTTP 出口、失败终态、取消与背压收尾。
// 只连接本机替身上游，凭据来自内存；不读取用户 token 或访问学校服务。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { listenTestHttp } = require('../scripts/listen-test-http');
const { createUpstreamClient } = require('../core/upstream-client');
const { createProxyService } = require('../core/proxy-service');
const { createHttpServer, createTokenState } = require('../adapters/http-server');

function reloadConfig(mode) {
  const previous = process.env.PROXY_TOOL_STREAM;
  const configPath = require.resolve('../config');
  if (mode === undefined) delete process.env.PROXY_TOOL_STREAM;
  else process.env.PROXY_TOOL_STREAM = mode;
  delete require.cache[configPath];
  try { return require('../config'); }
  finally {
    if (previous === undefined) delete process.env.PROXY_TOOL_STREAM;
    else process.env.PROXY_TOOL_STREAM = previous;
    delete require.cache[configPath];
  }
}

const baseConfig = reloadConfig();
const MODEL = 'DeepSeek-V4.1-Flash';
const TOOLS = [{ type: 'function', function: { name: 'Bash',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
const USAGE = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
const CALL = { index: 0, id: 'call_stream', type: 'function',
  function: { name: 'Bash', arguments: '{"command":"Get-Location"}' } };
const chunk = (delta, finish = null, usage) => ({
  id: 'chatcmpl-stream-test', object: 'chat.completion.chunk', created: 1, model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
});
const toolChunk = (argumentsDelta, first = false, finish = null, usage) => chunk({
  tool_calls: [first ? { ...CALL, function: { name: 'Bash', arguments: argumentsDelta } }
    : { index: 0, function: { arguments: argumentsDelta } }],
}, finish, usage);
const writeSse = (res, value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
const openSse = res => res.writeHead(200, { 'content-type': 'text/event-stream' });
const endSse = res => res.end('data: [DONE]\n\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('工具失败诊断保留结束原因与转发一致性，不记录命令原文', async t => {
  const h = await harness(t);
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  h.set((_req, res) => {
    openSse(res);
    writeSse(res, toolChunk('{"command":"', true));
    writeSse(res, toolChunk('private-argument-content', false, 'length', USAGE));
    endSse(res);
  });
  const client = h.open();
  await client.done;
  assertStreamError(client, /不是有效 JSON/);
  const line = logs.find(value => value.includes('stream-invalid-tool-call'));
  assert.ok(line, '应有工具校验失败日志');
  assert.match(line, /上游结束=length/);
  assert.match(line, /参数转发=一致/);
  assert.match(line, /片段=2/);
  assert.match(line, /流内错误=502/);
  assert.ok(!line.includes('private-argument-content'));
});

test('同一工具索引变更 ID 时明确失败，不发送成功终态', async t => {
  const h = await harness(t);
  h.set((_req, res) => {
    openSse(res);
    writeSse(res, toolChunk('{"command":', true));
    writeSse(res, chunk({ tool_calls: [{ index: 0, id: 'different-id', function: { arguments: '"ok"}' } }] }));
    endSse(res);
  });
  const client = h.open();
  await client.done;
  assertStreamError(client, /ID/);
});

test('不同索引重复调用 ID 时拒绝确认调用成功', async t => {
  const h = await harness(t);
  h.set((_req, res) => {
    openSse(res);
    writeSse(res, chunk({ tool_calls: [CALL, { ...CALL, index: 1 }] }, 'tool_calls', USAGE));
    endSse(res);
  });
  const client = h.open();
  await client.done;
  assertStreamError(client, /不是有效 JSON/);
});

test('非法 UTF-8 的工具参数流不会被替换字符修成可执行调用', async t => {
  const h = await harness(t);
  const upstream = deferred();
  h.set((_req, res) => {
    openSse(res);
    writeSse(res, chunk({ content: '开始' }));
    upstream.resolve(res);
  });
  const client = h.open();
  await client.waitFor(c => c.text.includes('开始'));
  const res = await upstream.promise;
  res.write(Buffer.concat([Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"Bash","arguments":"'),
    Buffer.from([0xff]), Buffer.from('"}}]}}]}\n\n')]));
  endSse(res);
  await client.done;
  assertStreamError(client, /UTF-8/);
  assert.deepEqual(argumentDeltas(client), []);
});

test('200 JSON 备用响应也拒绝非法 UTF-8 的工具参数', async t => {
  for (const stream of [true, false]) {
    await t.test(`客户端 stream=${stream}`, async t => {
      const h = await harness(t);
      h.set((_req, res) => {
        const body = Buffer.from(JSON.stringify({ id: 'json-corrupt', choices: [{ index: 0,
          message: { role: 'assistant', tool_calls: [{ ...CALL, index: undefined,
            function: { name: 'Bash', arguments: '{"command":"private-marker"}' } }] },
          finish_reason: 'tool_calls' }] }));
        const offset = body.indexOf('private-marker');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.concat([body.subarray(0, offset), Buffer.from([0xff]),
          body.subarray(offset + 'private-marker'.length)]));
      });
      const client = h.open({ stream });
      await client.done;
      assert.equal(client.status, 502, client.text);
      assert.match(JSON.parse(client.text).error.message, /JSON 响应含非法 UTF-8/);
      assert.deepEqual(argumentDeltas(client), []);
      assert.ok(!client.text.includes('private-marker'));
      assert.ok(!client.text.includes('call_stream'));
    });
  }
});

test('HTTP 入口拒绝非法 UTF-8 和 JSON，不调用上游或回显原文', async t => {
  const h = await harness(t);
  let upstreamCalls = 0;
  h.set((_req, res) => { upstreamCalls++; openSse(res); endSse(res); });
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  for (const body of [
    Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xff]), Buffer.from('private-body"}')]),
    Buffer.from('{"model":"DeepSeek-V4.1-Flash","private":"private-body" broken}'),
  ]) {
    const response = await deadline(new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.config.port,
        path: '/v1/chat/completions', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', value => { text += value; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end(body);
    }));
    assert.equal(response.status, 400, response.text);
    assert.ok(!response.text.includes('private-body'));
  }
  assert.equal(upstreamCalls, 0);
  assert.ok(logs.length >= 2);
  assert.ok(logs.every(line => !line.includes('private-body')));
});

test('完整 HTTP 工具失败取证按真实索引核对原始参数，仅记录脱敏结果', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const stream of [true, false]) {
    await t.test(`stream=${stream}`, async t => {
      const tokenFile = path.join(path.dirname(baseConfig.tokenFile), 'diagnostic-tool-flow', String(stream), 'token.json');
      const file = path.join(path.dirname(tokenFile), 'failure-diagnostics.jsonl');
      const h = await harness(t, { diagnosticsEnabled: true, tokenFile });
      const logs = [];
      t.mock.method(console, 'log', line => logs.push(line));
      h.set((_req, res) => {
        openSse(res);
        writeSse(res, chunk({ tool_calls: [{ ...CALL, index: 3,
          function: { name: 'Bash', arguments: '{"command":"' } }] }));
        writeSse(res, chunk({ tool_calls: [{ index: 3,
          function: { arguments: 'private-argument-marker' } }] }, 'length', USAGE));
        endSse(res);
      });
      const client = h.open({ stream });
      await deadline(client.done);
      if (stream) assertStreamError(client, /不是有效 JSON/);
      else assert.equal(client.status, 502, client.text);
      const text = fs.readFileSync(file, 'utf8');
      const records = text.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(records.length, 1, '同一次失败只保存一条取证记录');
      assert.equal(records[0].kind, 'invalid-tool-call');
      assert.equal(records[0].argumentComparison, 'match');
      assert.equal(records[0].wire.sawDone, true);
      assert.equal(records[0].wire.finishReason, 'length');
      assert.equal(records[0].wire.tools[0].index, 3, '稀疏索引不能按数组顺序改写为0');
      assert.ok(logs.some(line => line.includes(records[0].requestId)));
      assert.ok(!text.includes('private-argument-marker'));
      assert.ok(!text.includes('local-stream-test-token'));
      assert.ok(!text.includes('"hash"'));
    });
  }
});

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
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(label);
    await delay(20);
  }
}
async function freePort() {
  const server = net.createServer();
  const port = await listenTestHttp(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

// 每个 SSE event 都在真正抵达客户端时解析，不能用最终 r.text() 推断实时性。
function openClient(url, extra = {}, onData, onResponse) {
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'test' }],
    tools: TOOLS, max_tokens: 512, stream: true, ...extra });
  const completed = deferred();
  const listeners = new Set();
  const client = { status: null, text: '', events: [], ended: false, response: null, error: null,
    done: completed.promise, request: null };
  let pending = '';
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const settle = error => {
    if (client.ended) return;
    client.ended = true;
    client.error = error || null;
    completed.resolve(client);
    notify();
  };
  client.waitFor = (predicate, label = '客户端未收到预期帧', ms = 3000) => {
    let listener;
    const ready = new Promise((resolve, reject) => {
      listener = () => {
        if (predicate(client)) resolve(client);
        else if (client.ended) reject(new Error(`${label}；响应已结束：${client.text.slice(-600)}`));
      };
      listeners.add(listener);
      listener();
    });
    return deadline(ready, ms, label).finally(() => listeners.delete(listener));
  };
  client.cancel = () => {
    if (client.response) client.response.destroy();
    client.request.destroy();
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
        const dataText = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!dataText) continue;
        if (dataText === '[DONE]') client.events.push({ done: true });
        else {
          try {
            client.events.push({ event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() || null,
              value: JSON.parse(dataText) });
          } catch (error) { client.error = error; }
        }
      }
      if (onData) onData(client);
      notify();
    });
    res.on('end', () => settle(client.error));
    res.on('error', settle);
    res.on('close', () => { if (!client.ended) settle(new Error('客户端响应提前关闭')); });
    if (onResponse) onResponse(client);
  });
  client.request.on('error', settle);
  client.request.end(body);
  return client;
}

function values(client) { return client.events.filter(event => event.value).map(event => event.value); }
function argumentDeltas(client) {
  return values(client).flatMap(value => value.choices?.[0]?.delta?.tool_calls || [])
    .map(call => call.function?.arguments).filter(value => typeof value === 'string');
}
function finishes(client) { return values(client).map(value => value.choices?.[0]?.finish_reason).filter(Boolean); }
function assertNoTerminal(client) {
  assert.deepEqual(finishes(client), [], '校验完成前不得交付 finish_reason');
  assert.equal(values(client).filter(value => value.usage).length, 0, '校验完成前不得交付 usage');
  assert.equal(client.events.filter(event => event.done).length, 0, '校验完成前不得交付 DONE');
}
function assertStreamError(client, expectedMessage) {
  assert.equal(client.status, 200, client.text.slice(-600));
  assert.equal(client.error, null, '失败必须以合法 SSE error 交付');
  const errors = client.events.filter(event => event.event === 'error');
  assert.equal(errors.length, 1, client.text.slice(-600));
  assert.equal(typeof errors[0].value?.error?.message, 'string');
  assert.equal(typeof errors[0].value?.error?.type, 'string');
  assert.ok(errors[0].value?.error?.code != null);
  if (expectedMessage) assert.match(errors[0].value.error.message, expectedMessage);
  assertNoTerminal(client);
}
function assertSuccess(client, expectedArguments = CALL.function.arguments, expectedFinish = 'tool_calls') {
  assert.equal(client.status, 200, client.text.slice(-600));
  assert.equal(client.error, null);
  assert.equal(argumentDeltas(client).join(''), expectedArguments);
  assert.deepEqual(finishes(client), [expectedFinish]);
  assert.equal(client.events.filter(event => event.done).length, 1);
  assert.equal(client.events.at(-1).done, true);
  assert.equal(values(client).filter(value => value.error).length, 0);
}

async function harness(t, overrides = {}, decorateContext) {
  let handler = (_req, res) => { res.writeHead(500); res.end('mock handler missing'); };
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', value => { text += value; });
    req.on('end', () => handler(req, res, JSON.parse(text)));
  });
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listenTestHttp(upstream);
  const port = await freePort();
  const config = { ...baseConfig, host: '127.0.0.1', port, apiKeys: [], tunnelMode: false,
    upstream: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
    upstreamHeaderTimeout: 3000, streamIdleTimeout: 3000, streamTotalTimeout: 6000,
    inflightHardLimit: 1, dumpFailed: false, debugBudget: false, ...overrides };
  const getToken = () => ({ token: 'local-stream-test-token', expiresAt: Date.now() + 3600000 });
  const realClient = createUpstreamClient(config);
  const stats = { results: [], activeDeliveries: 0, deliveryStarted: 0, deliveryAgeAtFinish: 0, maxDeliveryMs: 0 };
  // 观察真实背压等待；保持原始 onChunk await 和 upstream-client 行为。
  const upstreamClient = { async request(args) {
    const result = await realClient.request({ ...args, onChunk: async (value, metadata) => {
      stats.activeDeliveries++;
      stats.deliveryStarted = Date.now();
      try { if (args.onChunk) await args.onChunk(value, metadata); }
      finally {
        stats.maxDeliveryMs = Math.max(stats.maxDeliveryMs, Date.now() - stats.deliveryStarted);
        stats.activeDeliveries--;
      }
    } });
    if (stats.activeDeliveries) stats.deliveryAgeAtFinish = Date.now() - stats.deliveryStarted;
    stats.results.push(result);
    return result;
  } };
  const service = createProxyService({ config, tokenState: createTokenState(getToken), upstreamClient });
  const { server } = createHttpServer({ config, service: decorateContext ? {
    ...service,
    handleRequest(ctx) { decorateContext(ctx); return service.handleRequest(ctx); },
  } : service, getToken });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.cancel();
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, upstream].map(value => new Promise(resolve => {
      value.close(resolve);
      if (value.closeAllConnections) value.closeAllConnections();
    })));
  });
  return { config, stats, set: value => { handler = value; },
    open(extra, onData, onResponse) {
      const client = openClient(`http://127.0.0.1:${port}/v1/chat/completions`, extra, onData, onResponse);
      clients.add(client);
      return client;
    },
  };
}

test('原生工具参数 streaming 完整 HTTP 回归', async t => {
  t.mock.method(console, 'log', () => {});

  await t.test('配置默认 incremental，buffered 仅显式启用', () => {
    assert.equal(reloadConfig().toolStreamMode, 'incremental');
    assert.equal(reloadConfig('buffered').toolStreamMode, 'buffered');
    assert.equal(reloadConfig('incremental').toolStreamMode, 'incremental');
    assert.equal(reloadConfig('unknown').toolStreamMode, 'incremental');
  });

  await t.test('DONE 后的 error 事件字段跨网络块时，不能提前确认工具调用', async t => {
    const h = await harness(t);
    const sentDoneLine = deferred();
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, toolChunk(CALL.function.arguments, true, 'tool_calls', USAGE));
      res.write('data: [DONE]\n');
      sentDoneLine.resolve(res);
    });
    const client = h.open();
    await client.waitFor(value => argumentDeltas(value).length === 1);
    const res = await deadline(sentDoneLine.promise);
    await delay(60);
    assertNoTerminal(client);
    assert.equal(client.ended, false, '当前 SSE 事件未结束时不能把 DONE 当作成功');
    res.end('event: error\n\n');
    await deadline(client.done);
    assertStreamError(client, /错误/);
  });

  for (const stage of ['json-chunk', 'json-usage', 'stream-done']) {
    await t.test(`最终交付时限覆盖 ${stage} 的受控背压并归还槽位`, async t => {
      const blocked = deferred();
      let blockedWrites = 0, cancelledWrites = 0;
      const h = await harness(t, { streamTotalTimeout: 100 }, ctx => {
        const payload = JSON.parse(ctx.rawBody);
        if (payload.messages[0].content === 'probe') return;
        const write = ctx.writeSseLine;
        ctx.writeSseLine = line => {
          const target = stage === 'stream-done' ? line.includes('[DONE]')
            : stage === 'json-usage' ? line.includes('"usage"') : line.includes('"delta"');
          if (!target) return write(line);
          blockedWrites++;
          blocked.resolve();
          return new Promise((resolve, reject) => {
            const cancelled = () => { cancelledWrites++; reject(new Error('受控交付已取消')); };
            if (ctx.abortController.signal.aborted) cancelled();
            else ctx.abortController.signal.addEventListener('abort', cancelled, { once: true });
          });
        };
      });
      h.set((_req, res, payload) => {
        if (payload.messages[0].content === 'probe' || stage === 'stream-done') {
          openSse(res);
          writeSse(res, chunk({ content: 'ok' }, 'stop', USAGE));
          return endSse(res);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'final-delivery', model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: USAGE }));
      });
      const client = h.open();
      await deadline(blocked.promise);
      await deadline(client.done, 1500, '上游完成后的背压未受交付时限保护');
      assert.equal(client.status, 200);
      assert.equal(blockedWrites, 1, '超时后不得继续写出其他帧');
      assert.equal(cancelledWrites, 1, '交付超时必须解除等待');
      assert.equal(client.events.filter(event => event.event === 'error').length, 1);
      assert.equal(client.events.filter(event => event.done).length, 0);
      assert.match(client.text, /交付回复超时/);
      const probe = h.open({ messages: [{ role: 'user', content: 'probe' }] });
      await deadline(probe.done);
      assert.equal(probe.status, 200, '最终交付失败后必须归还并发槽位');
    });
  }

  await t.test('每片工具参数在上游 DONE 之前立即到达，混合最终帧只交付一次', async t => {
    const h = await harness(t);
    const opened = deferred();
    h.set((_req, res) => { openSse(res); opened.resolve(res); });
    const client = h.open();
    const res = await deadline(opened.promise);
    const fragments = ['{"command":"', 'Get-', 'Location"}'];
    try {
      for (let index = 0; index < fragments.length; index++) {
        const frame = toolChunk(fragments[index], index === 0);
        if (index === fragments.length - 1) {
          Object.assign(frame.choices[0].delta, { content: '调用准备完成。', reasoning: '已经确认路径。' });
          frame.choices[0].finish_reason = 'stop';
          frame.usage = USAGE;
        }
        writeSse(res, frame);
        await client.waitFor(value => argumentDeltas(value).length === index + 1, `第 ${index + 1} 片参数被缓冲`);
        assert.deepEqual(argumentDeltas(client), fragments.slice(0, index + 1));
        assertNoTerminal(client);
      }
      await delay(60);
      assert.equal(client.ended, false, '上游未发 DONE，代理不能完成响应');
      assertNoTerminal(client);
    } finally { endSse(res); }
    await deadline(client.done);
    assertSuccess(client);
    assert.deepEqual(argumentDeltas(client), fragments, '终态冲刷不得重复最后一片参数');
    const output = values(client);
    assert.equal(output.map(value => value.choices?.[0]?.delta?.content || '').join(''), '调用准备完成。');
    assert.equal(output.map(value => value.choices?.[0]?.delta?.reasoning_content || '').join(''), '已经确认路径。');
    assert.equal(output.filter(value => value.usage).length, 1);
    assert.deepEqual(output.find(value => value.usage).usage, USAGE);
    assert.deepEqual(output.find(value => value.choices?.[0]?.finish_reason).choices[0].delta, {});
  });

  await t.test('合法参数仅以 DONE 收尾时补独立 finish，length 原样保留', async t => {
    for (const finish of [null, 'length']) {
      await t.test(finish || '缺 finish_reason', async t => {
        const h = await harness(t);
        h.set((_req, res) => { openSse(res); writeSse(res, chunk({ tool_calls: [CALL] }, finish)); endSse(res); });
        const client = h.open();
        await deadline(client.done);
        assertSuccess(client, CALL.function.arguments, finish || 'tool_calls');
      });
    }
  });

  const failures = [
    ['坏工具 JSON，即使上游发送 DONE', { arguments: '{"command":', message: /不是有效 JSON/,
      finish: res => endSse(res) }],
    ['上游 EOF 缺 DONE', { message: /截断/, finish: res => res.end() }],
    ['上游内嵌 error', { message: /mock stream failure/,
      finish: res => { writeSse(res, { error: { message: 'mock stream failure', code: 'mock_error' } }); endSse(res); } }],
    ['上游 event:error 携带裸错误对象', { message: /mock stream failure/,
      finish: res => {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'mock stream failure',
          type: 'mock_error', code: 502 })}\n\n`);
        endSse(res);
      } }],
    ['上游 event:error 位于 data 行之后', { message: /mock stream failure/,
      finish: res => {
        res.write(`data: ${JSON.stringify({ message: 'mock stream failure',
          type: 'mock_error', code: 502 })}\nevent: error\n\n`);
        endSse(res);
      } }],
    ['上游 errorMessage 与 choices:[] 同帧', { message: /mock stream failure/,
      finish: res => { writeSse(res, { errorMessage: 'mock stream failure', choices: [] }); endSse(res); } }],
    ['上游坏 SSE JSON', { message: /坏帧/,
      finish: res => res.end('data: {bad-json}\n\ndata: [DONE]\n\n') }],
    ['上游 idle timeout', { config: { streamIdleTimeout: 120 }, message: /无数据/, finish() {} }],
    ['上游 total timeout，持续字节不掩盖总时限', {
      config: { streamIdleTimeout: 160, streamTotalTimeout: 300 }, message: /超时/,
      finish(res) {
        const timer = setInterval(() => { if (!res.destroyed) res.write(': upstream heartbeat\n\n'); }, 25);
        res.once('close', () => clearInterval(timer));
      },
    }],
  ];
  for (const [name, failure] of failures) {
    await t.test(`${name}：已交付参数后发明确 SSE error，丢弃所有成功收尾`, async t => {
      const h = await harness(t, failure.config);
      h.set((_req, res) => {
        openSse(res);
        writeSse(res, toolChunk(failure.arguments || CALL.function.arguments, true, 'tool_calls', USAGE));
        failure.finish(res);
      });
      const client = h.open();
      await deadline(client.done);
      assert.equal(argumentDeltas(client).length, 1, '增量模式先交付参数');
      assertStreamError(client, failure.message);
    });
  }

  const malformedCalls = [
    ['缺失 index', Object.fromEntries(Object.entries(CALL).filter(([key]) => key !== 'index')), /索引无效/],
    ['null index', { ...CALL, index: null }, /索引无效/],
    ['负数 index', { ...CALL, index: -1 }, /索引无效/],
    ['小数 index', { ...CALL, index: 1.5 }, /索引无效/],
    ['字符串 index', { ...CALL, index: '1' }, /索引无效/],
    ['超过安全整数的 index', { ...CALL, index: Number.MAX_SAFE_INTEGER + 1 }, /索引无效/],
    ['非法 type', { ...CALL, index: 1, type: 'custom' }, /字段无效/],
    ['数字 id', { ...CALL, index: 1, id: 123 }, /字段无效/],
    ['数字 name', { ...CALL, index: 1, function: { name: 123, arguments: '{}' } }, /字段无效/],
    ['非字符串 arguments', { ...CALL, index: 1, function: { name: 'Bash', arguments: {} } }, /字段无效/],
    ['数组 function', { ...CALL, index: 1, function: [] }, /字段无效/],
  ];
  for (const [name, badCall, message] of malformedCalls) {
    await t.test(`${name}：不能把已有合法调用洗成成功完成`, async t => {
      const h = await harness(t);
      h.set((_req, res) => {
        openSse(res);
        writeSse(res, chunk({ tool_calls: [CALL] }, 'tool_calls', USAGE));
        writeSse(res, chunk({ tool_calls: [badCall] }));
        endSse(res);
      });
      const client = h.open();
      await deadline(client.done);
      assert.equal(argumentDeltas(client)[0], CALL.function.arguments, '已有合法调用必须先实时交付');
      assert.equal(argumentDeltas(client).length, 1, '早期校验不得把非法字段交付给客户端');
      assertStreamError(client, message);
    });
  }

  await t.test('tool_calls 容器为对象时立即报错，不交付非法容器', async t => {
    const h = await harness(t);
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, chunk({ tool_calls: [CALL] }, 'tool_calls', USAGE));
      writeSse(res, chunk({ tool_calls: { ...CALL } }));
      endSse(res);
    });
    const client = h.open();
    await deadline(client.done);
    assert.equal(argumentDeltas(client).length, 1);
    assertStreamError(client, /字段无效/);
    assert.ok(values(client).every(value => value.choices?.[0]?.delta?.tool_calls == null ||
      Array.isArray(value.choices[0].delta.tool_calls)), '非法容器不能发给下游');
  });

  await t.test('finish=tool_calls 却没有调用时最终校验失败，不补假成功', async t => {
    const h = await harness(t);
    const opened = deferred();
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, chunk({ content: '正在准备调用。' }));
      opened.resolve(res);
    });
    const client = h.open();
    const res = await opened.promise;
    await client.waitFor(value => value.text.includes('正在准备调用。'));
    writeSse(res, chunk({}, 'tool_calls', USAGE));
    endSse(res);
    await deadline(client.done);
    assert.deepEqual(argumentDeltas(client), []);
    assertStreamError(client, /不是有效 JSON/);
  });

  await t.test('buffered 在上游 DONE 前保留工具参数，思考在短暂首段窗口后交付', async t => {
    const h = await harness(t, { toolStreamMode: reloadConfig('buffered').toolStreamMode });
    const opened = deferred();
    h.set((_req, res) => { openSse(res); writeSse(res, chunk({ reasoning_content: '先确认。' })); opened.resolve(res); });
    const client = h.open();
    const res = await deadline(opened.promise);
    await client.waitFor(value => value.text.includes('先确认。'));
    writeSse(res, toolChunk('{"command":"', true));
    writeSse(res, toolChunk('Get-Location"}', false, 'tool_calls', USAGE));
    try {
      await delay(80);
      assert.deepEqual(argumentDeltas(client), []);
      assertNoTerminal(client);
    } finally { endSse(res); }
    await deadline(client.done);
    assertSuccess(client);
    assert.equal(values(client).filter(value => value.usage).length, 1);
  });

  await t.test('buffered 坏参数维持 HTTP 502，半截调用不会交付', async t => {
    const h = await harness(t, { toolStreamMode: 'buffered' });
    h.set((_req, res) => {
      openSse(res); writeSse(res, toolChunk('{"command":', true, 'tool_calls', USAGE)); endSse(res);
    });
    const client = h.open();
    await deadline(client.done);
    assert.equal(client.status, 502);
    assert.match(JSON.parse(client.text).error.message, /不是有效 JSON/);
    assert.deepEqual(argumentDeltas(client), []);
    assert.ok(!client.text.includes('[DONE]'));
  });

  await t.test('持续工具参数超过模拟客户端 idle 期限，每片到达都会刷新计时', async t => {
    const h = await harness(t);
    let produced = 0;
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, toolChunk('{"command":"', true));
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        produced++;
        writeSse(res, toolChunk('x'));
        if (produced === 10) {
          clearInterval(timer);
          writeSse(res, toolChunk('"}', false, 'tool_calls'));
          endSse(res);
        }
      }, 40);
      res.once('close', () => clearInterval(timer));
    });
    const simulatedIdle = 220;
    let idleTimer, timedOut = false, observed = 0;
    const firstArrival = deferred();
    let started = 0;
    const client = h.open({}, value => {
      const count = argumentDeltas(value).length;
      if (count === observed) return;
      observed = count;
      if (!started) { started = Date.now(); firstArrival.resolve(); }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; value.cancel(); }, simulatedIdle);
    });
    try {
      await deadline(firstArrival.promise);
      await deadline(client.done);
      assert.equal(timedOut, false, '仅等待完整参数会超过模拟客户端 idle 期限');
      assert.ok(Date.now() - started > simulatedIdle, '用例总生成时长必须超过客户端 idle 期限');
      assert.equal(observed, 12, '每片参数都应抵达客户端');
      assertSuccess(client, '{"command":"' + 'x'.repeat(10) + '"}');
    } finally { clearTimeout(idleTimer); }
  });

  await t.test('客户端取消立即关闭上游并归还并发槽位', async t => {
    const h = await harness(t);
    const closed = deferred();
    let produced = 0;
    h.set((_req, res, payload) => {
      openSse(res);
      if (payload.messages[0].content === 'probe') {
        writeSse(res, chunk({ content: 'ok' }, 'stop')); return endSse(res);
      }
      writeSse(res, toolChunk('{"command":"', true));
      const timer = setInterval(() => { produced++; writeSse(res, toolChunk('x')); }, 25);
      res.once('close', () => { clearInterval(timer); closed.resolve(); });
    });
    const client = h.open();
    await client.waitFor(value => argumentDeltas(value).length >= 2);
    const busy = h.open({ messages: [{ role: 'user', content: 'probe' }] });
    await deadline(busy.done);
    assert.equal(busy.status, 429, '取消前确实占有唯一并发槽位');
    client.cancel();
    await deadline(closed.promise, 1500, '客户端取消后上游未关闭');
    await until(() => h.stats.results.some(result => result.type === 'aborted'), '取消未结束真实上游 request');
    const stoppedAt = produced;
    await delay(60);
    assert.equal(produced, stoppedAt, '取消后上游不得继续生成');
    const probe = h.open({ messages: [{ role: 'user', content: 'probe' }] });
    await deadline(probe.done);
    assert.equal(probe.status, 200, '取消后必须归还槽位');
    assert.deepEqual(finishes(probe), ['stop']);
    assert.equal(probe.events.at(-1).done, true);
  });

  await t.test('真实 TCP 工具参数背压超过 idle，恢复读取后完整成功', async t => {
    const h = await harness(t, { streamIdleTimeout: 150, streamTotalTimeout: 5000 });
    const count = 600;
    const argumentPart = 'x'.repeat(16000);
    h.set((_req, res) => {
      openSse(res);
      writeSse(res, toolChunk('{"command":"', true));
      let produced = 0;
      const frame = toolChunk(argumentPart);
      const pump = () => {
        while (!res.destroyed) {
          if (produced === count) {
            writeSse(res, toolChunk('"}', false, 'tool_calls', USAGE));
            endSse(res);
            return;
          }
          produced++;
          if (!writeSse(res, frame)) { res.once('drain', pump); return; }
        }
      };
      pump();
    });
    const paused = deferred();
    let didPause = false;
    const client = h.open({}, value => {
      if (!didPause && Buffer.byteLength(value.text) >= 200000) {
        didPause = true;
        value.response.pause();
        paused.resolve();
      }
    });
    await deadline(paused.promise);
    await until(() => h.stats.activeDeliveries > 0 && Date.now() - h.stats.deliveryStarted > 250,
      '暂停读取未造成真实代理背压等待', 3000);
    assert.deepEqual(h.stats.results, [], '背压超过 idle 后不能提前结束上游 request');
    assertNoTerminal(client);
    client.response.resume();
    await deadline(client.done, 5000, '恢复读取后未完整交付工具参数');
    assert.equal(client.status, 200);
    assert.equal(client.error, null);
    assert.ok(h.stats.maxDeliveryMs > h.config.streamIdleTimeout, '必须实际等待过下游 drain');
    assert.equal(h.stats.results[0]?.type, 'stream');
    const fragments = argumentDeltas(client);
    assert.equal(fragments.length, count + 2, '恢复后不得丢失或重复任何参数片段');
    assert.equal(fragments[0], '{"command":"');
    assert.equal(fragments.at(-1), '"}');
    assert.ok(fragments.slice(1, -1).every(fragment => fragment === argumentPart));
    assert.equal(JSON.parse(fragments.join('')).command.length, count * argumentPart.length);
    assert.deepEqual(finishes(client), ['tool_calls']);
    assert.equal(values(client).filter(value => value.usage).length, 1);
    assert.equal(client.events.filter(event => event.done).length, 1);
    assert.equal(client.events.at(-1).done, true);
  });

  await t.test('真实 TCP 工具参数背压超过 idle 后，总超时仍收尾并释放槽位', async t => {
    const h = await harness(t, { streamIdleTimeout: 150, streamTotalTimeout: 700,
      upstreamSseTotalLimit: 128 * 1048576 });
    const closed = deferred();
    h.set((_req, res, payload) => {
      openSse(res);
      if (payload.messages[0].content === 'probe') {
        writeSse(res, chunk({ content: 'ok' }, 'stop')); return endSse(res);
      }
      writeSse(res, toolChunk('{"command":"', true));
      const frame = toolChunk('x'.repeat(16000));
      // 上游自身遵守背压；客户端暂停后，真实代理 onChunk 会停在 waitDrain。
      const pump = () => {
        while (!res.destroyed) {
          if (!writeSse(res, frame)) { res.once('drain', pump); return; }
        }
      };
      res.once('close', () => closed.resolve());
      pump();
    });
    const paused = deferred();
    let didPause = false;
    const client = h.open({}, value => {
      if (!didPause && Buffer.byteLength(value.text) >= 200000) {
        didPause = true;
        value.response.pause();
        paused.resolve();
      }
    });
    await deadline(paused.promise);
    await until(() => h.stats.results.length > 0, '背压下总超时未结束真实上游 request', 2500);
    assert.deepEqual(h.stats.results[0], { type: 'timeout', phase: 'total' }, '背压不得误判成上游 idle');
    assert.ok(h.stats.deliveryAgeAtFinish > h.config.streamIdleTimeout,
      `必须真正停在下游背压等待，实际 ${h.stats.deliveryAgeAtFinish}ms`);
    await until(() => h.stats.activeDeliveries === 0, '发送流式错误后仍有 onChunk 背压等待未解除');
    assert.equal(client.ended, false, '验证槽位时客户端仍停读原响应');
    const probe = h.open({ messages: [{ role: 'user', content: 'probe' }] });
    await deadline(probe.done);
    assert.equal(probe.status, 200, '错误帧不能等待 drain 而占住并发槽位');
    client.response.resume();
    await deadline(client.done, 5000, '恢复读后错误 SSE 未正常结束');
    assertStreamError(client, /超时/);
    await deadline(closed.promise, 1500, '总超时未停止替身上游');
  });

  await t.test('buffered 上游 DONE 后冲刷遇到 TCP 背压，交付超时释放槽位', async t => {
    const h = await harness(t, { toolStreamMode: 'buffered', streamIdleTimeout: 200,
      streamTotalTimeout: 800 });
    const count = 50;
    const argumentPart = 'x'.repeat(500000);
    h.set((_req, res, payload) => {
      openSse(res);
      if (payload.messages[0].content === 'probe') {
        writeSse(res, chunk({ content: 'ok' }, 'stop')); return endSse(res);
      }
      writeSse(res, toolChunk('{"command":"', true));
      for (let index = 0; index < count; index++) writeSse(res, toolChunk(argumentPart));
      writeSse(res, toolChunk('"}', false, 'tool_calls', USAGE));
      endSse(res);
    });
    const paused = deferred();
    // 响应头到达即暂停，保证约 25MB 的最终冲刷堵在真实 TCP 发送缓冲区。
    const client = h.open({}, undefined, value => { value.response.pause(); paused.resolve(); });
    await deadline(paused.promise, 3000, 'buffered 上游完成后未开始冲刷');
    await until(() => h.stats.results.length > 0, '上游未正常结束，无法验证最终交付阶段');
    assert.equal(h.stats.results[0].type, 'stream', '用例前提必须是上游已收到 DONE');
    assert.deepEqual(argumentDeltas(client), [], '客户端保持暂停，不能已读完最终冲刷');
    await delay(h.config.streamTotalTimeout + 100);
    assert.equal(client.ended, false, '检查并发槽位时客户端仍暂停读取');
    const probe = h.open({ messages: [{ role: 'user', content: 'probe' }] });
    await deadline(probe.done);
    assert.equal(probe.status, 200, '上游结束后的最终冲刷也必须限制等待并归还槽位');
    client.response.resume();
    await deadline(client.done, 5000, '恢复读取后未收到最终交付超时错误');
    assertStreamError(client, /超时/);
    assert.ok(argumentDeltas(client).length > 0, '错误前应有已经开始冲刷的工具参数');
    assert.ok(argumentDeltas(client).length < count + 2, '交付超时后必须停止继续冲刷');
  });
});
