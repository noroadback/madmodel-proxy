// test/errors.test.js — 错误分类与映射(纯函数):结构化状态码、SSE 内嵌
// errorMessage、HTML 错误页、无法识别兜底,与 failed-stream 措辞
'use strict';
require('../scripts/isolated-env').isolate();

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
  // 给出可能原因,让用户能自己缩小范围(上下文/请求体/真繁忙)
  assert.ok(withDetail.message.includes('请求参数'));
  const noDetail = translateUpstreamError({ status: 10001 }, '', 200);
  assert.strictEqual(noDetail.http, 429);
  assert.ok(noDetail.message.includes('未提供详情'), '上游没给详情时要如实说明,不能装作有细节');
});

test('映射: SSE 内嵌 errorMessage 含"繁忙" → 429 原文', () => {
  const m = translateUpstreamError({ errorMessage: '服务器繁忙，请稍后再试' }, '', 200);
  assert.strictEqual(m.http, 429);
  assert.ok(m.message.includes('服务器繁忙'));
});

test('映射: 上游网关 413(HTML 错误页) → 413 且给出减体积的处置', () => {
  const m = translateUpstreamError(null, '<html><title>413 Request Entity Too Large</title></html>', 413);
  assert.strictEqual(m.http, 413, '体积问题应如实回 413,不是 502');
  // 网关上限会变(2026-09-28 一天内从 1MiB 提到 5MB 以上),文案不得写死数字
  assert.ok(!/KB|MB|字节数|1,048|1048576/.test(m.message), '不得在文案里钉死会变的上限:' + m.message);
  assert.ok(m.message.includes('图'), '应指出图片是最常见的触发原因:' + m.message);
  assert.ok(!/稍后重试通常自愈/.test(m.message), '体积超限重试无用,不得给这个建议');
});

// ---- "繁忙"复判:上游对上下文超限也报"繁忙"(2026-09-10 实测),按本地精确
// 分词(core/tokenizer.js,与上游逐 token 一致)复判,超限改判 413 给出正确处置 ----
const BUSY = { errorMessage: '服务器繁忙，请稍后再试' };
const hintOver = { promptTokens: 240000, tokenBudget: 65536, contextWindow: 262144 };

test('复判: 无 busyHint 保持 429(调用方未提供时不改语义)', () => {
  const m = translateUpstreamError(BUSY, '', 200);
  assert.strictEqual(m.http, 429);
});

test('复判: prompt+max_tokens 超上限 → 413 疑似上下文超限', () => {
  const m = translateUpstreamError(BUSY, '', 200, hintOver);
  assert.strictEqual(m.http, 413);
  assert.ok(m.message.includes('上下文超限'));
  assert.match(m.message, /缩短对话或调低输出上限/);
  assert.doesNotMatch(m.message, /240000|65536|262144|本地估算|预算/);
});

test('复判: prompt 未超上限(短小请求) → 保持 429 真繁忙', () => {
  const m = translateUpstreamError(BUSY, '', 200, { ...hintOver, promptTokens: 1000 });
  assert.strictEqual(m.http, 429);
  assert.ok(m.message.includes('服务器繁忙'));
});

test('复判: max_tokens 缺省按 0 计,prompt 单独未超 → 429', () => {
  const m = translateUpstreamError(BUSY, '', 200, { ...hintOver, tokenBudget: 0, promptTokens: 200000 });
  assert.strictEqual(m.http, 429);
});

test('复判: prompt 单独已达上限(无 max_tokens 漏检形态) → 413', () => {
  const m = translateUpstreamError(BUSY, '', 200, { ...hintOver, tokenBudget: 0, promptTokens: 262144 });
  assert.strictEqual(m.http, 413);
});

test('复判: 恰等于上限不算超限(上游 > 才拒)', () => {
  const m = translateUpstreamError(BUSY, '', 200, { promptTokens: 196608, tokenBudget: 65536, contextWindow: 262144 });
  assert.strictEqual(m.http, 429);
});

test('复判: 接近估算边界只给处理建议，真实 HTTP 限流仍优先', () => {
  const hint = { promptTokens: 47860, tokenBudget: 999692, contextWindow: 1048576, reserveTokens: 1024 };
  for (const body of [BUSY, { status: 10001, message: '服务器繁忙' }]) {
    const mapped = translateUpstreamError(body, '', 200, hint);
    assert.strictEqual(mapped.http, 429, '估算不能证明实际超限');
    assert.ok(mapped.message.includes('调低输出上限'));
    assert.doesNotMatch(mapped.message, /预算|估算|47860|999692|1048576/);
    assert.ok(!mapped.message.includes('疑似上下文超限'));
  }
  const limited = translateUpstreamError(BUSY, '', 429, hint);
  assert.ok(limited.message.includes('HTTP 429'));
  assert.ok(!limited.message.includes('调低输出上限'));
});

// ---- 10001 复判:结构化状态码与"繁忙"文案同族(2026-09-16 补齐,此前该分支
// 不查 busyHint,超限被报 429 诱导客户端无限重试)。复判逻辑与"繁忙"分支
// 经共享 helper(likelyOverflow)实现,边界语义一致,此处钉 10001 分支的接线 ----
test('10001 复判: 超限 → 413(与繁忙文案分支同判)', () => {
  const m = translateUpstreamError({ status: 10001, message: '服务器繁忙' }, '', 200, hintOver);
  assert.strictEqual(m.http, 413);
  assert.ok(m.message.includes('上下文超限'));
});

test('10001 复判: 短小请求 → 保持 429', () => {
  const m = translateUpstreamError({ status: 10001 }, '', 200, { ...hintOver, promptTokens: 1000 });
  assert.strictEqual(m.http, 429);
});

test('10001 复判: 恰等于上限 → 429(> 才拒,与繁忙分支边界一致)', () => {
  const m = translateUpstreamError({ status: 10001 }, '', 200, { promptTokens: 196608, tokenBudget: 65536, contextWindow: 262144 });
  assert.strictEqual(m.http, 429);
});

test('10001 复判: 无 busyHint → 保持 429', () => {
  const m = translateUpstreamError({ status: 10001, message: '服务器繁忙' }, '', 200);
  assert.strictEqual(m.http, 429);
});

test('映射: HTTP 400 保留参数错误，不转成可重试的 502', () => {
  const m = translateUpstreamError({ message: '某错误' }, '', 400);
  assert.strictEqual(m.http, 400);
  assert.strictEqual(m.type, 'invalid_request_error');
  assert.ok(m.message.includes('某错误'));
});

test('映射: HTTP 400 或 HTTP 200 内嵌 code 400 明确上下文超限，保留原文与标准 code', () => {
  const messages = [
    "This model's maximum context length is 1048576 tokens. However, you requested 1048576 output tokens and your prompt contains 89 characters (more than 0 characters, which is the upper bound for 0 input tokens). Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_text, value=89)",
    "This model's maximum context length is 1048576 tokens. However, you requested 1047552 output tokens and your prompt contains at least 1025 input tokens, for a total of at least 1048577 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=1025)",
    "Requested token count exceeds the model's maximum context length of 163840 tokens. You requested a total of 163849 tokens: 9 tokens from the input messages and 163840 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.",
  ];
  for (const status of [200, 400]) {
    for (const message of messages) {
      const m = translateUpstreamError({ error: { message, type: 'BadRequestError', code: 400 } }, '', status);
      assert.strictEqual(m.http, 400);
      assert.strictEqual(m.type, 'invalid_request_error');
      assert.strictEqual(m.code, 'context_length_exceeded');
      assert.ok(m.message.includes(message));
    }
  }
});

test('映射: 标准 context_length_exceeded code 也支持 HTTP 200 内嵌错误', () => {
  for (const status of [200, 400]) {
    for (const body of [
      { error: { message: 'context overflow', code: 'context_length_exceeded' } },
      { message: 'context overflow', code: 'context_length_exceeded' },
    ]) {
      const m = translateUpstreamError(body, '', status);
      assert.strictEqual(m.http, 400);
      assert.strictEqual(m.type, 'invalid_request_error');
      assert.strictEqual(m.code, 'context_length_exceeded');
      assert.ok(m.message.includes('context overflow'));
    }
  }
});

test('映射: 无效 max_tokens 不误报为上下文超限', () => {
  for (const status of [200, 400]) {
    for (const message of ['max_tokens must be greater than 0', 'Range of max_tokens should be [1, 131072]']) {
      for (const code of [400, '400']) {
        for (const body of [{ error: { message, type: 'BadRequestError', code } }, { message, code }]) {
          const m = translateUpstreamError(body, '', status, hintOver);
          assert.strictEqual(m.http, 400);
          assert.strictEqual(m.type, 'invalid_request_error');
          assert.strictEqual(m.code, undefined);
          assert.ok(m.message.includes(message));
          assert.doesNotMatch(m.message, /上下文超限|稍后重试/);
        }
      }
    }
  }
});

test('映射: 上下文文案需要明确 400，不覆盖上游故障', () => {
  for (const message of [
    "This model's maximum context length is 1048576 tokens. Internal failure.",
    "Requested token count exceeds the model's maximum context length of 163840 tokens. Internal failure.",
  ]) {
    for (const [status, code] of [[200, undefined], [200, 500], [500, undefined], [500, 400]]) {
      const m = translateUpstreamError({ error: { message, code } }, '', status);
      assert.strictEqual(m.http, 502);
      assert.strictEqual(m.code, undefined);
    }
  }
});

test('映射: 明确 HTTP 认证、端点、体积和限流状态仍优先', () => {
  for (const code of ['context_length_exceeded', 400, '400']) {
    const body = { error: { message: "Requested token count exceeds the model's maximum context length of 163840 tokens.", code } };
    for (const [status, expected] of [[302, 502], [401, 401], [403, 401], [404, 502], [413, 413], [429, 429]]) {
      const m = translateUpstreamError(body, '', status, hintOver);
      assert.strictEqual(m.http, expected);
      assert.strictEqual(m.code, undefined);
    }
  }
});

test('映射: 无结构化详情的 HTTP 400 保留状态，避免返回 HTML 页面', () => {
  const plain = translateUpstreamError(null, 'invalid parameter', 400);
  assert.strictEqual(plain.http, 400);
  assert.ok(plain.message.includes('invalid parameter'));
  for (const raw of ['', '<html>Bad Request</html>']) {
    const m = translateUpstreamError(null, raw, 400);
    assert.strictEqual(m.http, 400);
    assert.strictEqual(m.type, 'invalid_request_error');
    assert.match(m.message, /HTTP 400/);
    assert.doesNotMatch(m.message, /<html>/);
  }
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

// 零字节与中途截断分别提示，只描述观测到的等待与断流。
test('截断两形态: 零字节且长时间等待 → 首字节文案', () => {
  const d = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 61_400, sawBytes: false }, 'stream', CFG);
  assert.strictEqual(d.note, 'stream-truncated');
  assert.ok(d.message.includes('未产出首字节'), d.message);
  assert.ok(d.message.includes('已等待 61s'), d.message);
  assert.ok(d.message.includes('重试'), d.message);
  assert.ok(d.message.includes('缩短对话'), d.message);
  assert.ok(!d.message.includes('网关'), d.message);
  assert.ok(!d.message.includes('PROXY_UPSTREAM'), d.message);
});

test('截断两形态: 中途截断 → 距上一帧时长 + 已交付 KB + 可重试', () => {
  const d = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 60_100, sawBytes: true },
    'stream', CFG, 12_345);
  assert.strictEqual(d.note, 'stream-truncated');
  assert.ok(d.message.includes('截断'), d.message);          // README FAQ 按"截断"检索
  assert.ok(d.message.includes('距上一帧 60s'), d.message);
  assert.ok(!d.message.includes('网关'), d.message);
  assert.ok(d.message.includes('已发送 12.1 KB'), d.message);
  assert.ok(d.message.includes('重试'), d.message);
});

test('截断两形态: 中途截断但无交付字节(聚合路径)不含 KB 句子', () => {
  const d = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 500, sawBytes: true }, 'agg', CFG);
  assert.strictEqual(d.note, 'agg-truncated');
  assert.ok(d.message.includes('距上一帧 1s'), d.message);
  assert.ok(!d.message.includes('KB'), d.message);
  assert.ok(d.message.includes('重试'), d.message);
});

test('截断两形态: 中途截断且静默较短 → 连接中断', () => {
  const d = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 5_000, sawBytes: true }, 'stream', CFG, 4_096);
  assert.ok(d.message.includes('距上一帧 5s 后连接中断'), d.message);
  assert.ok(d.message.includes('重试'), d.message);
  assert.ok(!d.message.includes('网关'), d.message);
});

test('截断两形态: 等待首字节时较早断开', () => {
  const d = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 1_200, sawBytes: false }, 'agg', CFG);
  assert.ok(d.message.includes('未产出首字节（已等待 1s）'), d.message);
  assert.ok(!d.message.includes('网关'), d.message);
});

test('截断两形态: 无 idleMs(旧调用方)保持简短形态', () => {
  const d = describeFailedStream({ type: 'protocol-error', reason: 'truncated', sawBytes: false }, 'agg', CFG);
  assert.ok(d.message.includes('[DONE]'), d.message);
  assert.ok(!d.message.includes('距上一帧'), d.message);
});

test('截断两形态: 无 sawBytes 字段时按 idleMs 与总时长比较判定(兜底判据)', () => {
  const zero = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 61_000, elapsedMs: 61_000 }, 'agg', CFG);
  assert.ok(zero.message.includes('未产出首字节'), zero.message);
  const mid = describeFailedStream(
    { type: 'protocol-error', reason: 'truncated', idleMs: 1_000, elapsedMs: 61_000 }, 'agg', CFG);
  assert.ok(mid.message.includes('距上一帧 1s'), mid.message);
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
