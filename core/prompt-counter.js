// 小请求有界同步计数；大请求在一个有界 worker 中计数，不阻塞其他流。
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');
const { getTokenizer, preparePrompt } = require('./tokenizer');
const unavailable = (reason, started) => ({ exact: false, reason, elapsedMs: performance.now() - started });
class PromptCounter {
  constructor({ timeoutMs = 2000, queueTimeoutMs = 5000, maxQueuedChars = 16 * 1024 * 1024, maxQueue = 8,
    workerPath = path.join(__dirname, 'tokenizer-worker.js') } = {}) {
    Object.assign(this, { timeoutMs, queueTimeoutMs, maxQueuedChars, maxQueue, workerPath });
    this.queue = []; this.chars = 0; this.worker = null; this.active = null;
    this.closing = null; this.closed = false; this.serial = 0;
  }
  count(payload, { signal } = {}) {
    const started = performance.now();
    if (this.closed || signal?.aborted) return Promise.resolve(unavailable('cancelled', started));
    const work = preparePrompt(payload, { maxChars: 8 * 1024 * 1024, maxParts: 10000 });
    if (!work) return Promise.resolve(unavailable('text-limit', started));
    if (work.chars <= 4096 && work.parts.length <= 128) {
      const tokens = getTokenizer().countPromptTokens(payload);
      return Promise.resolve({ exact: true, tokens, mode: 'inline', elapsedMs: performance.now() - started, queueMs: 0 });
    }
    if (this.queue.length >= this.maxQueue || this.chars + work.chars > this.maxQueuedChars) {
      return Promise.resolve(unavailable('queue-limit', started));
    }
    return new Promise(resolve => {
      const job = { id: ++this.serial, work, started, resolve, signal, done: false };
      job.abort = () => this.finish(job, unavailable('cancelled', started), true);
      signal?.addEventListener('abort', job.abort, { once: true });
      this.chars += work.chars;
      this.queue.push(job);
      // 队列也有总等待上限，不能无限占着请求和 prompt。
      job.queueTimer = setTimeout(() => this.finish(job, unavailable('queue-timeout', started), true), this.queueTimeoutMs);
      this.pump();
    });
  }
  pump() {
    if (this.closed || this.active || this.closing || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    clearTimeout(job.queueTimer);
    job.queueMs = performance.now() - job.started;
    if (!this.worker) {
      let worker;
      try { worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 } }); }
      catch { this.finish(job, unavailable('worker-error', job.started)); return; }
      this.worker = worker;
      worker.on('message', value => {
        const job = this.active;
        if (job && value.id === job.id) this.finish(job, { ...value, elapsedMs: performance.now() - job.started, queueMs: job.queueMs });
      });
      worker.on('error', () => this.failed(worker));
      worker.on('exit', () => this.failed(worker));
      worker.unref();
    }
    this.worker.ref();
    job.timer = setTimeout(() => this.finish(job, unavailable('worker-timeout', job.started), true), this.timeoutMs);
    try { this.worker.postMessage({ id: job.id, work: job.work }); }
    catch { this.finish(job, unavailable('worker-error', job.started), true); }
  }
  failed(worker) {
    if (this.worker !== worker) return;
    if (this.active) this.finish(this.active, unavailable('worker-error', this.active.started), true);
    else { this.worker = null; this.pump(); }
  }
  finish(job, value, stopWorker = false) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer); clearTimeout(job.queueTimer);
    job.signal?.removeEventListener('abort', job.abort);
    this.chars -= job.work.chars;
    job.work = null;
    if (this.active === job) {
      this.active = null;
      if (stopWorker && this.worker) {
        const worker = this.worker; this.worker = null;
        this.closing = worker.terminate().catch(() => {}).finally(() => { this.closing = null; this.pump(); });
      } else this.worker?.unref();
    } else this.queue = this.queue.filter(item => item !== job);
    job.resolve({ ...value, queueMs: job.queueMs ?? performance.now() - job.started });
    this.pump();
  }
  async close() {
    this.closed = true;
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) this.finish(job, unavailable('closed', job.started), true);
    if (this.worker) { const worker = this.worker; this.worker = null; await worker.terminate(); }
    await this.closing;
  }
}
let shared;
function countPrompt(payload, options) { shared ||= new PromptCounter(); return shared.count(payload, options); }
module.exports = { PromptCounter, countPrompt };
