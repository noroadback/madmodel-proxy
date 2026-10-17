'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../config');
const { createHttpServer } = require('../adapters/http-server');
const { createUpstreamClient } = require('../core/upstream-client');

const SETTINGS = [
  ['PROXY_BODY_LIMIT_MB', 'bodyLimit', 64 * 1048576],
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

test('请求限制默认值、环境覆盖与非法值回退', () => {
  for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity']) {
    const cfg = loadConfig(Object.fromEntries(SETTINGS.map(([key]) => [key, value])));
    for (const [key, field, fallback] of SETTINGS) assert.equal(cfg[field], fallback, `${key}=${value}`);
  }
  const cfg = loadConfig({ PROXY_BODY_LIMIT_MB: '1.5', PROXY_HEADER_MS: '4321',
    PROXY_IDLE_MS: '5678' });
  assert.equal(cfg.bodyLimit, 1.5 * 1048576);
  assert.equal(cfg.upstreamHeaderTimeout, 4321);
  assert.equal(cfg.streamIdleTimeout, 5678);
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

function upload(port, body, chunked, headerOnly = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions',
      method: 'POST', agent: false, headers: { Host: 'localhost', 'Content-Type': 'application/json',
        ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': body.length }) } }, res => {
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
    if (headerOnly) req.flushHeaders();
    else if (chunked) { req.write(body.subarray(0, body.length - 1)); req.end(body.subarray(-1)); }
    else req.end(body);
  });
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
