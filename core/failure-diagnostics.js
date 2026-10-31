'use strict';

const { createNetworkTiming } = require('./network-timing');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { appendDiagnostic } = require('../platform/diagnostic-store');

const knownFinishes = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

const digest = value => createHash('sha256').update(value, 'utf16le').digest('hex');

// 独立于生产 SseParser，从字节和完整 SSE 事件中提取参数摘要。
// 不缓存完整对话或参数。非标准多 data 行、超限或解码失败只降低取证置信度。
class WireAudit {
  constructor(lineLimit) {
    this.limit = Math.max(1024, lineLimit || 1048576);
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.buffer = '';
    this.data = [];
    this.eventBytes = 0;
    this.eventName = '';
    this.tools = new Map();
    this.available = true;
    this.sawDone = false;
    this.finished = false;
    this.reason = null;
    this.finishReason = null;
    this.frames = 0;
  }
  unavailable(reason) {
    this.available = false;
    this.reason ??= reason;
    this.buffer = '';
    this.data = [];
    this.finished = true;
  }
  event() {
    if (!this.data.length) { this.eventName = ''; this.eventBytes = 0; return; }
    const value = this.data.join('\n').trim();
    const eventName = this.eventName;
    this.data = []; this.eventName = ''; this.eventBytes = 0;
    if (eventName === 'error') { this.finished = true; return; }
    if (value === '[DONE]') { this.sawDone = true; this.finished = true; return; }
    if (!value) return;
    let obj;
    try { obj = JSON.parse(value); } catch { this.unavailable('nonstandard-or-invalid-event'); return; }
    this.frames++;
    const choice = obj?.choices?.[0];
    if (knownFinishes.has(choice?.finish_reason)) this.finishReason = choice.finish_reason;
    const calls = choice?.delta?.tool_calls;
    if (calls === undefined || calls === null) return;
    if (!Array.isArray(calls)) { this.unavailable('invalid-tool-shape'); return; }
    for (const call of calls) {
      if (!Number.isSafeInteger(call?.index) || call.index < 0) { this.unavailable('ambiguous-tool-index'); return; }
      if (!this.tools.has(call.index)) {
        if (this.tools.size >= 64) { this.unavailable('too-many-tools'); return; }
        this.tools.set(call.index, { index: call.index, hash: createHash('sha256'), chars: 0, fragments: 0 });
      }
      const args = call.function?.arguments;
      if (args === undefined || args === null) continue;
      if (typeof args !== 'string') { this.unavailable('invalid-argument-type'); return; }
      const tool = this.tools.get(call.index);
      tool.hash.update(args, 'utf16le'); tool.chars += args.length; tool.fragments++;
    }
  }
  line(line) {
    if (!line) { this.event(); return; }
    this.eventBytes += Buffer.byteLength(line);
    if (this.eventBytes > this.limit) { this.unavailable('event-limit'); return; }
    if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) this.eventName = line.slice(6).trim();
  }
  push(bytes) {
    if (this.finished) return;
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
      let end;
      while (!this.finished && (end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        this.line(line);
      }
      if (Buffer.byteLength(this.buffer) > this.limit) this.unavailable('line-limit');
      if (this.finished) this.buffer = '';
    } catch { this.unavailable('invalid-utf8'); }
  }
  end() {
    if (this.finished) return;
    try {
      this.buffer += this.decoder.decode();
      if (this.buffer) this.line(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
      if (!this.finished) this.event();
    } catch { this.unavailable('incomplete-utf8'); }
  }
  snapshot() {
    return { format: 'sse', available: this.available, complete: this.available && this.sawDone,
      sawDone: this.sawDone, reason: this.reason, finishReason: this.finishReason, frames: this.frames,
      tools: [...this.tools.values()].map(tool => ({ index: tool.index, chars: tool.chars,
        fragments: tool.fragments, hash: tool.hash.copy().digest('hex') })) };
  }
}

function createFailureDiagnostics(config, timing) {
  if (!config.diagnosticsEnabled) return null;
  const trace = timing || createNetworkTiming();
  const requestId = randomUUID().replace(/-/g, '').slice(0, 16);
  let audit = null, jsonAudit = null;
  return {
    run(fn) { return trace.run(fn); },
    open(isSse) { if (isSse) audit = new WireAudit(config.sseLineLimit); },
    bytes(value) { audit?.push(value); },
    end() { audit?.end(); },
    json(bytes) {
      try {
        // 与交付路径分开解析原始 JSON 字节，摘要计算后立即丢弃原文。
        const obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const calls = obj?.choices?.[0]?.message?.tool_calls;
        const available = Array.isArray(calls) && calls.length <= 64 && calls.every(call => typeof call?.function?.arguments === 'string');
        jsonAudit = { format: 'json', available, complete: available,
          sawDone: null, finishReason: knownFinishes.has(obj?.choices?.[0]?.finish_reason) ? obj.choices[0].finish_reason : null,
          tools: available ? calls.map((call, index) => ({ index, chars: call.function.arguments.length,
            fragments: 1, hash: digest(call.function.arguments) })) : [] };
      } catch { jsonAudit = { format: 'json', available: false, complete: false, reason: 'invalid-json-or-utf8', tools: [] }; }
    },
    finish(context) {
      const measured = trace.finish();
      return { requestId, startedAt: trace.startedAt, elapsedMs: Math.max(0, Math.round(performance.now() - trace.startedAt)),
        network: measured.network,
        phase: context.phase, requestBytes: context.requestBytes, receivedBytes: context.receivedBytes,
        responseStatus: context.responseStatus, wire: audit?.snapshot() || jsonAudit || null };
    },
  };
}

const written = new WeakMap();
function failureDiagnosticNote(config, result, details = {}) {
  const diagnostics = result?.diagnostics;
  if (!config.diagnosticsEnabled || !diagnostics) return '';
  const wire = diagnostics.wire;
  let comparison = 'not-checked';
  if (details.toolArguments) {
    comparison = 'unavailable';
    if (wire?.available && wire.complete) {
      const parsed = details.toolArguments;
      comparison = parsed.length === wire.tools.length && wire.tools.every(tool => {
        const found = parsed.find(item => item.index === tool.index);
        return typeof found?.arguments === 'string' && found.arguments.length === tool.chars && digest(found.arguments) === tool.hash;
      }) ? 'match' : 'mismatch';
    }
  }
  const n = diagnostics.network;
  const delivery = details.kind === 'delivery-timeout' || result.phase === 'delivery' || diagnostics.phase === 'delivery';
  const stage = delivery ? 'delivery' : result.phase === 'response-body' || n.headersReceived
    ? 'response-body' : n.bodySent ? 'awaiting-headers' : 'before-body-sent';
  const record = { time: new Date().toISOString(), requestId: diagnostics.requestId,
    kind: /^[a-z-]{1,48}$/.test(details.kind || '') ? details.kind : result.type,
    result: result.type, phase: details.kind === 'delivery-timeout' ? 'delivery' : result.phase || diagnostics.phase || null,
    networkStage: delivery || n.observed ? stage : 'unobserved',
    elapsedMs: Number.isFinite(diagnostics.startedAt) ? Math.max(diagnostics.elapsedMs, Math.round(performance.now() - diagnostics.startedAt)) : diagnostics.elapsedMs,
    upstreamElapsedMs: diagnostics.elapsedMs, network: n,
    requestBytes: result.requestBytes ?? diagnostics.requestBytes ?? null,
    receivedBytes: result.receivedBytes ?? diagnostics.receivedBytes ?? null,
    responseStatus: result.responseStatus ?? diagnostics.responseStatus ?? result.status ?? null,
    codes: Array.isArray(result.codes) ? result.codes.filter(code => /^[A-Z][A-Z0-9_]{0,63}$/.test(code)).slice(0, 8) : [],
    wire: wire ? { format: wire.format, available: wire.available, complete: wire.complete,
      sawDone: wire.sawDone, reason: wire.reason || null, finishReason: wire.finishReason,
      frames: wire.frames, tools: wire.tools.map(({ index, chars, fragments }) => ({ index, chars, fragments })) } : null,
    argumentComparison: comparison,
    forwardingComparison: ['match', 'mismatch', 'not-forwarded', 'no-arguments'].includes(details.forwardingComparison) ? details.forwardingComparison : 'not-checked',
    validation: ['json-incomplete', 'json-invalid', 'shape', 'duplicate-id', 'id-conflict'].includes(details.validation) ? details.validation : null };
  // 不保存参数、摘要哈希、请求 URL、header 或异常 message。一个结果最多写一次。
  let saved = written.get(result);
  if (!written.has(result)) {
    saved = appendDiagnostic(config.tokenFile, record);
    written.set(result, saved);
  }
  return `诊断=${diagnostics.requestId}` + (n.observed ? ` 请求提交=${n.bodySent ? '已提交' : '未确认'}` : ' 请求提交=未观测') +
    (details.toolArguments ? ` 原始参数=${({ match: '一致', mismatch: '不一致', unavailable: '无法核对' })[comparison]}` : '') +
    (wire?.format === 'sse' ? ` DONE=${wire.sawDone ? '已见' : '未见'}` : '') +
    (!saved ? ' 诊断保存失败' : '');
}

module.exports = { createFailureDiagnostics, failureDiagnosticNote, WireAudit };
