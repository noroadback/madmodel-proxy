// 请求编排：认证、参数归一、预算预检、流式转发与工具调用补救。

'use strict';

const { normalizePayload, parseJsonBody, fitTokenBudget, estimatePromptBudget } = require('./payload');
const { translateUpstreamError, describeFailedStream } = require('./errors');
const { createAggregator } = require('./completion-aggregator');
const { getTokenizer } = require('./tokenizer');
const { createToolRecovery, toolsForbidden } = require('./tool-recovery');
const { getModelMeta } = require('./model-registry');
const { readReasoningDelta, normalizeCompletionReasoning, normalizeReasoningDelta } = require('./thinking');

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function recordFirstOutput(ctx, obj, thinkingField) {
  if (ctx.firstOutputAt !== undefined) return;
  const delta = obj?.choices?.[0]?.delta;
  if ((typeof delta?.content === 'string' && delta.content.length > 0) ||
      readReasoningDelta(delta, thinkingField) !== null ||
      (Array.isArray(delta?.tool_calls) && delta.tool_calls.some(tc =>
        (typeof tc?.function?.name === 'string' && tc.function.name.length > 0) ||
        (typeof tc?.function?.arguments === 'string' && tc.function.arguments.length > 0)))) {
    ctx.firstOutputAt = Date.now();
  }
}

// 均速反映整次请求的等待、生成和交付，不冒充服务端纯解码速度。
function performanceNote(ctx, usage, recovery = {}, now = Date.now()) {
  const parts = [];
  const firstMs = ctx.firstOutputAt - ctx.started;
  if (Number.isFinite(firstMs) && firstMs >= 0) parts.push(`首字 ${(firstMs / 1000).toFixed(1)}s`);
  const usages = recovery.retryAttempted ? [usage, recovery.retryUsage] : [usage];
  const elapsedMs = now - ctx.started;
  if (elapsedMs > 0 && Number.isFinite(elapsedMs) && usages.every(u =>
    Number.isFinite(u?.completion_tokens) && u.completion_tokens >= 0)) {
    // completion_tokens 已含思考，不再加 reasoning_tokens。
    const tokens = usages.reduce((n, u) => n + u.completion_tokens, 0);
    const rate = tokens * 1000 / elapsedMs;
    if (tokens > 0 && Number.isFinite(rate)) parts.push(`均速 ${rate.toFixed(1)} tok/s`);
  }
  return parts.length ? ` | ${parts.join(' · ')}` : '';
}

function createProxyService(deps) {
  const { config, tokenState, upstreamClient, onTunnelAuthLost, waitForCredentials, modelRegistry } = deps;
  let inflight = 0;

  function requestedModel(payload) {
    const m = payload && payload.model;
    return typeof m === 'string' ? m.trim() : '';
  }

  const metaFor = model => getModelMeta(config, modelRegistry, model);
  const clientAskedTools = payload => Array.isArray(payload?.tools) && payload.tools.length > 0;
  const recoverTools = createToolRecovery({ config, upstreamClient });

  function errorHeaders(result, status, extraHeaders) {
    return status === 429 && result.retryAfter
      ? { ...extraHeaders, 'Retry-After': result.retryAfter } : extraHeaders;
  }

  function reportTunnelAuthLost(result) {
    if (onTunnelAuthLost && config.tunnelMode &&
      result.type === 'upstream-error' && result.status >= 300 && result.status < 400) {
      onTunnelAuthLost();
    }
  }

  function logReq(req, status, started, size, note, model) {
    const where = model || (req?.method ? `${req.method} ${String(req.url || '').split('?')[0]}` : '');
    const detail = String(note || '').replace(/\s+/g, ' ').trim();
    console.log(`[${stamp()}] ${String(where).replace(/\s+/g, ' ')} ${status} ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s` +
      (!model && size ? ` ${(size / 1024).toFixed(0)}KB` : '') + (detail ? ` ${detail}` : ''));
  }

  function idleNote(result) {
    return Number.isFinite(result?.idleMs) ? ` idle=${(result.idleMs / 1000).toFixed(1)}s` : '';
  }

  const tokTotal = { p: 0, c: 0 };
  function usageNote(...usages) {
    const known = usages.filter(u => u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number');
    if (!known.length) return '';
    const p = known.reduce((n, u) => n + u.prompt_tokens, 0);
    const c = known.reduce((n, u) => n + u.completion_tokens, 0);
    const r = known.reduce((n, u) => {
      const value = u.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens;
      return n + (typeof value === 'number' ? value : 0);
    }, 0);
    tokTotal.p += p;
    tokTotal.c += c;
    const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    return ` | token ${p}/${c}` + (r ? `(思考 ${r})` : '') +
      ` 累计 ${fmt(tokTotal.p)}/${fmt(tokTotal.c)}`;
  }

  function requestUsageNote(ctx, usage, recovery) {
    return usageNote(usage, recovery.retryUsage) + performanceNote(ctx, usage, recovery);
  }

  function authenticateRequest() {
    const ts = tokenState();
    if (ts.code === 'no-token') {
      return { error: { status: 503, message: '尚未登录，请运行 node refresh-token.js login' } };
    }
    if (ts.code === 'token-expired') {
      return { error: { status: 401, message: 'token 已过期，请等待自动续期；若未启动 watch，请运行 npm start。', type: 'auth_error' } };
    }
    return { token: ts.token, msLeft: ts.msLeft, cookie: ts.cookie };
  }

  // 常规请求强制上游 SSE，客户端的非流式响应由 aggregateResponse 聚合。
  function preparePayload(ctx) {
    let payload;
    try {
      payload = parseJsonBody(ctx.rawBody);
    } catch (e) {
      return { error: { status: 400, message: e.message } };
    }
    const clientWantsStream = payload.stream === true;
    payload.stream = true;
    if (!payload.stream_options || typeof payload.stream_options !== 'object' || Array.isArray(payload.stream_options)) {
      payload.stream_options = { include_usage: true };
    } else {
      payload.stream_options.include_usage = payload.stream_options.include_usage === false ? false : true;
    }
    const model = requestedModel(payload);
    const limits = typeof config.limitsFor === 'function' ? config.limitsFor(model) : null;
    normalizePayload(payload, model, metaFor(model),
      limits ? limits.maxOutputTokens : undefined);
    downgradeToolsFor(payload, model);
    return {
      payload, clientWantsStream,
      contextWindow: limits ? limits.contextWindow : config.contextWindow,
      promptTokenMarginRatio: limits?.promptTokenMarginRatio || 0,
    };
  }

  // Qwen 当前拒绝原生工具参数；保留定义供文本恢复，明确的客户端 none 不改。
  function downgradeToolsFor(payload, model) {
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
    const rejects = typeof config.rejectsTools === 'function' && config.rejectsTools(model);
    if (!hasTools || !rejects || toolsForbidden(payload)) return;
    payload.__clientToolChoice = payload.tool_choice;
    payload.tool_choice = 'none';
    payload.__toolsDowngraded = true;
  }

  function mapResult(result, prefix, sentBytes) {
    switch (result.type) {
      case 'timeout':
        if (result.phase === 'idle') {
          return { status: 504, note: 'idle-timeout',
            message: `上游 ${config.streamIdleTimeout / 1000}s 无数据，请重试。` };
        }
        if (result.phase === 'headers') {
          const message = `上游 ${config.upstreamHeaderTimeout / 1000}s 未响应，请检查网络或稍后重试。`;
          return { status: 502, note: 'headers-timeout', message };
        }
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'protocol-error':
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'network-error':
        return { status: 502, note: 'network-error',
          message: `连接上游失败: ${String(result.cause).slice(0, 120)}` };
      default:
        return null; // stream/completion/upstream-error/aborted 由调用方分支处理
    }
  }

  function failRequest(ctx, mapped) {
    logReq(ctx.req, mapped.status, ctx.started, ctx.size, `${mapped.note} ${mapped.message}`);
    if (!ctx.sseHeadersSent()) return ctx.sendError(mapped.status, mapped.message);
    ctx.endResponse();
  }

  async function handleRequest(ctx) {
    const auth = authenticateRequest();
    if (auth.error) {
      logReq(ctx.req, auth.error.status, ctx.started, ctx.size, auth.error.message);
      return ctx.sendError(auth.error.status, auth.error.message, auth.error.type);
    }
    const extraHeaders = auth.msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};
    ctx.setExtraHeaders(extraHeaders);

    const prepared = preparePayload(ctx);
    if (prepared.error) {
      logReq(ctx.req, 400, ctx.started, ctx.size, prepared.error.message);
      return ctx.sendError(400, prepared.error.message);
    }
    const { payload, clientWantsStream, contextWindow, promptTokenMarginRatio } = prepared;

    const promptTokens = getTokenizer().countPromptTokens(payload);
    const estimate = estimatePromptBudget(payload, promptTokens, promptTokenMarginRatio);
    const fit = fitTokenBudget(promptTokens, payload, contextWindow, estimate);
    if (config.debugBudget) {
      // 仅排障时记录；本地拒绝、上游拒绝、断流和超时也保留预算依据。
      // 100 仅为本地日志的阶段标记，不向客户端发送额外 HTTP 响应。
      const outputBudgetForLog = payload.max_tokens === undefined ? '未指定'
        : typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
          ? payload.max_tokens : '无效';
      const budgetDetails = `预算[文本=${promptTokens} 模板=${estimate.baseReserveTokens}` +
        ` 工具=${estimate.toolReserveTokens} 文本误差=${estimate.marginTokens}` +
        ` 图片=${estimate.imageCount} 图像估值=${estimate.imageTokensEstimate}` +
        ` 图像余量=${estimate.imageMarginTokens} 来源=${estimate.imageEstimateSource}` +
        ` 输出=${outputBudgetForLog} 窗口=${contextWindow}]`;
      logReq(ctx.req, 100, ctx.started, ctx.size, budgetDetails, payload.model);
    }
    if (!fit.ok) {
      logReq(ctx.req, 413, ctx.started, ctx.size, fit.message, payload.model);
      return ctx.sendError(413, fit.message);
    }
    const budgetNote = config.debugBudget && fit.note ? ` 输出预算 ${payload.max_tokens}` : '';
    const budgetHint = {
      ...estimate, promptTokens, contextWindow,
      tokenBudget: typeof payload.max_tokens === 'number' ? payload.max_tokens : 0,
    };

    const ac = ctx.abortController;
    let inflightHeld = false;
    const hold = () => {
      if (inflightHeld) return true;
      if (inflight >= config.inflightHardLimit) {
        logReq(ctx.req, 429, ctx.started, ctx.size, `并发已满 ${inflight}/${config.inflightHardLimit}`, payload.model);
        ctx.sendError(429, `并发请求已达上限 ${config.inflightHardLimit}，请降低并发或稍后重试。`, 'rate_limit');
        return false;
      }
      inflightHeld = true;
      inflight++;
      return true;
    };
    const release = () => { if (inflightHeld) { inflightHeld = false; inflight--; } };
    if (!hold()) return;
    try {
      const attempt = a => clientWantsStream
        ? streamPassthrough(ctx, payload, a, extraHeaders, budgetNote, ac, budgetHint)
        : aggregateResponse(ctx, payload, a, extraHeaders, budgetNote, ac, budgetHint);
      let r = await attempt(auth);
      if (r && r.retryAuth) {
        if (config.tunnelMode && waitForCredentials) {
          release(); // 等待期间无上游请求,不占并发槽
          const fresh = await sharedCredentialWait(auth.token, auth.cookie);
          if (ctx.clientGone()) return;
          if (fresh) {
            if (!hold()) return;
            logReq(ctx.req, 100, ctx.started, ctx.size, '凭据已更新，重试中');
            const a2 = { token: fresh.token, cookie: fresh.cookie };
            const r2 = await attempt(a2);
            if (!(r2 && r2.retryAuth)) return; // 重试已交付响应(成功或错误)
            logReq(ctx.req, 502, ctx.started, ctx.size, 'WebVPN 新凭据被拒绝，请重新登录');
            return ctx.sendError(502,
              'WebVPN 会话已失效，新凭据仍被拒绝。请运行 node refresh-token.js login。',
              'upstream_error', extraHeaders);
          }
          logReq(ctx.req, 502, ctx.started, ctx.size,
            `WebVPN 续期等待超时（${Math.round(config.waitRetryBudgetMs / 1000)}s）`);
          return ctx.sendError(502,
            `WebVPN 会话已失效，${Math.round(config.waitRetryBudgetMs / 1000)}s 内未完成续期。请确认 watch 在运行后重试。`,
            'upstream_error', extraHeaders);
        }
        if (ctx.clientGone()) return;
        logReq(ctx.req, 502, ctx.started, ctx.size, '上游要求重新登录，请检查地址与登录状态');
        return ctx.sendError(502,
          '上游要求重新登录，请检查上游地址与登录状态。',
          'upstream_error', extraHeaders);
      }
      return r;
    } finally {
      release();
    }
  }

  // 同一旧凭据的并发请求共享一次等待，避免重复监听。
  let inflightWait = null; // { key, promise }
  function sharedCredentialWait(usedToken, usedCookie) {
    const key = `${usedToken}\u0000${usedCookie || ''}`;
    if (!inflightWait || inflightWait.key !== key) {
      const promise = waitForCredentials(usedToken, usedCookie, config.waitRetryBudgetMs)
        .finally(() => { if (inflightWait && inflightWait.key === key) inflightWait = null; });
      inflightWait = { key, promise };
    }
    return inflightWait.promise;
  }

  async function writeRecovered(ctx, model, calls, content, usage) {
    const base = { id: `chatcmpl-toolfix-${Date.now().toString(36)}`,
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
    if (content) await ctx.writeSseChunk({ ...base, choices: [{ index: 0,
      delta: { role: 'assistant', content }, finish_reason: null }] });
    await ctx.writeSseChunk({ ...base, choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: calls.map((tc, index) => ({ ...tc, index })) },
      finish_reason: 'tool_calls' }] });
    if (usage) await ctx.writeSseChunk({ ...base, choices: [], usage });
    await ctx.writeSseLine('data: [DONE]\n\n');
    ctx.endResponse();
  }

  async function streamPassthrough(ctx, payload, auth, extraHeaders, budgetNote, ac, budgetHint) {
    const { req, started, size } = ctx;
    const servedModel = payload.model;
    // 思考即时发送；正文与收尾暂存，确认无需补救或解析结束后发送。
    const bufferFrames = config.toolCallFix && clientAskedTools(payload) && !toolsForbidden(payload);
    const spMeta = metaFor(payload.model);
    const streamThinkingField = spMeta && typeof spMeta.thinkingField === 'string' ? spMeta.thinkingField : null;
    if (typeof ctx.setThinkingFields === 'function') ctx.setThinkingFields(streamThinkingField);
    const buffered = [];
    let sawStructured = false;
    let streamFinish = null;
    let bufferFramesOff = false; // 见到结构化调用后停用缓冲,转逐帧透传
    let bufferedText = '';       // 缓冲期间累积的 content(用于"先从文本解析")
    let bufferedReasoning = '';  // 同时累积 reasoning(判据要看得见思考链,见下)

    const result = await upstreamClient.request({
      payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
      onChunk: async (obj) => {
        recordFirstOutput(ctx, obj, streamThinkingField);
        if (bufferFrames && !bufferFramesOff) {
          const ch = obj?.choices?.[0];
          const d = ch?.delta || {};
          if (Array.isArray(d.tool_calls) && d.tool_calls.length) sawStructured = true;
          if (typeof d.content === 'string') bufferedText += d.content;
          const rDelta = readReasoningDelta(d, streamThinkingField);
          if (rDelta !== null) bufferedReasoning += rDelta;
          if (ch?.finish_reason) streamFinish = ch.finish_reason;
          if (sawStructured) {
            ctx.ensureSseHeaders();
            for (const f of buffered) await ctx.writeSseChunk(f);
            buffered.length = 0;
            bufferFramesOff = true;
            await ctx.writeSseChunk(obj);
            return;
          }
          const hasHeld = (typeof d.content === 'string' && d.content !== '') ||
            (Array.isArray(d.tool_calls) && d.tool_calls.length) || ch?.finish_reason || obj?.usage;
          if (!hasHeld) {
            ctx.ensureSseHeaders();
            await ctx.writeSseChunk(obj);
            return;
          }
          // 混合帧先交付思考，避免替换正文时丢失它。
          if (rDelta !== null) {
            normalizeReasoningDelta(obj, streamThinkingField);
            const { reasoning_content, ...heldDelta } = obj.choices[0].delta;
            await ctx.writeSseChunk({ ...obj, usage: undefined,
              choices: [{ ...ch, delta: { reasoning_content }, finish_reason: null }] });
            obj = { ...obj, choices: [{ ...ch, delta: heldDelta }] };
          }
          buffered.push(obj);
          return; // content/tool_calls/finish 帧照旧扣留,等 finish 再决定
        }
        ctx.ensureSseHeaders();
        await ctx.writeSseChunk(obj);
      },
    });
    const flushBuffer = async () => {
      if (!buffered.length) return;
      ctx.ensureSseHeaders();
      for (const f of buffered) await ctx.writeSseChunk(f);
      buffered.length = 0;
    };

    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, '客户端已断开', servedModel);
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      if (!ctx.sseHeadersSent()) {
        ctx.dumpFailed();
        const mapped = translateUpstreamError(result.body, result.raw, result.status, budgetHint);
        logReq(req, mapped.http, started, size, mapped.message, servedModel);
        return ctx.sendError(mapped.http, mapped.message, mapped.type || 'upstream_error',
          errorHeaders(result, mapped.http, extraHeaders), mapped.code);
      }
      ctx.endResponse();
      logReq(req, 200, started, size, `回复中断 ${String(
        result.body?.errorMessage || result.body?.message || result.raw || ''
      ).slice(0, 120).replace(/\s+/g, ' ')}`, servedModel);
      return;
    }
    const mapped = mapResult(result, 'stream', ctx.sseBytes());
    if (mapped) {
      if (mapped.failedStream) {
        if (ctx.sseHeadersSent()) {
          ctx.endResponse();
          logReq(req, 200, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, servedModel);
        } else {
          logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, servedModel);
          ctx.sendError(502, mapped.message);
        }
        return;
      }
      return failRequest(ctx, mapped);
    }
    let recovery = {};
    let originalUsage = result.usage;
    if (result.type === 'stream' && bufferFrames && !sawStructured) {
      const body = { choices: [{ message: { content: bufferedText, reasoning_content: bufferedReasoning },
        finish_reason: streamFinish }], usage: result.usage };
      recovery = await recoverTools(body, payload, auth, ac.signal, streamThinkingField);
      if (ctx.clientGone()) return;
      if (recovery.recovered) {
        const msg = body.choices[0].message;
        await writeRecovered(ctx, servedModel, msg.tool_calls, msg.content, body.usage);
        logReq(req, 200, started, size,
          `${recovery.note}${budgetNote}${requestUsageNote(ctx, originalUsage, recovery)}`, servedModel);
        return;
      }
    }
    await flushBuffer();
    if (result.type === 'completion') {
      originalUsage = result.body.usage;
      recovery = await recoverTools(result.body, payload, auth, ac.signal, streamThinkingField);
      if (ctx.clientGone()) return;
      const m = result.body.choices?.[0]?.message || {};
      const fbReasoning = readReasoningDelta(m, streamThinkingField);
      const chunk = {
        id: result.body.id,
        object: 'chat.completion.chunk',
        created: result.body.created,
        model: result.body.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            ...(m.content != null ? { content: m.content } : {}),
            ...(fbReasoning != null ? { reasoning_content: fbReasoning } : {}),
            ...(Array.isArray(m.tool_calls) ? {
              tool_calls: m.tool_calls.map((tc, i) => ({
                index: i, id: tc.id, type: tc.type, function: tc.function,
              })),
            } : {}),
          },
          finish_reason: result.body.choices?.[0]?.finish_reason ?? 'stop',
        }],
      };
      await ctx.writeSseChunk(chunk);
      if (result.body.usage) {
        await ctx.writeSseLine(`data: ${JSON.stringify({
          id: result.body.id, object: 'chat.completion.chunk', choices: [], usage: result.body.usage,
        })}\n\n`);
      }
      await ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `${recovery.note || '流式'}${budgetNote}${requestUsageNote(ctx, originalUsage, recovery)}`, servedModel);
      return;
    }
    if (ctx.sseHeadersSent()) {
      await ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `${recovery.note || '流式'}${budgetNote}${requestUsageNote(ctx, originalUsage, recovery)}`, servedModel);
    } else {
      logReq(req, 502, started, size, '上游返回空流', servedModel);
      ctx.sendError(502, '上游返回空流');
    }
  }

  async function aggregateResponse(ctx, payload, auth, extraHeaders, budgetNote, ac, budgetHint) {
    const { req, started, size } = ctx;
    const aggMeta = metaFor(payload.model);
    const aggThinkingField = aggMeta && typeof aggMeta.thinkingField === 'string' ? aggMeta.thinkingField : null;
    const agg = createAggregator(payload.model, aggThinkingField);
    let chunkCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!ctx.clientGone() && !ctx.headersSent()) {
        ctx.sendError(504, `生成超时（${config.nonstreamTotalTimeout / 1000}s），请缩短对话或改用流式。`);
      }
    }, config.nonstreamTotalTimeout);
    let result;
    try {
      result = await upstreamClient.request({
        payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
        onChunk: obj => { recordFirstOutput(ctx, obj, aggThinkingField); chunkCount++; agg.feed(obj); },
      });
    } finally { clearTimeout(timer); }

    if (timedOut) { // 504 已由定时器发出,这里只补日志
      logReq(req, 504, started, size, '生成超时，请缩短对话或改用流式', payload.model);
      return;
    }
    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, '客户端已断开', payload.model);
      return;
    }
    if (result.type === 'upstream-error') {
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      ctx.dumpFailed();
      const mapped = translateUpstreamError(result.body, result.raw, result.status, budgetHint);
      logReq(req, mapped.http, started, size, mapped.message, payload.model);
      return ctx.sendError(mapped.http, mapped.message, mapped.type || 'upstream_error',
        errorHeaders(result, mapped.http, extraHeaders), mapped.code);
    }
    const mapped = mapResult(result, 'agg');
    if (mapped) {
      if (mapped.failedStream) {
        logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message}`, payload.model);
        return ctx.sendError(502, mapped.message);
      }
      return failRequest(ctx, mapped);
    }
    if (result.type !== 'completion' && chunkCount === 0) {
      logReq(req, 502, started, size, '上游返回空流', payload.model);
      return ctx.sendError(502, '上游返回空流');
    }
    const out = result.type === 'completion' ? result.body : agg.result();
    normalizeCompletionReasoning(out, aggThinkingField);
    const originalUsage = result.type === 'completion' ? out.usage : agg.usage;
    const recovery = await recoverTools(out, payload, auth, ac.signal, aggThinkingField);
    if (ctx.clientGone()) return;
    logReq(req, 200, started, size,
      `${recovery.note || '完成'}${budgetNote}${requestUsageNote(ctx, originalUsage, recovery)}`, payload.model);
    ctx.sendJson(200, out, extraHeaders);
  }

  return { handleRequest, logReq, usageNote };
}

module.exports = { createProxyService, performanceNote };
