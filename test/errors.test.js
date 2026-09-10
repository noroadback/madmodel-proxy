// test/errors.test.js — 错误分类与映射(纯函数):结构化状态码、SSE 内嵌
// errorMessage、HTML 错误页、无法识别兜底,与 failed-stream 措辞
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { translateUpstreamError, describeFailedStream } = require('../core/errors');

test('映射: 404 → 502 端点变更', () => {
  const m = translateUpstreamError(null, '', 404);
  assert.strictEqual(m.http, 502);
  assert.ok(m.message.includes('端点可能已变更'));
});

test('映射: HTTP 401/403 → 401 认证失败(与 10003 同语义)', () => {
  for (const status of [401, 403]) {
    const m = translateUpstreamError(null, 'whatever', status);
    assert.strictEqual(m.http, 401, String(status));
    assert.ok(m.message.includes('watch 守护'));
  }
});

test('映射: status 10003 → 401 认证失败', () => {
  const m = translateUpstreamError({ status: 10003 }, '', 200);
  assert.strictEqual(m.http, 401);
  assert.ok(m.message.includes('watch 守护'));
});

test('映射: status 10001 → 429,带/不带详情两种形态', () => {
  const withDetail = translateUpstreamError({ status: 10001, message: '模型不存在' }, '', 200);
  assert.strictEqual(withDetail.http, 429);
  assert.ok(withDetail.message.includes('模型不存在'));
  const noDetail = translateUpstreamError({ status: 10001 }, '', 200);
  assert.strictEqual(noDetail.http, 429);
  assert.ok(noDetail.message.includes('上游未提供详情'));
});

test('映射: SSE 内嵌 errorMessage 含"繁忙" → 429 原文', () => {
  const m = translateUpstreamError({ errorMessage: '服务器繁忙，请稍后再试' }, '', 200);
  assert.strictEqual(m.http, 429);
  assert.ok(m.message.includes('服务器繁忙'));
});

test('映射: 有 detail 无结构化状态 → 502 上游拒绝请求', () => {
  const m = translateUpstreamError({ message: '某错误' }, '', 400);
  assert.strictEqual(m.http, 502);
  assert.ok(m.message.includes('某错误'));
});

test('映射: HTML 错误页(TsinghuaLB 形态)', () => {
  const html = '<html><head><title>504 Gateway Time-out</title></head>';
  const m502 = translateUpstreamError(null, html, 502);
  assert.strictEqual(m502.http, 502);
  assert.ok(m502.message.includes('HTML'));
  // 非 5xx 状态包着 HTML 同样归 502
  const m200 = translateUpstreamError(null, html, 200);
  assert.strictEqual(m200.http, 502);
});

test('映射: 完全无法识别 → 502 带原文前 200 字符', () => {
  const m = translateUpstreamError(null, 'opaque-body', 200);
  assert.strictEqual(m.http, 502);
  assert.ok(m.message.includes('opaque-body'));
});

// ---- describeFailedStream ----
const CFG = { streamTotalTimeout: 1200e3 };

test('failed-stream: 截断(truncated)形态', () => {
  const d = describeFailedStream({ type: 'protocol-error', reason: 'truncated' }, 'agg', CFG);
  assert.strictEqual(d.note, 'agg-truncated');
  assert.ok(d.message.includes('[DONE]'));
});

test('failed-stream: 其他协议错误(invalid)带原文', () => {
  const d = describeFailedStream({ type: 'protocol-error', message: '某坏帧' }, 'stream', CFG);
  assert.strictEqual(d.note, 'stream-invalid');
  assert.strictEqual(d.message, '某坏帧');
});

test('failed-stream: 流式总超时带秒数', () => {
  const d = describeFailedStream({ type: 'timeout', phase: 'total' }, 'agg', CFG);
  assert.strictEqual(d.note, 'agg-total-timeout');
  assert.ok(d.message.includes('1200'));
});
