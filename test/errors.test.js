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

// ---- "繁忙"复判:上游对上下文超限也报"繁忙"(2026-09-10 实测),按悲观口径
// 估算+max_tokens 复算,超限改判 413 给出正确处置 ----
const BUSY = { errorMessage: '服务器繁忙，请稍后再试' };
const hintOver = { estHigh: 240000, tokenBudget: 65536, contextWindow: 262144 };

test('复判: 无 busyHint 保持 429(调用方未提供时不改语义)', () => {
  const m = translateUpstreamError(BUSY, '', 200);
  assert.strictEqual(m.http, 429);
});

test('复判: 悲观估算+max_tokens 超上限 → 413 疑似上下文超限', () => {
  const m = translateUpstreamError(BUSY, '', 200, hintOver);
  assert.strictEqual(m.http, 413);
  assert.ok(m.message.includes('上下文超限'));
  assert.ok(m.message.includes('240000'));
});

test('复判: 估算未超上限(短小请求) → 保持 429 真繁忙', () => {
  const m = translateUpstreamError(BUSY, '', 200, { ...hintOver, estHigh: 1000 });
  assert.strictEqual(m.http, 429);
  assert.ok(m.message.includes('服务器繁忙'));
});

test('复判: max_tokens 缺省按 0 计,不算超限', () => {
  const m = translateUpstreamError(BUSY, '', 200, { ...hintOver, tokenBudget: 0 });
  assert.strictEqual(m.http, 429);
});

test('复判: 恰等于上限不算超限(上游 > 才拒)', () => {
  const m = translateUpstreamError(BUSY, '', 200, { estHigh: 196608, tokenBudget: 65536, contextWindow: 262144 });
  assert.strictEqual(m.http, 429);
});

// ---- estimateTokens 两类口径(纯函数,钉死校准数值) ----
const { estimateTokens } = require('../core/proxy-service');

test('估算: ASCII 按 4(常规)/3(悲观),多字节恒按 4.8', () => {
  const ascii = Buffer.from('a'.repeat(400)); // 400 字节纯 ASCII
  assert.strictEqual(estimateTokens(ascii), 100);
  assert.strictEqual(estimateTokens(ascii, true), 133); // Math.round(400/3)
  const zh = Buffer.from('中'.repeat(48)); // 144 字节(3 字节/字)纯多字节
  assert.strictEqual(estimateTokens(zh), 30);
  assert.strictEqual(estimateTokens(zh, true), 30); // 悲观只调 ASCII 一类
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
