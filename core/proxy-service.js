// 请求编排：认证、参数归一、预算预检与流式转发。

'use strict';

const { normalizePayload, parseJsonBody, fitTokenBudget, estimatePromptBudget } = require('./payload');
const { translateUpstreamError, describeFailedStream } = require('./errors');
const { createAggregator } = require('./completion-aggregator');
const { getTokenizer } = require('./tokenizer');
const { getModelMeta } = require('./model-registry');
const { readReasoningDelta, normalizeCompletionReasoning, normalizeReasoningDelta } = require('./thinking');
const { startOutputTiming, recordOutput, completeOutputTiming, performanceNote } = require('./request-metrics');
const { createHash } = require('crypto');
const { performance } = require('node:perf_hooks');
const { failureDiagnosticNote } = require('./failure-diagnostics');
const { canRetryToolPrefix, createToolPrelude, hasRealToolArguments } = require('./tool-prefix-retry');

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

// 原生工具调用的 arguments 在 SSE 中通常被拆成多帧。只有整段拼完后，
// 才能判断它是否是客户端可以安全写入下一轮请求的 JSON。实时模式可以
// 交付未完成的参数，但只有严格校验通过才确认成功；失败必须明确报错。
function toolCallIssue(calls) {
  if (!Array.isArray(calls) || !calls.length) return { reason: '缺少工具调用' };
  const ids = new Set();
  for (let index = 0; index < calls.length; index++) {
    const tc = calls[index];
    if (!tc || tc.type !== 'function' || typeof tc.id !== 'string' || !tc.id ||
        typeof tc.function?.name !== 'string' || !tc.function.name ||
        typeof tc.function.arguments !== 'string') return { index, reason: '调用字段缺失或类型无效' };
    if (ids.has(tc.id)) return { index, reason: '工具调用 ID 重复' };
    ids.add(tc.id);
    try {
      const args = JSON.parse(tc.function.arguments);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return { index, reason: '参数不是 JSON 对象' };
    } catch (error) {
      // V8 的错误消息可能包含整段命令，只提取类别和数值位置。
      const reason = /Unterminated string/i.test(error.message) ? 'JSON 字符串未闭合'
        : /Unexpected end/i.test(error.message) ? 'JSON 未完成' : 'JSON 语法无效';
      const position = /position (\d+)/i.exec(error.message)?.[1];
      return { index, reason, position };
    }
  }
  return null;
}

const validToolCalls = calls => !toolCallIssue(calls);

function recordArguments(states, obj) {
  const calls = obj?.choices?.[0]?.delta?.tool_calls;
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    if (!Number.isSafeInteger(call?.index) || typeof call.function?.arguments !== 'string') continue;
    if (!states.has(call.index)) states.set(call.index, { hash: createHash('sha256'), chars: 0, fragments: 0 });
    const state = states.get(call.index), args = call.function.arguments;
    state.hash.update(args);
    state.chars += args.length;
    state.fragments++;
  }
}

function toolCallNote(calls, aggregate, result, transfer = '未转发') {
  const issue = toolCallIssue(calls) || { reason: '工具字段无效' };
  const index = issue.index ?? 0, call = calls?.[index];
  const tool = /^[A-Za-z0-9_.-]{1,64}$/.test(call?.function?.name || '') ? call.function.name : '未知';
  const finish = aggregate?.finish ?? result.body?.choices?.[0]?.finish_reason;
  const finishLabel = ['stop', 'length', 'tool_calls', 'content_filter'].includes(finish) ? finish : '未提供';
  const usage = result.usage ?? result.body?.usage;
  return `原因=${aggregate?.invalidToolReason || issue.reason} 调用=${index} 工具=${tool}` +
    ` 参数=${typeof call?.function?.arguments === 'string' ? call.function.arguments.length : 0}字符` +
    (aggregate ? ` 片段=${Object.values(aggregate.argumentFragments).reduce((a, b) => a + b, 0)}` : '') +
    (issue.position ? ` JSON位置=${issue.position}` : '') +
    ` 上游结束=${finishLabel} 参数转发=${transfer}` +
    (Number.isFinite(usage?.completion_tokens) ? ` 输出=${usage.completion_tokens}` : '');
}

function hasInvalidToolCalls(body) {
  const choice = body?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  // JSON 备用响应与非流式聚合也必须拒绝错误的集合形状，不能在转换成
  // SSE 时静默丢掉非数组字段，再用 tool_calls 结束原因确认一次空调用。
  if (calls == null) return choice?.finish_reason === 'tool_calls';
  if (!Array.isArray(calls)) return true;
  return calls.length ? !validToolCalls(calls) : choice?.finish_reason === 'tool_calls';
}

// Qwen 指定工具时可能把合法原生调用标成 stop。只修正已完成的调用，
// length 等截断或错误结束原因必须原样保留。
function normalizeToolCallFinish(choice, calls = choice?.message?.tool_calls) {
  if (choice?.finish_reason === 'stop' && validToolCalls(calls)) {
    choice.finish_reason = 'tool_calls';
  }
}

function createProxyService(deps) {
  const { config, tokenState, upstreamClient, onTunnelAuthLost, waitForCredentials, modelRegistry } = deps;
  let inflight = 0;

  function requestedModel(payload) {
    const m = payload && payload.model;
    return typeof m === 'string' ? m.trim() : '';
  }

  const metaFor = model => getModelMeta(config, modelRegistry, model);

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
  function usageNote(usage) {
    const valid = n => Number.isFinite(n) && n >= 0;
    if (!valid(usage?.prompt_tokens) || !valid(usage?.completion_tokens)) return '';
    const p = usage.prompt_tokens;
    const c = usage.completion_tokens;
    const reasoning = usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
    const details = [];
    if (valid(reasoning) && reasoning > 0) details.push(`思考 ${reasoning}`);
    for (const [field, label] of [['image_tokens', '图片'], ['cached_tokens', '缓存']]) {
      const value = usage.prompt_tokens_details?.[field];
      if (valid(value)) details.push(`${label} ${value}`);
    }
    tokTotal.p += p;
    tokTotal.c += c;
    const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    return ` | token ${p}/${c}` + (details.length ? `(${details.join(' · ')})` : '') +
      ` 累计 ${fmt(tokTotal.p)}/${fmt(tokTotal.c)}`;
  }

  function requestUsageNote(ctx, usage) {
    return usageNote(usage) + performanceNote(ctx, usage);
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
    return {
      payload, clientWantsStream,
      contextWindow: limits ? limits.contextWindow : config.contextWindow,
      promptTokenMarginRatio: limits?.promptTokenMarginRatio || 0,
    };
  }

  function mapResult(result, prefix, sentBytes) {
    const diagnostic = ['timeout', 'protocol-error', 'network-error'].includes(result.type)
      ? failureDiagnosticNote(config, result) : '';
    switch (result.type) {
      case 'timeout':
        if (result.phase === 'idle') {
          return { status: 504, note: 'idle-timeout', diagnostic,
            message: `上游 ${config.streamIdleTimeout / 1000}s 无数据，请重试。` };
        }
        if (result.phase === 'headers') {
          const message = `上游 ${config.upstreamHeaderTimeout / 1000}s 未响应，请检查网络或稍后重试。`;
          return { status: 502, note: 'headers-timeout', message, diagnostic };
        }
        return { status: 502, failedStream: true, diagnostic, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'protocol-error':
        return { status: 502, failedStream: true, diagnostic, ...describeFailedStream(result, prefix, config, sentBytes) };
      case 'network-error':
        return { status: 502, note: 'network-error',
          message: `${result.phase === 'delivery' ? '向客户端交付失败' : result.phase === 'response-body' ? '读取上游响应失败' : '连接上游失败'}: ${String(result.cause).slice(0, 120)}` +
            (result.codes?.length ? `（${result.codes.join('/')}）` : ''),
          diagnostic: (result.phase ? `阶段=${result.phase} 请求体=${result.requestBytes}B 已收=${result.receivedBytes}B` +
            (result.responseStatus !== null ? ` 上游HTTP=${result.responseStatus}` : '') : '') +
            (diagnostic ? ` ${diagnostic}` : '') };
      default:
        return null; // stream/completion/upstream-error/aborted 由调用方分支处理
    }
  }

  function toolFailureDiagnostic(result, aggregate, calls, transfer = '未转发') {
    if (!config.diagnosticsEnabled || !result?.diagnostics) return '';
    const issue = toolCallIssue(calls);
    const details = { kind: 'invalid-tool-call',
      validation: aggregate?.invalidToolReason ? 'id-conflict' : ({
        'JSON 字符串未闭合': 'json-incomplete', 'JSON 未完成': 'json-incomplete',
        'JSON 语法无效': 'json-invalid', '工具调用 ID 重复': 'duplicate-id',
      })[issue?.reason] || 'shape',
      forwardingComparison: ({ '一致': 'match', '不一致': 'mismatch',
        '未转发': 'not-forwarded', '未收到参数': 'no-arguments' })[transfer] || 'not-checked' };
    if (!aggregate?.invalidToolCalls && Array.isArray(calls) &&
        calls.every(call => typeof call?.function?.arguments === 'string')) {
      details.toolArguments = aggregate
        ? Object.entries(aggregate.toolCalls).map(([index, call]) => ({ index: Number(index), arguments: call.function.arguments }))
        : calls.map((call, index) => ({ index, arguments: call.function.arguments }));
    }
    return failureDiagnosticNote(config, result, details);
  }

  function failRequest(ctx, mapped, model) {
    const streaming = ctx.sseHeadersSent();
    logReq(ctx.req, streaming ? 200 : mapped.status, ctx.started, ctx.size,
      `${mapped.note}${streaming ? ` 流内错误=${mapped.status}` : ''} ${mapped.message} ${mapped.diagnostic || ''}`, model);
    if (!streaming) return ctx.sendError(mapped.status, mapped.message);
    ctx.sendStreamError(mapped.message, 'upstream_error', mapped.status);
  }

  async function handleRequest(ctx) {
    const auth = authenticateRequest();
    if (auth.error) {
      logReq(ctx.req, auth.error.status, ctx.started, ctx.size, auth.error.message);
      return ctx.sendError(auth.error.status, auth.error.message, auth.error.type);
    }
    const extraHeaders = auth.msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};
    ctx.setExtraHeaders(extraHeaders);

    const ac = ctx.abortController;
    let payload;
    let inflightHeld = false;
    const hold = () => {
      if (inflightHeld) return true;
      if (inflight >= config.inflightHardLimit) {
        logReq(ctx.req, 429, ctx.started, ctx.size, `并发已满 ${inflight}/${config.inflightHardLimit}`, payload?.model);
        ctx.sendError(429, `并发请求已达上限 ${config.inflightHardLimit}，请降低并发或稍后重试。`, 'rate_limit');
        return false;
      }
      inflightHeld = true;
      inflight++;
      return true;
    };
    const release = () => { if (inflightHeld) { inflightHeld = false; inflight--; } };
    // 过载时先拒绝，不解析大 JSON 或同步分词；所有预检出口都归还槽位。
    if (!hold()) return;
    try {
      const prepared = preparePayload(ctx);
      if (prepared.error) {
        logReq(ctx.req, 400, ctx.started, ctx.size, prepared.error.message);
        return ctx.sendError(400, prepared.error.message);
      }
      const { clientWantsStream, contextWindow, promptTokenMarginRatio } = prepared;
      payload = prepared.payload;
      const promptTokens = getTokenizer().countPromptTokens(payload);
      const estimate = estimatePromptBudget(payload, promptTokens, promptTokenMarginRatio);
      const fit = fitTokenBudget(promptTokens, payload, contextWindow, estimate);
      if (config.debugBudget) {
        // 100 仅为日志阶段标记；本地拒绝、上游拒绝和断流均保留预算依据。
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
      // Shared across authentication refreshes as well as generation attempts.
      let toolRetries = 0;
      const attempt = async a => {
        const nonstreamDeadline = performance.now() + config.nonstreamTotalTimeout;
        for (;;) {
          const allowToolRetry = config.toolRetryEnabled !== false && toolRetries === 0 && payload.tool_choice !== 'none';
          const note = budgetNote + (toolRetries ? ' 工具参数重试=1' : '');
          const outcome = clientWantsStream
            ? await streamPassthrough(ctx, payload, a, extraHeaders, note, ac, budgetHint, allowToolRetry)
            : await aggregateResponse(ctx, payload, a, extraHeaders, note, ac, budgetHint, allowToolRetry, nonstreamDeadline);
          if (!outcome?.retryTool || !allowToolRetry || ctx.clientGone() || ac.signal.aborted) return outcome;
          toolRetries++;
          logReq(ctx.req, 100, ctx.started, ctx.size,
            `tool-arguments-retry 工具参数空前缀无效，尚未交付，重新生成 1/1 ${outcome.diagnostic || ''}${usageNote(outcome.usage)}`, payload.model);
        }
      };
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

  async function streamPassthrough(ctx, payload, auth, extraHeaders, budgetNote, ac, budgetHint, allowToolRetry) {
    const { req, started, size } = ctx;
    startOutputTiming(ctx);
    const servedModel = payload.model;
    // 默认实时交付正文、思考与工具参数；成功收尾等上游正常结束并校验。
    const incremental = config.toolStreamMode !== 'buffered';
    const spMeta = metaFor(payload.model);
    const streamThinkingField = spMeta && typeof spMeta.thinkingField === 'string' ? spMeta.thinkingField : null;
    if (typeof ctx.setThinkingFields === 'function') ctx.setThinkingFields(streamThinkingField);
    const buffered = [];
    let sawStructured = false;
    const structuredAgg = createAggregator(servedModel, streamThinkingField);
    const upstreamFinishes = new Set();
    const receivedArguments = new Map(), forwardedArguments = new Map();
    const writeDirect = async obj => {
      await ctx.writeSseChunk(obj);
      recordArguments(forwardedArguments, obj);
    };
    const prelude = allowToolRetry && Array.isArray(payload.tools) && payload.tools.some(tool => tool?.type === 'function')
      ? createToolPrelude({ write: writeDirect, signal: ac.signal, onError: () => {
        if (!ctx.clientGone() && !ac.signal.aborted) ctx.sendStreamError('向客户端交付回复失败，请重试。', 'proxy_error', 502);
        ac.abort();
      } }) : null;
    const writeChunk = obj => prelude ? prelude.write(obj) : writeDirect(obj);
    const invalidToolNote = (calls, result) => {
      const checkForwarding = incremental && !prelude?.canRetry;
      let transfer = checkForwarding ? (receivedArguments.size ? '一致' : '未收到参数') : '未转发';
      if (checkForwarding) {
        if (receivedArguments.size !== forwardedArguments.size) transfer = '不一致';
        for (const [key, source] of receivedArguments) {
          const target = forwardedArguments.get(key);
          if (!target || source.fragments !== target.fragments || source.chars !== target.chars ||
              source.hash.copy().digest('hex') !== target.hash.copy().digest('hex')) transfer = '不一致';
        }
      }
      return toolCallNote(calls, structuredAgg, result, transfer) +
        ` ${toolFailureDiagnostic(result, structuredAgg, calls, transfer)}`;
    };

    let result;
    try { result = await upstreamClient.request({
      payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
      onChunk: async (obj, timing) => {
        recordOutput(ctx, obj, streamThinkingField, timing?.receivedAt);
        const ch = obj?.choices?.[0];
        const d = ch?.delta || {};
        const hasStructured = Array.isArray(d.tool_calls) && d.tool_calls.length > 0;
        if (hasStructured || (d.tool_calls != null && !Array.isArray(d.tool_calls))) {
          sawStructured = true;
          if (incremental && hasStructured && d.tool_calls.some(tc =>
            !Number.isSafeInteger(tc?.index) || tc.index < 0)) {
            // 实时交付必须明确每片属于哪个调用；客户端与旧聚合器对缺
            // index 的默认行为不同，不能校验一个集合却交付另一个集合。
            const error = new Error('上游工具调用索引无效');
            error.code = 'UPSTREAM_TOOL_INDEX';
            throw error;
          }
          // 只累计待校验的工具参数，不重复缓存已交付的正文、思考和原始帧。
          structuredAgg.feed({ choices: [{ delta: { tool_calls: d.tool_calls } }] });
          recordArguments(receivedArguments, obj);
          if (incremental && structuredAgg.invalidToolCalls) {
            const error = new Error(structuredAgg.invalidToolReason || '上游返回的工具调用字段无效');
            error.code = 'UPSTREAM_TOOL_CALL';
            throw error;
          }
        }
        if (ch?.finish_reason) {
          structuredAgg.finish = ch.finish_reason;
          upstreamFinishes.add(ch.finish_reason);
        }
        if (ch?.finish_reason === 'tool_calls') sawStructured = true;
        const rDelta = readReasoningDelta(d, streamThinkingField);
        // Buffered mode holds tools separately; observing real arguments still
        // releases any small reasoning prelude without releasing the tools.
        if (!incremental && hasRealToolArguments(obj)) await prelude?.flush();

        if (incremental) {
          // 最后一段参数可能与 finish/usage 同帧。参数现在就发，收尾拆开
          // 扣留；否则 SDK 会在上游断流或校验失败前把调用标成成功。
          const hasTerminal = ch?.finish_reason || obj?.usage;
          if (hasTerminal) {
            buffered.push(ch ? { ...obj, choices: [{ ...ch, delta: {} }] } : obj);
            if (Object.keys(d).length) {
              await writeChunk({ ...obj, usage: undefined,
                choices: [{ ...ch, finish_reason: null }] });
            }
          } else {
            await writeChunk(obj);
          }
          return;
        }

        // 一旦出现结构化工具调用，后续所有会影响消息完成状态的帧都留在
        // 缓冲中，直到 upstream-client 确认收到了 [DONE]。这样断流时只能
        // 关闭不完整响应，绝不会把半截 function.arguments 交给下游。
        if (sawStructured) {
          let held = obj;
          // 混合帧先交付思考，工具调用本身仍扣留。
          if (rDelta !== null) {
            normalizeReasoningDelta(held, streamThinkingField);
            const { reasoning_content, ...heldDelta } = held.choices[0].delta;
            await writeChunk({ ...held, usage: undefined,
              choices: [{ ...ch, delta: { reasoning_content }, finish_reason: null }] });
            held = { ...held, choices: [{ ...ch, delta: heldDelta }] };
          }
          const heldCh = held?.choices?.[0];
          const heldDelta = heldCh?.delta || {};
          const hasHeld = (typeof heldDelta.content === 'string' && heldDelta.content !== '') ||
            (Array.isArray(heldDelta.tool_calls) && heldDelta.tool_calls.length) ||
            heldCh?.finish_reason || held?.usage;
          if (hasHeld) buffered.push(held);
          return;
        }

        await writeChunk(obj);
      },
    }); } finally { prelude?.freeze(); }
    // DONE 的上游到达时间先冻结，最终校验/冲刷不计入输出速度。
    completeOutputTiming(ctx, result);
    const deliverFinal = async write => {
      // 上游结束后它的总计时器已清理。全部最终写入共用交付时限，包含
      // 缓冲冲刷、JSON 备用响应、usage 和 [DONE]，不能只保护 buffered。
      let deliveryTimedOut = false;
      const timer = setTimeout(() => {
        deliveryTimedOut = true;
        ctx.sendStreamError('向客户端交付回复超时，请重试。', 'proxy_error', 504);
        ac.abort();
      }, config.streamTotalTimeout);
      try {
        if (ac.signal.aborted || ctx.clientGone()) return false;
        await write();
        return !ac.signal.aborted && !ctx.clientGone();
      } catch (error) {
        if (!deliveryTimedOut && !ctx.clientGone() && !ac.signal.aborted) throw error;
        return false;
      } finally {
        clearTimeout(timer);
        buffered.length = 0;
        if (deliveryTimedOut || ctx.clientGone()) {
          const diagnostic = failureDiagnosticNote(config, result,
            { kind: deliveryTimedOut ? 'delivery-timeout' : 'client-cancelled' });
          logReq(req, ctx.clientGone() ? 499 : 200, started, size,
            (deliveryTimedOut ? 'stream-delivery-timeout 向客户端交付回复超时' : '客户端已断开') +
              ` ${diagnostic}`, servedModel);
        }
      }
    };

    if (ctx.clientGone() || result.type === 'aborted') {
      prelude?.discard();
      logReq(req, 499, started, size, `客户端已断开 ${failureDiagnosticNote(config, result, { kind: 'client-cancelled' })}`, servedModel);
      return;
    }
    if (result.type === 'upstream-error') {
      prelude?.discard();
      const diagnostic = failureDiagnosticNote(config, result);
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      if (!ctx.sseHeadersSent()) {
        ctx.dumpFailed();
        const mapped = translateUpstreamError(result.body, result.raw, result.status, budgetHint);
        logReq(req, mapped.http, started, size, `${mapped.message} ${diagnostic}`, servedModel);
        return ctx.sendError(mapped.http, mapped.message, mapped.type || 'upstream_error',
          errorHeaders(result, mapped.http, extraHeaders), mapped.code);
      }
      const mapped = translateUpstreamError(result.body, result.raw, result.status, budgetHint);
      ctx.sendStreamError(mapped.message, mapped.type || 'upstream_error', mapped.code ?? mapped.http);
      logReq(req, 200, started, size, `回复中断 ${mapped.message} ${diagnostic}`, servedModel);
      return;
    }
    const mapped = mapResult(result, 'stream', ctx.sseBytes());
    if (mapped) {
      prelude?.discard();
      if (mapped.failedStream) {
        if (ctx.sseHeadersSent()) {
          ctx.sendStreamError(mapped.message, 'upstream_error', mapped.status);
          logReq(req, 200, started, size, `${mapped.note}${idleNote(result)} ${mapped.message} ${mapped.diagnostic}`, servedModel);
        } else {
          logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message} ${mapped.diagnostic}`, servedModel);
          ctx.sendError(502, mapped.message);
        }
        return;
      }
      return failRequest(ctx, mapped, servedModel);
    }
    if (result.type === 'stream' && sawStructured) {
      const calls = structuredAgg.result().choices?.[0]?.message?.tool_calls;
      if (structuredAgg.invalidToolCalls || !validToolCalls(calls)) {
        const diagnostic = invalidToolNote(calls, result);
        if (allowToolRetry && !structuredAgg.invalidToolCalls && upstreamFinishes.size === 1 && !ctx.headersSent() &&
            (!prelude || prelude.canRetry) && canRetryToolPrefix(calls, payload.tools, structuredAgg.finish)) {
          prelude?.discard();
          return { retryTool: true, diagnostic, usage: result.usage };
        }
        prelude?.discard();
        const message = '上游返回的工具调用参数不是有效 JSON，请重试。';
        if (ctx.sseHeadersSent()) {
          ctx.sendStreamError(message, 'upstream_error', 502);
          logReq(req, 200, started, size, `stream-invalid-tool-call 流内错误=502 ${message} ${diagnostic}`, servedModel);
        } else {
          logReq(req, 502, started, size, `${message} ${diagnostic}`, servedModel);
          ctx.sendError(502, message);
        }
        return;
      }
      for (const frame of buffered) normalizeToolCallFinish(frame.choices?.[0], calls);
      if (incremental && !buffered.some(frame => frame.choices?.[0]?.finish_reason)) {
        // 部分部署仅以 [DONE] 结束合法调用。校验通过后补独立的结束原因，
        // 与非流式聚合的默认 stop → tool_calls 保持一致。
        buffered.unshift({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }
    }
    let completionChunk = null;
    if (result.type === 'completion') {
      if (hasInvalidToolCalls(result.body)) {
        const message = '上游返回的工具调用参数不是有效 JSON，请重试。';
        const calls = result.body?.choices?.[0]?.message?.tool_calls;
        if (allowToolRetry && !ctx.headersSent() && canRetryToolPrefix(calls, payload.tools, result.body?.choices?.[0]?.finish_reason)) {
          const diagnostic = `${toolCallNote(calls, null, result)} ${toolFailureDiagnostic(result, null, calls)}`;
          prelude?.discard();
          return { retryTool: true, diagnostic, usage: result.body.usage };
        }
        logReq(req, 502, started, size, `${message} ${toolCallNote(calls, null, result)} ${toolFailureDiagnostic(result, null, calls)}`, servedModel);
        return ctx.sendError(502, message);
      }
      normalizeToolCallFinish(result.body.choices?.[0]);
      const m = result.body.choices?.[0]?.message || {};
      const fbReasoning = readReasoningDelta(m, streamThinkingField);
      completionChunk = {
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
    }
    if (!completionChunk && !buffered.length && !prelude?.hasPending && !ctx.sseHeadersSent()) {
      prelude?.discard();
      logReq(req, 502, started, size, `上游返回空流 ${failureDiagnosticNote(config, result, { kind: 'empty-stream' })}`, servedModel);
      return ctx.sendError(502, '上游返回空流');
    }
    const delivered = await deliverFinal(async () => {
      await prelude?.flush();
      if (ac.signal.aborted || ctx.clientGone()) return;
      ctx.ensureSseHeaders();
      for (const frame of buffered) {
        if (ac.signal.aborted || ctx.clientGone()) return;
        await ctx.writeSseChunk(frame);
      }
      if (completionChunk) {
        if (ac.signal.aborted || ctx.clientGone()) return;
        await ctx.writeSseChunk(completionChunk);
        if (result.body.usage) {
          if (ac.signal.aborted || ctx.clientGone()) return;
          await ctx.writeSseLine(`data: ${JSON.stringify({
            id: result.body.id, object: 'chat.completion.chunk', choices: [], usage: result.body.usage,
          })}\n\n`);
        }
      }
      if (ac.signal.aborted || ctx.clientGone()) return;
      await ctx.writeSseLine('data: [DONE]\n\n');
      if (ac.signal.aborted || ctx.clientGone()) return;
      ctx.endResponse();
    });
    if (delivered) {
      const usage = result.type === 'completion' ? result.body.usage : result.usage;
      logReq(req, 200, started, size, `流式${budgetNote}${requestUsageNote(ctx, usage)}`, servedModel);
    }
  }

  async function aggregateResponse(ctx, payload, auth, extraHeaders, budgetNote, ac, budgetHint, allowToolRetry, deadline) {
    const { req, started, size } = ctx;
    startOutputTiming(ctx);
    const aggMeta = metaFor(payload.model);
    const aggThinkingField = aggMeta && typeof aggMeta.thinkingField === 'string' ? aggMeta.thinkingField : null;
    const agg = createAggregator(payload.model, aggThinkingField);
    const upstreamFinishes = new Set();
    let chunkCount = 0;
    let timedOut = false;
    const remainingMs = Math.max(0, deadline - performance.now());
    if (remainingMs === 0) {
      logReq(req, 504, started, size, '工具参数重试前已达到非流式总时限', payload.model);
      return ctx.sendError(504, '生成超时，请缩短对话或改用流式。');
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!ctx.clientGone() && !ctx.headersSent()) {
        ctx.sendError(504, `生成超时（${config.nonstreamTotalTimeout / 1000}s），请缩短对话或改用流式。`);
      }
    }, remainingMs);
    let result;
    try {
      result = await upstreamClient.request({
        payload, token: auth.token, cookie: auth.cookie, signal: ac.signal,
        onChunk: (obj, timing) => {
          recordOutput(ctx, obj, aggThinkingField, timing?.receivedAt);
          chunkCount++;
          agg.feed(obj);
          if (obj?.choices?.[0]?.finish_reason) upstreamFinishes.add(obj.choices[0].finish_reason);
        },
      });
    } finally { clearTimeout(timer); }
    completeOutputTiming(ctx, result);

    if (timedOut) { // 504 已由定时器发出,这里只补日志
      logReq(req, 504, started, size, `生成超时，请缩短对话或改用流式 ${failureDiagnosticNote(config, result, { kind: 'aggregate-timeout' })}`, payload.model);
      return;
    }
    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, `客户端已断开 ${failureDiagnosticNote(config, result, { kind: 'client-cancelled' })}`, payload.model);
      return;
    }
    if (result.type === 'upstream-error') {
      const diagnostic = failureDiagnosticNote(config, result);
      reportTunnelAuthLost(result);
      if (!ctx.sseHeadersSent() &&
          result.status >= 300 && result.status < 400 &&
          String(result.location || '').includes('/login')) {
        return { retryAuth: true };
      }
      ctx.dumpFailed();
      const mapped = translateUpstreamError(result.body, result.raw, result.status, budgetHint);
      logReq(req, mapped.http, started, size, `${mapped.message} ${diagnostic}`, payload.model);
      return ctx.sendError(mapped.http, mapped.message, mapped.type || 'upstream_error',
        errorHeaders(result, mapped.http, extraHeaders), mapped.code);
    }
    const mapped = mapResult(result, 'agg');
    if (mapped) {
      if (mapped.failedStream) {
        logReq(req, 502, started, size, `${mapped.note}${idleNote(result)} ${mapped.message} ${mapped.diagnostic}`, payload.model);
        return ctx.sendError(502, mapped.message);
      }
      return failRequest(ctx, mapped, payload.model);
    }
    if (result.type !== 'completion' && chunkCount === 0) {
      logReq(req, 502, started, size, `上游返回空流 ${failureDiagnosticNote(config, result, { kind: 'empty-stream' })}`, payload.model);
      return ctx.sendError(502, '上游返回空流');
    }
    const out = result.type === 'completion' ? result.body : agg.result();
    normalizeCompletionReasoning(out, aggThinkingField);
    if ((result.type === 'stream' && agg.invalidToolCalls) || hasInvalidToolCalls(out)) {
      const message = '上游返回的工具调用参数不是有效 JSON，请重试。';
      const calls = out.choices?.[0]?.message?.tool_calls;
      const aggregate = result.type === 'stream' ? agg : null;
      if (allowToolRetry && !agg.invalidToolCalls && !ctx.headersSent() &&
          (result.type === 'completion' || upstreamFinishes.size === 1) &&
          canRetryToolPrefix(calls, payload.tools, result.type === 'stream' ? agg.finish : out.choices?.[0]?.finish_reason)) {
        return { retryTool: true, usage: result.type === 'completion' ? out.usage : agg.usage, diagnostic:
          `${toolCallNote(calls, aggregate, result)} ${toolFailureDiagnostic(result, aggregate, calls)}` };
      }
      logReq(req, 502, started, size,
        `${message} ${toolCallNote(calls, aggregate, result)} ${toolFailureDiagnostic(result, aggregate, calls)}`, payload.model);
      return ctx.sendError(502, message);
    }
    normalizeToolCallFinish(out.choices?.[0]);
    const usage = result.type === 'completion' ? out.usage : agg.usage;
    logReq(req, 200, started, size,
      `完成${budgetNote}${requestUsageNote(ctx, usage)}`, payload.model);
    ctx.sendJson(200, out, extraHeaders);
  }

  return { handleRequest, logReq, usageNote };
}

module.exports = { createProxyService, performanceNote };
