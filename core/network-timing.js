// 仅跟踪本模块作用域中的 fetch，保存数值时间戳，不收集 URL/请求头/正文。
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const channels = require('node:diagnostics_channel');
const { performance } = require('node:perf_hooks');
const scope = new AsyncLocalStorage(), requests = new WeakMap();
let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  for (const [name, field] of [['create', 'createdMs'], ['bodySent', 'bodySentMs'], ['headers', 'headersMs']]) {
    channels.subscribe('undici:request:' + name, message => {
      try {
        const request = message?.request;
        if (!request || typeof request !== 'object') return;
        if (name === 'create' && scope.getStore()?.active) requests.set(request, scope.getStore());
        const trace = requests.get(request);
        if (trace?.active && trace.network[field] === undefined) trace.network[field] = Math.max(0, performance.now() - trace.startedAt);
      } catch { /* 观测不能改变请求。 */ }
    });
  }
}
function createNetworkTiming() {
  subscribe();
  const trace = { active: true, startedAt: performance.now(), network: {} };
  return {
    startedAt: trace.startedAt,
    run(fn) { return scope.run(trace, fn); },
    finish() {
      trace.active = false;
      const n = trace.network;
      return { startedAt: trace.startedAt, network: { ...n, observed: n.createdMs !== undefined,
        bodySent: n.bodySentMs !== undefined, headersReceived: n.headersMs !== undefined } };
    },
  };
}
module.exports = { createNetworkTiming };
