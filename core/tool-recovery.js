// 工具恢复的共同策略。只解析完整调用；额外请求至多一次，并遵守客户端工具选择。
'use strict';

const { parseToolCalls, stripToolMarkup, shouldProbeSwallowedCall } = require('./dsml');
const { createAggregator } = require('./completion-aggregator');
const { readReasoningDelta } = require('./thinking');

function toolsForbidden(payload) {
  const choice = payload?.__toolsDowngraded ? payload.__clientToolChoice : payload?.tool_choice;
  const value = typeof choice === 'string' ? choice : choice?.type;
  return typeof value === 'string' && value.trim().toLowerCase() === 'none';
}

function recoveryTools(payload) {
  if (toolsForbidden(payload) || !Array.isArray(payload?.tools)) return [];
  const choice = payload.__toolsDowngraded ? payload.__clientToolChoice : payload.tool_choice;
  const name = choice?.type === 'function' ? choice.function?.name : undefined;
  if (choice?.type === 'function' && (typeof name !== 'string' || !name)) return [];
  return payload.tools.filter(t => t?.type === 'function' &&
    typeof t.function?.name === 'string' && (name === undefined || t.function.name === name));
}

function nativeCalls(calls, tools) {
  if (!Array.isArray(calls) || !calls.length) return null;
  const names = new Set(tools.map(t => t.function.name));
  const valid = calls.every(tc => {
    if (!tc || tc.type !== 'function' || typeof tc.id !== 'string' || !tc.id ||
        !names.has(tc.function?.name) || typeof tc.function?.arguments !== 'string') return false;
    try {
      const args = JSON.parse(tc.function.arguments);
      return args !== null && typeof args === 'object' && !Array.isArray(args);
    } catch { return false; }
  });
  return valid ? calls : null;
}

function createToolRecovery({ config, upstreamClient }) {
  async function retry(payload, auth, signal, tools, thinkingField) {
    const retryPayload = { ...payload, stream: false };
    delete retryPayload.stream_options;
    // 常规 SSE 请求的输出预算可能超过上游非流式接口的独立上限。
    // 只收缩已指定的预算，保留此前按上下文计算的更小值。
    const limit = typeof config.limitsFor === 'function'
      ? config.limitsFor(payload.model)?.maxNonstreamOutputTokens : undefined;
    if (Number.isFinite(limit) && limit > 0 &&
        typeof retryPayload.max_tokens === 'number' && retryPayload.max_tokens > limit) {
      retryPayload.max_tokens = limit;
    }
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', onAbort, { once: true });
    const agg = createAggregator(payload.model, thinkingField);
    let timer;
    let result;
    try {
      result = await Promise.race([
        upstreamClient.request({ payload: retryPayload, token: auth.token, cookie: auth.cookie,
          signal: ac.signal, headerTimeoutMs: config.toolCallRetryTimeoutMs,
          onChunk: obj => agg.feed(obj) }),
        new Promise(resolve => {
          timer = setTimeout(() => { ac.abort(); resolve(null); }, config.toolCallRetryTimeoutMs);
        }),
      ]);
    } catch { return null; } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) return null;
    if (result?.type === 'stream' && agg.invalidToolCalls) {
      return { calls: null, content: '', usage: result.usage || agg.usage };
    }
    const body = result?.type === 'completion' ? result.body : result?.type === 'stream' ? agg.result() : null;
    if (!body) return null;
    const ch = body.choices?.[0];
    const msg = ch?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    const allowedFinish = !ch?.finish_reason || ['stop', 'tool_calls'].includes(ch.finish_reason);
    const native = allowedFinish && nativeCalls(msg.tool_calls, tools);
    const calls = native || (allowedFinish && !msg.tool_calls?.length && parseToolCalls(text, tools));
    return { calls, content: native ? text : calls ? stripToolMarkup(text) : '', usage: body.usage };
  }

  return async function recover(body, payload, auth, signal, thinkingField) {
    const tools = recoveryTools(payload);
    const ch = body.choices?.[0];
    const msg = ch?.message;
    if (!config.toolCallFix || !tools.length || !msg || msg.tool_calls?.length ||
        (ch.finish_reason && ch.finish_reason !== 'stop') || signal?.aborted) return {};
    const text = typeof msg.content === 'string' ? msg.content : '';
    // 严格解析先行，启发式检测仅用于决定是否值得额外请求。
    const inline = parseToolCalls(text, tools);
    let fixed;
    if (inline) fixed = { calls: inline, content: stripToolMarkup(text) };
    else {
      const reasoning = readReasoningDelta(msg, thinkingField) || '';
      if (!shouldProbeSwallowedCall(text + reasoning)) return {};
      fixed = await retry(payload, auth, signal, tools, thinkingField);
    }
    const retryUsage = inline ? undefined : fixed?.usage;
    const retryAttempted = !inline;
    if (!fixed?.calls?.length) return { retryUsage, retryAttempted, note: '工具恢复未成功，返回原回复' };
    msg.tool_calls = fixed.calls;
    msg.content = fixed.content || null;
    ch.finish_reason = 'tool_calls';
    if (fixed.usage) body.usage = fixed.usage;
    return { recovered: true, retryUsage, retryAttempted,
      note: `工具调用 ${fixed.calls.length}（${inline ? '文本' : '重试'}恢复）` };
  };
}

module.exports = { createToolRecovery, toolsForbidden };
