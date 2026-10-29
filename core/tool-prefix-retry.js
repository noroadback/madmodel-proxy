'use strict';

// Retry a new generation; never infer the missing fields or patch the JSON.
const emptyPrefix = value => typeof value === 'string' && /^[\x20\t\r\n]*\{[\x20\t\r\n]*$/.test(value);
const onlyPrefix = value => typeof value === 'string' && /^[\x20\t\r\n]*(?:\{[\x20\t\r\n]*)?$/.test(value);
const hasRealToolArguments = frame => {
  const calls = frame?.choices?.[0]?.delta?.tool_calls;
  return Array.isArray(calls) && calls.some(call =>
    call?.function?.arguments != null && !onlyPrefix(call.function.arguments));
};

function canRetryToolPrefix(calls, tools, finish) {
  if (!['tool_calls', 'stop'].includes(finish) || !Array.isArray(calls) || !calls.length || !Array.isArray(tools)) return false;
  const ids = new Set();
  let incomplete = false;
  for (const call of calls) {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
        typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') return false;
    ids.add(call.id);
    if (tools.filter(tool => tool?.type === 'function' && tool.function?.name === call.function.name).length !== 1) return false;
    if (emptyPrefix(call.function.arguments)) { incomplete = true; continue; }
    try {
      const value = JSON.parse(call.function.arguments);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    } catch { return false; }
  }
  return incomplete;
}

// Hold only the first, small response window. Real tool argument characters
// release it immediately; the timer also releases it while upstream is silent.
// Every write, including timer writes, uses the same queue to preserve order.
function createToolPrelude({ write, signal, onError, delayMs = 250, maxBytes = 8192, maxFrames = 32 }) {
  let holding = true, stopped = false, timer = null, bytes = 0, pending = [];
  let tail = Promise.resolve(), failure = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  const discard = () => {
    clear();
    holding = false; stopped = true; pending = []; bytes = 0;
    signal?.removeEventListener('abort', discard);
  };
  const wait = async () => { await tail; if (failure) throw failure; };
  const enqueue = frames => {
    for (const frame of frames) {
      tail = tail.then(async () => {
        if (!failure && !stopped && !signal?.aborted) await write(frame);
      }).catch(error => {
        if (!failure) {
          failure = error;
          try { onError?.(error); } catch { /* retain the original write error */ }
        }
      });
    }
    return wait();
  };
  const flush = () => {
    clear();
    holding = false;
    const frames = pending;
    pending = []; bytes = 0;
    return enqueue(frames);
  };
  signal?.addEventListener('abort', discard, { once: true });
  if (signal?.aborted) discard();
  return {
    get canRetry() { return holding && !failure && !stopped && !signal?.aborted; },
    get hasPending() { return pending.length > 0; },
    write(frame) {
      if (stopped || signal?.aborted) return Promise.resolve();
      if (!holding) return enqueue([frame]);
      pending.push(frame);
      bytes += Buffer.byteLength(JSON.stringify(frame)) + 8;
      const delta = frame?.choices?.[0]?.delta || {};
      const known = new Set(['role', 'content', 'reasoning', 'reasoning_content', 'reasoning_text', 'thinking', 'tool_calls']);
      if (hasRealToolArguments(frame) || Object.keys(delta).some(key => !known.has(key)) || bytes >= maxBytes || pending.length >= maxFrames) return flush();
      if (!timer) timer = setTimeout(() => { flush().catch(() => {}); }, delayMs);
      return Promise.resolve();
    },
    // Freeze eligibility before deciding to retry. An already-started timer
    // flush permanently closes the retry window, even if its writes are pending.
    freeze() {
      clear();
      signal?.removeEventListener('abort', discard);
    },
    flush,
    discard,
  };
}

module.exports = { canRetryToolPrefix, createToolPrelude, hasRealToolArguments };
