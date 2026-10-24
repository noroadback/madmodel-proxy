'use strict';
require('../scripts/isolated-env').isolate();
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const { createUpstreamClient } = require('../core/upstream-client');
const baseConfig = require('../config');

const config = { ...baseConfig, upstream: 'http://127.0.0.1:1/v1/chat/completions', tunnelMode: false,
  upstreamHeaderTimeout: 1000, streamIdleTimeout: 1000, streamTotalTimeout: 2000 };
const payload = { model: 'DeepSeek-V4.1-Flash', stream: true, messages: [{ role: 'user', content: 'private-request-content' }] };
const send = (options = {}, overrides = {}) => createUpstreamClient({ ...config, ...overrides })
  .request({ payload, token: 'private-token', ...options });
const frame = Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');

test('连接与上传失败保留多地址错误码，诊断不包含凭据或 cause 原文', async t => {
  const a = Object.assign(new Error('private-caused-message'), { code: 'ECONNRESET' });
  const b = Object.assign(new Error('https://private.example/?ticket=private-ticket'), { code: 'ENETUNREACH' });
  const aggregate = new AggregateError([a, b]);
  aggregate.cause = aggregate;
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: aggregate }); });
  const result = await send();
  assert.equal(result.type, 'network-error');
  assert.equal(result.phase, 'request');
  assert.deepEqual(result.codes, ['ECONNRESET', 'ENETUNREACH']);
  assert.equal(result.requestBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(result.receivedBytes, 0);
  assert.equal(result.responseStatus, null);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('响应体读取失败保留阶段、已收到字节和底层 socket 错误', async t => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; controller.enqueue(frame); } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  }));
  const error = new TypeError('terminated', { cause: Object.assign(new Error('private-socket'), { code: 'UND_ERR_SOCKET' }) });
  const result = await send({ onChunk() { controller.error(error); } });
  assert.equal(result.type, 'network-error');
  assert.equal(result.phase, 'response-body');
  assert.deepEqual(result.codes, ['UND_ERR_SOCKET']);
  assert.equal(result.receivedBytes, frame.length);
  assert.equal(result.responseStatus, 200);
});

test('下游回调失败与上游读取失败分开记录，不输出任意异常消息', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(frame); c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  const result = await send({ onChunk() { throw Object.assign(new Error('private-delivery-body'), { code: 'EPIPE' }); } });
  assert.equal(result.type, 'network-error');
  assert.equal(result.phase, 'delivery');
  assert.deepEqual(result.codes, ['EPIPE']);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('外部取消仍是 aborted，不被网络诊断改写', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('private-abort', 'AbortError'); });
  const ac = new AbortController(); ac.abort();
  const result = await send({ signal: ac.signal });
  assert.equal(result.type, 'aborted');
});

test('响应头超时仍保留原分类', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  assert.deepEqual(await send({}, { upstreamHeaderTimeout: 20 }), { type: 'timeout', phase: 'headers' });
});

test('cause 遍历有上限，非法错误码不会作为日志文本传播', async t => {
  const errors = Array.from({ length: 100 }, (_, i) => Object.assign(new Error('private-error'), { code: `E_TEST_${i}` }));
  errors.unshift(Object.assign(new Error('private-url'), { code: 'Bearer private-token' }));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: new AggregateError(errors) }); });
  const result = await send();
  assert.ok(result.codes.length > 0 && result.codes.length <= 8);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('JSON 读取失败也保留已收字节和响应状态', async t => {
  const bytes = Buffer.from('{"partial":');
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) {
    if (!pulls++) controller.enqueue(bytes);
    else controller.error(new TypeError('terminated', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) }));
  } }, { highWaterMark: 0 });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  const result = await send();
  assert.equal(result.type, 'network-error');
  assert.equal(result.phase, 'response-body');
  assert.equal(result.receivedBytes, bytes.length);
  assert.equal(result.responseStatus, 200);
  assert.deepEqual(result.codes, ['ECONNRESET']);
});
