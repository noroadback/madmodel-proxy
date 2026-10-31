// 代理观察到的上游输出时间；不按字符或 SSE 帧数推算 token。
'use strict';

const { performance } = require('node:perf_hooks');
const { readReasoningDelta } = require('./thinking');
const { colorFirstOutput } = require('./log-color');

function startOutputTiming(ctx) {
  // 重试沿用请求起点，但不把失败尝试的输出混入成功尝试。
  ctx.startedMonotonic ??= performance.now();
  ctx.outputTiming = { startedAt: ctx.startedMonotonic };
}

function recordOutput(ctx, obj, thinkingField, receivedAt = performance.now()) {
  const timing = ctx.outputTiming;
  if (!timing || !Number.isFinite(receivedAt)) return;
  const delta = obj?.choices?.[0]?.delta;
  const reasoning = readReasoningDelta(delta, thinkingField);
  const effective = (typeof delta?.content === 'string' && delta.content.length > 0) ||
    reasoning !== null ||
    (Array.isArray(delta?.tool_calls) && delta.tool_calls.some(tc =>
      (typeof tc?.function?.name === 'string' && tc.function.name.length > 0) ||
      (typeof tc?.function?.arguments === 'string' && tc.function.arguments.length > 0)));
  if (reasoning !== null) timing.reasoningAt ??= receivedAt;
  if (typeof delta?.content === 'string' && delta.content) timing.contentAt ??= receivedAt;
  if (typeof obj?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(obj.id)) timing.upstreamId ??= obj.id;
  if (!effective) return; // role、空字段、心跳与 usage 不触发首字。
  timing.firstAt ??= receivedAt;
}

function completeOutputTiming(ctx, result) {
  const timing = ctx.outputTiming;
  if (!timing) return;
  timing.completedAt = result.completedAt ?? performance.now();
  timing.network = result.timing;
}

function performanceNote(ctx, usage, colorOptions) {
  const timing = ctx.outputTiming || {};
  const firstMs = timing.firstAt - timing.startedAt;
  const firstValid = Number.isFinite(timing.startedAt) && Number.isFinite(timing.firstAt) &&
    Number.isFinite(firstMs) && firstMs >= 0;
  const first = firstValid
    ? colorFirstOutput(`首字 ${(firstMs / 1000).toFixed(1)}s`, firstMs, colorOptions)
    : '首字 —';
  const elapsedMs = timing.completedAt - timing.firstAt;
  const tokens = usage?.completion_tokens;
  // completion_tokens 已含思考，不再加 reasoning_tokens。速度是从首个
  // 可观察输出起算的近似值，不能用未收到思考文本推断是否有隐藏生成阶段。
  const usageValid = Number.isFinite(tokens) && tokens >= 0;
  // 与 DSH 的时长规则一致：不要求分时到达，也没有最小时长门槛。
  const completionValid = Number.isFinite(timing.completedAt) && Number.isFinite(elapsedMs);
  const measurable = firstValid && completionValid && elapsedMs > 0 && usageValid;
  const rate = measurable ? tokens * 1000 / elapsedMs : NaN;
  let output = Number.isFinite(rate) ? `单次输出 ${rate.toFixed(1)} tok/s` : '单次输出 —';
  if (firstValid && completionValid && usageValid && elapsedMs === 0) output += '（时长为0）';
  return ` | ${first} · ${output}` + phaseNote(ctx);
}

function phaseNote(ctx) {
  const local = ctx.requestTiming;
  if (!local) return '';
  const timing = ctx.outputTiming || {}, network = timing.network;
  const ms = n => Number.isFinite(n) && n >= 0 ? `${Math.round(n)}ms` : '—';
  const fromStart = at => Number.isFinite(at) ? at - ctx.startedMonotonic : NaN;
  const wait = network?.network?.headersMs - network?.network?.bodySentMs;
  const submitted = network?.startedAt + network?.network?.bodySentMs;
  const count = ctx.promptCount;
  const parts = [`本地=${ms(local.readyAt - ctx.startedMonotonic)}`,
    `分词=${ms(count?.elapsedMs)}`, `分词排队=${ms(count?.queueMs)}`,
    `提交=${ms(fromStart(submitted))}`, `待上游=${ms(wait)}`,
    `思考首段=${ms(fromStart(timing.reasoningAt))}`, `正文首段=${ms(fromStart(timing.contentAt))}`,
    `生成=${ms(timing.completedAt - timing.firstAt)}`, `背压=${ms(local.drainMs || 0)}`];
  return ` 阶段[${parts.join(' ')}]` + (timing.upstreamId ? ` 上游id=${timing.upstreamId}` : '');
}

module.exports = { startOutputTiming, recordOutput, completeOutputTiming, performanceNote, phaseNote };
