// core/proxy-service.js
// 代理业务流程(纯编排层,不含 HTTP I/O):
//   authenticate -> parse payload -> normalize -> call upstream -> map result
//   -> write response(经 ctx 回调)
// 请求读取、路由、响应写出、token 文件缓存都在 adapters/http-server.js;
// 上游协议在 core/upstream-client.js;判定与映射在这里。
// 每类上游结果只转换一次;客户端断开与聚合超时复用同一个 abort signal。
// 64 以内不设业务层限流(多子代理编排是合法负载);inflight 硬上限(不可配置)
// 只作进程保护,资源兜底的其余部分在 adapters 层:server.maxConnections、
// 请求体/响应体限额与各级超时。

'use strict';

const { normalizePayload, parseJsonBody } = require('./payload');
const { translateUpstreamError, describeFailedStream } = require('./errors');
const { createAggregator } = require('./completion-aggregator');

// 日志时间戳。固定 HH:MM:SS 而非 toLocaleTimeString:后者随机器 locale 变形
// (12 小时制/中文"下午"),日志被贴进 issue 时不可比对
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function estimateTokens(bodyBuffer) {
  // 无分词器的粗估,按字节类别分开计量(2026-09-09 实测 DeepSeek V4 分词器):
  // 中文 ≈4.8 字节/token、英文散文 ≈4、数字/代码 ≈3(最后一类会低估,漏网
  // 请求由上游秒级错误帧兜底)。旧的统一 bytes/3.5 对中文高估约 37%(把
  // 本可成功的中文长上下文提前 413)、对英文低估约 12%
  let ascii = 0, multibyte = 0;
  for (let i = 0; i < bodyBuffer.length; i++) {
    if (bodyBuffer[i] < 0x80) ascii++; else multibyte++;
  }
  return Math.round(ascii / 4 + multibyte / 4.8);
}

function createProxyService(deps) {
  const { config, tokenState, upstreamClient } = deps;
  // 活跃上游请求数(进程保护,见 handleRequest 的 inflight 硬上限)
  let inflight = 0;

  function logReq(req, status, started, size, note) {
    // method+path 进日志:排查"谁在打我"时区分 models 探活与 chat 请求
    const where = req?.method ? `${req.method} ${String(req.url || '').split('?')[0]} ` : '';
    console.log(`[${stamp()}] ${where}${status} ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s ${(size / 1024).toFixed(0)}KB ${note}`);
  }

  // 会话累计 token(仅内存,重启归零)。usageNote 在每条成功请求的日志处调用并
  // 顺带累加,调用点保持单行
  const tokTotal = { p: 0, c: 0, r: 0 };
  function usageNote(u) {
    if (!u || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return '';
    tokTotal.p += u.prompt_tokens;
    tokTotal.c += u.completion_tokens;
    const hasR = typeof u.reasoning_tokens === 'number';
    if (hasR) tokTotal.r += u.reasoning_tokens;
    const fmt = n => n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n);
    return ` | tok ${u.prompt_tokens}+${u.completion_tokens}` +
      (hasR ? `(r${u.reasoning_tokens})` : '') +
      ` 累计 ${fmt(tokTotal.p)}+${fmt(tokTotal.c)}` + (tokTotal.r ? `(r${fmt(tokTotal.r)})` : '');
  }

  // token 有效性:ok = 可用(附 token 与剩余毫秒);no-token / token-expired
  // 由 adapter 映射为 503/401
  function authenticateRequest() {
    const ts = tokenState();
    if (ts.code === 'no-token') {
      return { error: { status: 503, message: '本地无 token。请先在本项目目录运行: node refresh-token.js login', note: 'no-token' } };
    }
    if (ts.code === 'token-expired') {
      return { error: { status: 401, message: 'token 已过期,等待 watch 守护续期。请确认: node refresh-token.js watch 在运行', note: 'token-expired', type: 'auth_error' } };
    }
    return { token: ts.token, msLeft: ts.msLeft };
  }

  // 解析与归一化:返回 {payload, clientWantsStream, normNote} 或带 note 的 400
  function preparePayload(ctx) {
    let payload;
    try {
      payload = parseJsonBody(ctx.rawBody);
    } catch (e) {
      return { error: {
        status: 400, message: e.message,
        note: e.code === 'INVALID_JSON' ? 'bad-json' : 'not-object',
      } };
    }
    const clientWantsStream = payload.stream === true;
    payload.stream = true; // 对上游强制流式(绕 60s nginx 非流式超时)
    // 上游 usage 默认不回,仅在 stream_options.include_usage 时返回(含
    // reasoning_tokens 单独计数)。注入后:聚合路径得到真实 usage,透传路径
    // 客户端会多收一个标准 usage chunk(空 choices,OpenAI 规范形态)。
    // 客户端发了 {}/非对象值也补齐;仅显式布尔 false 尊重客户端,其余非法值
    // (null/0/"false" 等)归一为 true,不能原样发往上游(usage 会消失)
    if (!payload.stream_options || typeof payload.stream_options !== 'object' || Array.isArray(payload.stream_options)) {
      payload.stream_options = { include_usage: true };
    } else {
      payload.stream_options.include_usage = payload.stream_options.include_usage === false ? false : true;
    }
    const normalized = normalizePayload(payload, config.model);
    return { payload, clientWantsStream, normNote: normalized.length ? ` norm[${normalized.join(' ')}]` : '' };
  }

  // 上游结果 → 终态描述({status, note, message};failed-stream 带标记,两条
  // 路径对它的收尾各有额外上下文要记)。每类结果只在这里转换一次,
  // 流式/聚合仅在 note 前缀不同
  function mapResult(result, prefix) {
    switch (result.type) {
      case 'timeout':
        if (result.phase === 'idle') {
          return { status: 504, note: 'idle-timeout',
            message: `上游流式空闲超时(${config.streamIdleTimeout / 1000}s 无数据)` };
        }
        if (result.phase === 'headers') {
          const message = `上游 ${config.upstreamHeaderTimeout / 1000}s 未返回响应头(连接或网关挂起)`;
          return { status: 502, note: `proxy-err:${message.slice(0, 60)}`, message };
        }
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config) };
      case 'protocol-error':
        return { status: 502, failedStream: true, ...describeFailedStream(result, prefix, config) };
      case 'network-error':
        return { status: 502, note: `proxy-err:${String(result.cause).slice(0, 60)}`,
          message: `代理到上游请求失败: ${result.cause}` };
      default:
        return null; // stream/completion/upstream-error/aborted 由调用方分支处理
    }
  }

  // 统一错误收尾:记一条日志,未发头回错误响应;流式路径若 SSE 头已发出,
  // 状态码无法再改,只能断流让客户端按截断处理
  function failRequest(ctx, mapped) {
    logReq(ctx.req, mapped.status, ctx.started, ctx.size, mapped.note);
    if (!ctx.sseHeadersSent()) return ctx.sendError(mapped.status, mapped.message);
    ctx.endResponse();
  }

  async function handleRequest(ctx) {
    // ---- authenticate(顺序与既有行为一致:empty-body 之后、JSON 解析之前)
    const auth = authenticateRequest();
    if (auth.error) {
      logReq(ctx.req, auth.error.status, ctx.started, ctx.size, auth.error.note);
      return ctx.sendError(auth.error.status, auth.error.message, auth.error.type);
    }
    // 续期提示头:两条应答路径都带上(流式路径经 sseHeaders 注入)
    const extraHeaders = auth.msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};
    ctx.setExtraHeaders(extraHeaders);

    // ---- parse + normalize
    const prepared = preparePayload(ctx);
    if (prepared.error) {
      logReq(ctx.req, 400, ctx.started, ctx.size, prepared.error.note);
      return ctx.sendError(400, prepared.error.message);
    }
    const { payload, clientWantsStream, normNote } = prepared;

    // ---- 上游前的廉价早退:上游的实际上下文校验是 prompt+max_tokens ≤
    // 262,144(2026-09-09 实测),此处按同一口径拦截。估算按内容类别有
    // ±15% 量级误差,漏网的由上游秒级错误帧兜底(诚实失败,晚一秒)。
    // max_tokens 缺省时按 0 计(上游对缺省值的行为未知,交给上游仲裁)
    const estTokens = estimateTokens(ctx.rawBody);
    const tokenBudget = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0;
    if (estTokens + tokenBudget > config.contextWindow) {
      logReq(ctx.req, 413, ctx.started, ctx.size, `token-est=${estTokens}+${tokenBudget}`);
      return ctx.sendError(413,
        `prompt 估算 ${estTokens} + max_tokens ${tokenBudget} 超过上游 262,144 tokens 上下文上限。请在客户端压缩上下文(history/truncate)后重试。`);
    }

    // ---- 进程保护硬上限:非常规业务限流——多子代理编排(几十路并发)是合法
    // 负载,64 远在其上;上限防的是失控客户端紧循环把进程内存/连接拖垮
    // (非流式聚合单流最多缓冲 64MB 响应)。不可配置:调高它只是把保护拆了。
    // maxConnections=32 只限 TCP 连接数,keep-alive 多路复用可绕过,故需此层。
    if (inflight >= config.inflightHardLimit) {
      logReq(ctx.req, 429, ctx.started, ctx.size, `overload:inflight=${inflight}`);
      return ctx.sendError(429,
        `代理过载保护:${inflight} 个请求并发处理中(硬上限 ${config.inflightHardLimit},进程保护)。请降低客户端并发或稍后重试。`,
        'rate_limit');
    }

    // ---- 上游调用(64 以内不设业务层限流)。
    // === 异常契约 ===
    // 真实 upstream-client.request() 只 resolve 结果对象、不 reject(其文件头
    // 契约);若 mock/未来实现意外 reject,本 try/finally 仍保证 inflight 释放,
    // 异常向上传播到 http-server 的 .catch 兜底:响应未发出时转 500
    // (proxy-panic 日志),已发出则只结束连接、不写任何新响应。
    // 客户端断开/聚合超时复用同一个 abort signal(adapter 建)
    const ac = ctx.abortController;
    inflight++;
    try {
      if (clientWantsStream) return await streamPassthrough(ctx, payload, auth.token, extraHeaders, normNote, ac);
      return await aggregateResponse(ctx, payload, auth.token, extraHeaders, normNote, ac);
    } finally {
      // 唯一释放路径:早退(400/413/429)发生在 inflight++ 之前,不经过这里
      inflight--;
    }
  }

  // ---- 流式透传 ----
  async function streamPassthrough(ctx, payload, token, extraHeaders, normNote, ac) {
    const { req, started, size } = ctx;
    const result = await upstreamClient.request({
      payload, token, signal: ac.signal,
      onChunk: async (obj) => {
        // SSE 头延迟到首帧数据再发:上游"开流即报错"(SSE 内嵌 errorMessage,
        // 如超上下文/繁忙)时头尚未发出,upstream-error 分支能以真实状态码
        // 交付翻译后的错误;在 onOpen(响应头一到)就发头的话,客户端只能
        // 看到无 [DONE] 的空流。onChunk 里这行同时覆盖正常流的首帧
        ctx.ensureSseHeaders();
        await ctx.writeSseChunk(obj);
      },
    });

    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, 'client-disconnected');
      return;
    }
    if (result.type === 'upstream-error') {
      if (!ctx.sseHeadersSent()) {
        ctx.dumpFailed();
        const mapped = translateUpstreamError(result.body, result.raw, result.status);
        logReq(req, mapped.http, started, size,
          `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
        return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
      }
      // 头已发出(SSE 200),状态码无法再改:断流让客户端按截断处理;日志
      // 带上游错误原文(含 SSE 内嵌 errorMessage 形态),不记成无来由的 200
      ctx.endResponse();
      logReq(req, 200, started, size, `stream-aborted upstream-err=${String(
        result.body?.errorMessage || result.body?.message || result.raw || ''
      ).slice(0, 120).replace(/\s+/g, ' ')}`);
      return;
    }
    const mapped = mapResult(result, 'stream');
    if (mapped) {
      // failed-stream:不能补 [DONE] 伪装成完整回答。已发头则断流,客户端的
      // 截断检测/重试接手;stream-invalid 携带坏帧预览让日志有"为什么"可查
      if (mapped.failedStream) {
        if (ctx.sseHeadersSent()) {
          ctx.endResponse();
          logReq(req, 200, started, size, `${mapped.note},${(ctx.sseBytes() / 1024).toFixed(1)}KB` +
            (result.message ? ` ${result.message.slice(0, 70)}` : ''));
        } else {
          logReq(req, 502, started, size, mapped.note);
          ctx.sendError(502, mapped.message);
        }
        return;
      }
      return failRequest(ctx, mapped);
    }
    if (result.type === 'completion') {
      // 上游以 JSON 给了完整 completion:补成 SSE 形态交付,不丢这次生成
      ctx.ensureSseHeaders();
      ctx.writeSseLine(`data: ${JSON.stringify(result.body)}\n\n`);
      ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `stream,json-fallback${usageNote(result.body?.usage)}${normNote}`);
      return;
    }
    // result.type === 'stream'
    if (ctx.sseHeadersSent()) {
      ctx.writeSseLine('data: [DONE]\n\n');
      ctx.endResponse();
      logReq(req, 200, started, size, `stream,${(ctx.sseBytes() / 1024).toFixed(1)}KB${usageNote(result.usage)}${normNote}`);
    } else {
      // 上游 event-stream 但零 chunk(异常)
      logReq(req, 502, started, size, 'empty-stream');
      ctx.sendError(502, '上游返回空流');
    }
  }

  // ---- 非流式:聚合 SSE ----
  async function aggregateResponse(ctx, payload, token, extraHeaders, normNote, ac) {
    const { req, started, size } = ctx;
    const agg = createAggregator(config.model);
    let chunkCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!ctx.clientGone() && !ctx.headersSent()) {
        ctx.sendError(504, `聚合超时(${config.nonstreamTotalTimeout / 1000}s)。上游生成时间过长,建议客户端改用 stream:true`);
      }
    }, config.nonstreamTotalTimeout);
    const result = await upstreamClient.request({
      payload, token, signal: ac.signal,
      onChunk: obj => {
        chunkCount++;
        agg.feed(obj);
      },
    });
    clearTimeout(timer);

    if (timedOut) { // 504 已由定时器发出,这里只补日志
      logReq(req, 504, started, size, 'agg-timeout');
      return;
    }
    if (ctx.clientGone() || result.type === 'aborted') {
      logReq(req, 499, started, size, 'client-disconnected');
      return;
    }
    if (result.type === 'upstream-error') {
      ctx.dumpFailed();
      const mapped = translateUpstreamError(result.body, result.raw, result.status);
      logReq(req, mapped.http, started, size,
        `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
      return ctx.sendError(mapped.http, mapped.message, 'upstream_error', extraHeaders);
    }
    const mapped = mapResult(result, 'agg');
    if (mapped) {
      // failed-stream:未以合法 [DONE] 结束即失败,不把半截回答当完整 completion 交付
      if (mapped.failedStream) {
        logReq(req, 502, started, size, `${mapped.note},${chunkCount}chunks`);
        return ctx.sendError(502, `${mapped.message},已收 ${chunkCount} 块,请重试`);
      }
      return failRequest(ctx, mapped);
    }
    if (result.type === 'completion') {
      // 上游直接给了完整 JSON completion:原样交付。
      // 不能喂给聚合器——feed 只认 delta 形态,message 会被丢成空内容
      logReq(req, 200, started, size, `json-completion${usageNote(result.body.usage)}${normNote}`);
      return ctx.sendJson(200, result.body, extraHeaders);
    }
    if (chunkCount === 0) {
      // 上游 event-stream 但零 chunk(异常):不应伪装成空 completion 的 200
      logReq(req, 502, started, size, 'empty-stream');
      return ctx.sendError(502, '上游返回空流');
    }
    const out = agg.result();
    logReq(req, 200, started, size, `agg,${chunkCount}chunks${usageNote(agg.usage)}${normNote}`);
    ctx.sendJson(200, out, extraHeaders);
  }

  return { handleRequest, logReq, usageNote };
}

module.exports = { createProxyService };
