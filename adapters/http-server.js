// adapters/http-server.js
// HTTP 适配层:路由(模型端点/根路径/chat)、Host 白名单、请求体读取
// (Content-Length 预检/限额/超时)、响应写出(JSON/SSE/错误)、token 文件的
// mtime 热加载缓存。业务判定在 core/proxy-service.js。
// 本模块是 core 与 platform 之间的装配点:core 不接触 req/res/fs。
// 本地无鉴权:只监听 127.0.0.1 + Host 白名单即为本机边界(边界说明见 SECURITY.md)。

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { jwtExpiresAt } = require('../madmodel-auth');
const credentials = require('../platform/credentials');
const { atomicWrite } = require('../platform/file-store');
const { normalizeReasoningDelta } = require('../core/thinking');
const { getModelMeta } = require('../core/model-registry');

function sendJson(res, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function openAiError(res, status, message, type, extraHeaders) {
  sendJson(res, status, {
    error: { message, type: type || 'proxy_error', code: status },
  }, extraHeaders);
}

// ===== API Key 鉴权(可选) =====
// 从请求提取 key:优先 Authorization: Bearer <key>,回退 x-api-key。
function extractApiKey(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const x = req.headers['x-api-key'];
  return x ? String(x).trim() : '';
}

// 时间恒定比较,防计时侧信道泄露 key 长度/前缀。任一 key 命中即通过。
function apiKeyAccepted(presented, keys) {
  if (!presented) return false;
  const a = Buffer.from(presented);
  let ok = false;
  for (const k of keys) {
    const b = Buffer.from(k);
    // 长度不等时 timingSafeEqual 会抛;先判等长再比,避免异常与长度旁路
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

// ===== token 热加载缓存 =====
// token.json 为 DPAPI 加密格式(v1)或旧明文格式。解密要 spawn PowerShell(约百毫秒),
// 不能每请求做:以"密文记录 mtime"为缓存键——续期进程原子替换文件后 mtime 必变,
// 变了才重新解密。测试注入(tokenFileInjected)的文件直接走明文 JSON。
function createTokenCache(config, { now = Date.now, readToken = credentials.readToken, negativeTtlMs = 2000 } = {}) {
  let cache = { mtime: 0, data: null, checkedAt: -Infinity };
  return function getToken() {
    try {
      const stat = fs.statSync(config.tokenFile);
      // 成功读取按 mtime 缓存；失败短暂缓存，钥匙串解锁后无需改写文件。
      if (stat.mtimeMs === cache.mtime && (cache.data || now() - cache.checkedAt < negativeTtlMs)) {
        return cache.data;
      }
      let data;
      if (config.tokenFileInjected) {
        // 测试注入:明文 JSON(测试 token 无需 DPAPI,且假 token 走 DPAPI 会失败)
        data = JSON.parse(fs.readFileSync(config.tokenFile, 'utf8'));
        // 非对象(如文件内容就是 'null')时 data.token 会抛,被外层 catch 当成
        // "瞬态失败"回退上次 token——归因不准。显式判一下,语义是"这份记录不可用"
        if (!data || typeof data !== 'object' || !data.token) data = null;
      } else {
        data = readToken();
      }
      const hadPrevious = !!cache.data;
      cache = { mtime: stat.mtimeMs, data, checkedAt: now() };
      // 热加载可见化:替换既有 token 时打一行日志,确认 watch 续期已被代理接住
      // (首次读取不打——启动横幅已覆盖)
      if (hadPrevious && data?.token) {
        const remainMin = Math.round((data.expiresAt - Date.now()) / 60e3);
        console.log(`[${new Date().toTimeString().slice(0, 8)}] token 已更新` +
          (remainMin > 0 ? `，剩余 ${remainMin} 分钟` : '，但已过期，请检查续期状态'));
      }
      return data;
    } catch (e) {
      // 瞬态失败(如恰好读到续期进程写到一半的文件):回退上一次可用 token,下一请求自愈
      return cache.data || null;
    }
  };
}

// ===== 请求体读取 =====
// Content-Length 预检 + chunked 读取 + 大小限制 + 完成时限。错误带 code/note,
// 由本层直接映射为 HTTP 响应(读取失败时业务层尚未介入)。
function bodyLimitMessage(size, limit) {
  return `请求体 ${(size / 1024).toFixed(0)} KB 超过本地上限 ${(limit / 1024).toFixed(0)} KB，请缩小图片或缩短对话。`;
}

function readBody(req, limit, timeout) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    const deadline = setTimeout(() => {
      if (aborted) return;
      aborted = true;
      cleanup();
      const e = new Error(`请求上传超时（${timeout / 1000}s），请重试。`);
      e.code = 'BODY_TIMEOUT';
      e.size = size;
      e.note = 'body-timeout';
      reject(e);
    }, timeout);
    deadline.unref();
    const onData = c => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        cleanup();
        const e = new Error(bodyLimitMessage(size, limit));
        e.code = 'BODY_TOO_LARGE';
        e.size = size;
        e.note = 'body-overflow';
        reject(e);
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      if (aborted) return;
      cleanup();
      resolve({ rawBody: Buffer.concat(chunks), size });
    };
    const onError = () => {
      // 客户端断开:无响应可写,静默放弃
      if (aborted) return;
      aborted = true;
      cleanup();
      const e = new Error('客户端在请求体接收完成前断开');
      e.code = 'CLIENT_ABORT';
      e.size = size;
      reject(e);
    };
    function cleanup() {
      clearTimeout(deadline);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

async function readChatBody(req, config) {
  // Content-Length 预检:超限在收任何 body 字节前就拒绝,不陪慢速攻击者耗资源
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > config.bodyLimit) {
    const e = new Error(bodyLimitMessage(declaredLen, config.bodyLimit));
    e.code = 'BODY_TOO_LARGE';
    e.size = declaredLen;
    e.note = 'cl-precheck';
    throw e;
  }
  const { rawBody, size } = await readBody(req, config.bodyLimit, config.bodyTimeout);
  if (!size) {
    const e = new Error('请求体为空');
    e.code = 'EMPTY_BODY';
    e.size = 0;
    throw e;
  }
  return { rawBody, size };
}

// ===== HTTP 服务 =====
// token 状态判定(纯逻辑):由入口组装后分别注入 service 与 HTTP 层,
// 依赖单向流动,消除 service→httpServer→service 的前向引用
function createTokenState(getToken) {
  return function tokenState() {
    const data = getToken();
    if (!data || !data.token) return { code: 'no-token' };
    const exp = data.expiresAt ?? jwtExpiresAt(data.token);
    const msLeft = exp - Date.now();
    if (!Number.isFinite(exp) || msLeft <= 0) return { code: 'token-expired' };
    // cookie:WebVPN 隧道会话凭证,随 token 一同续期;旧记录无此字段时为
    // undefined,上游侧按"不带 Cookie 头"处理(直连上游的老配置仍可工作)
    return { ok: true, token: data.token, msLeft, cookie: data.cookie };
  };
}

// 凭据等待器(A1 等待重试的注入原语):轮询 token 缓存(mtime 失效,续期
// 进程原子替换后即返回新值),直到凭据组合(token+cookie)与失败请求所用
// 的那份不同、或预算耗尽。凭据指纹是组合而非单 token:WebVPN 恢复可能
// 只更新 cookie 而 JWT 不变,单比 token 会白等到超时。不带 per-request
// signal:调用方在 resolve 后自查客户端取消(个别断开不应中止共享等待)
function createCredentialWaiter(getToken) {
  return async function waitForCredentials(usedToken, usedCookie, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const t = getToken();
        if (t && t.token &&
            (t.token !== usedToken || (t.cookie || '') !== (usedCookie || ''))) {
          return t;
        }
      } catch (e) { /* 读取瞬态失败(写入窗口):继续等 */ }
    }
    return null;
  };
}

function createHttpServer({ config, service, getToken, modelRegistry }) {
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`,
    '127.0.0.1', 'localhost', '[::1]',
  ]);
  const tokenState = createTokenState(getToken);
  // 鉴权与监听形态:配了 apiKeys 即开启 Bearer 校验;非回环监听
  // (PROXY_BIND_HOST=0.0.0.0 等)时 Host 白名单不再是边界(外部 IP 的 Host
  // 头本就不在白名单),由 API Key 接管。两者独立:回环+key(本机多用户隔离)
  // 与 对外+key(局域网鉴权)都成立。
  const apiKeys = config.apiKeys || [];
  const requireAuth = apiKeys.length > 0;
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(config.host);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = (req.url || '').split('?')[0];

    // socket 层错误兜底:单条连接的故障不应击穿整个进程
    req.on('error', () => {});
    res.on('error', () => {});

    // 健康探测:免鉴权、免白名单(仅回 ok,不碰上游),供 Makefile/脚本探活
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    // API Key 鉴权(配了才校验)。放在最前:未授权请求不该看到白名单/端点细节。
    if (requireAuth && !apiKeyAccepted(extractApiKey(req), apiKeys)) {
      service.logReq(req, 401, started, 0, 'auth-rejected');
      return openAiError(res, 401, 'API Key 无效或缺失(Authorization: Bearer <key> 或 x-api-key)', 'auth_error');
    }

    // Host 白名单:防 DNS rebinding(外部域名解析到 127.0.0.1 后,浏览器借合法
    // Origin 跨域读本代理响应)。只认本机地址。早退路径同样记日志:这些是防御
    // 被触发的信号,不留痕则威胁模型永远无法验证。
    // 仅回环监听时启用——对外监听(0.0.0.0)时外部 IP 的 Host 头合法却不在
    // 白名单,此时边界由上面的 API Key 鉴权承担(requireAuth 已在启动时强制)。
    const host = String(req.headers.host || '').toLowerCase();
    if (loopbackOnly && !allowedHosts.has(host)) {
      service.logReq(req, 403, started, 0, 'host-rejected');
      return openAiError(res, 403, 'Host 未获允许，请使用本机地址访问。');
    }
    // 浏览器 CSRF 缓解:恶意网页可用 no-cors POST 向本机端口盲发请求(Host
    // 是浏览器正确设置的,白名单防不住写入通道;浏览器对跨源 POST 必带
    // Origin)。非本机来源拒绝;非浏览器客户端(SDK/智能体)不发 Origin,
    // 自然豁免;localhost 系页面(本地 Web UI)放行。
    // 对外监听+已鉴权时跳过:合法的远程 SDK 客户端不发 Origin,而带 key 的
    // 请求已通过鉴权,CSRF(依赖浏览器自动带凭据)在 key 模型下不适用。
    if (loopbackOnly && req.headers.origin !== undefined) {
      let localOrigin = false;
      try {
        const h = new URL(req.headers.origin).hostname;
        localOrigin = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
      } catch (e) { /* 非法 Origin(含 null)按非本机拒绝 */ }
      if (!localOrigin) {
        service.logReq(req, 403, started, 0, 'origin-rejected');
        return openAiError(res, 403, '已拒绝外部网页请求，仅支持本地页面。');
      }
    }

    // 伪造 models 端点(上游不存在该端点,返回 SPA HTML)。附带能力元数据:
    // dsh/pi-ai 读 context_window/context_length/max_output_tokens/max_tokens,
    // LM Studio 读 max_context_length,vLLM 惯例是 max_model_len——各客户端
    // 约定不同,一并挂上,让接入的 agent 工具自动拿到真实上下文而非猜默认
    //
    // 1.10 起清单来自启动探测(modelRegistry):上游有什么就列什么,不再只列
    // config 里那一个。1.10.1 起**按客户端选择真实路由**——选中谁就发谁,故本
    // 清单既是可见性也是可选项来源;各模型的能力差异(思考字段名、窗口大小)
    // 由请求路径逐模型处理。选到能力不匹配的模型不再被代理拦下,而是如实发往
    // 上游(见 core/model-registry.js 的说明与 CHANGELOG 1.10.1)
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      const source = modelRegistry ? modelRegistry.available() : config.models.map(id => ({ id }));
      return sendJson(res, 200, {
        object: 'list',
        data: source.map(entry => {
          const id = entry.id;
          const meta = getModelMeta(config, modelRegistry, id);
          // 探测为不可用的条目(通常是配置的目标模型被下架)如实标注:
          // 不填能力字段,避免"广告一个用不了的能力"。客户端据 available
          // 字段可判断它现在发不出请求
          const usable = entry.ok === true ? true : entry.ok === false ? false : null;
          // 逐模型上限(1.10.1):三个模型窗口差 4 倍,发布单一值会让客户端把
          // 1M 的模型当成 128K 用,或对 256K 的模型发出必然被拒的请求
          const lim = typeof config.limitsFor === 'function' ? config.limitsFor(id) : null;
          const ctxWin = lim ? lim.contextWindow : config.contextWindow;
          const maxOut = lim ? lim.maxOutputTokens : config.maxModelTokens;
          return {
            id,
            object: 'model',
            created: 1720000000,
            owned_by: 'tsinghua-madmodel',
            name: id,
            // 默认推荐标记:客户端可据此预选。1.10.1 起**不再代表"唯一会被路由的
            // 模型"**——请求按客户端选择路由,选中谁就调谁(见 core/model-registry.js
            // 的不变式说明);本字段现在只是"配置里的默认值"这一条信息
            target: id === config.model,
            // 探测结论:false 表示上游当前不接受它(见启动横幅的模型表)
            available: usable,
            context_window: ctxWin,
            context_length: ctxWin,
            max_model_len: ctxWin,
            max_context_length: ctxWin,
            max_output_tokens: maxOut,
            max_tokens: maxOut,
            // 视觉能力取上游声明，未知为 null；不代表实测识别质量。
            supports_vision: meta?.supportImage ?? null,
            // 思考能力标注(1.10.1):上游**逐模型用不同字段名**开思考、且各自
            // 只接受一组固定档位(见 core/thinking.js 的表)。不发布这些,
            // 客户端只能用通用假设去发(ZCode 发 reasoning_effort:"enabled"),
            // 而非法档位会被上游 50ms 秒回"服务器繁忙"——这正是"代理里模型
            // 不吐思考/qwen 必挂、网页端却正常"的成因。客户端读到 reasoning
            // 就能对上正确档位;thinking_param 说明开关落在哪个字段
            reasoning: meta ? {
              supported: !!(meta.thinkingParam || meta.thinkingField || meta.effortOptions?.length),
              thinking_param: meta.thinkingParam,
              thinking_field: meta.thinkingField,
              effort_options: Array.isArray(meta.effortOptions) ? meta.effortOptions : [],
            } : null,
          };
        }),
      });
    }
    // OpenAI 风格根路径
    if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/v1/')) {
      return sendJson(res, 200, {
        status: 'ok', proxy: 'madmodel',
        models: (modelRegistry ? modelRegistry.available() : config.models.map(id => ({ id }))).map(m => m.id),
      });
    }

    if (req.method !== 'POST' || !/^\/(v1\/)?chat\/completions$/.test(url)) {
      service.logReq(req, 404, started, 0, 'no-endpoint');
      return openAiError(res, 404, '端点不存在。可用:POST /v1/chat/completions,GET /v1/models');
    }

    readChatBody(req, config).then(
      ({ rawBody, size }) => handleChat(req, res, rawBody, size, started),
      e => handleReadError(req, res, e, started)
    ).catch(e => {
      // 理论上不可达(service 已消解所有已知异常路径),保底防进程崩溃
      service.logReq(req, 500, started, e?.size || 0, `proxy-panic:${String(e?.message || e).slice(0, 60)}`);
      if (!res.headersSent) {
        try { openAiError(res, 500, `代理内部错误: ${e?.message || e}`); } catch (e2) { /* 连接已断 */ }
      } else {
        res.end();
      }
    });
  });

  // 读取阶段错误的响应映射(鉴权已过;body 层错误在进入业务前挡回)
  function handleReadError(req, res, e, started) {
    if (e.code === 'CLIENT_ABORT') return; // 客户端已断开,无响应可写
    if (e.code === 'BODY_TIMEOUT') {
      service.logReq(req, 408, started, e.size || 0, e.message);
      openAiError(res, 408, e.message);
      req.destroy();
      return;
    }
    if (e.code === 'BODY_TOO_LARGE') {
      service.logReq(req, 413, started, e.size || 0, e.message);
      openAiError(res, 413, e.message);
      if (e.note === 'body-overflow') {
        // 先让 413 冲出内核缓冲再断开:立即 destroy 会连未发出的响应一起丢掉,
        // 客户端将看到连接重置而非 413;2s 兜底防客户端无限续传
        res.once('finish', () => req.destroy());
        setTimeout(() => { try { req.destroy(); } catch (err) { /* 连接已断 */ } }, 2000).unref();
      }
      return;
    }
    if (e.code === 'EMPTY_BODY') {
      service.logReq(req, 400, started, 0, 'empty-body');
      openAiError(res, 400, e.message);
      return;
    }
    throw e; // 未知错误走统一 panic 兜底
  }

  // ---- 为 core/proxy-service 构建 ctx:HTTP 细节全部收在这里 ----
  function handleChat(req, res, rawBody, size, started) {
    // 上游生命周期:客户端断开/聚合超时都能中止上游,不白烧配额。
    // 服务层与背压等待共用这一个 AbortController
    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      // 响应未完成时连接关闭 = 客户端主动断开
      if (!res.writableEnded && !clientGone) {
        clientGone = true;
        ac.abort();
      }
    });

    let sseHeadersSent = false;
    let passthroughBytes = 0;
    let extraHeaders = {};
    // 本模型的思考字段名(由 service 经 ctx.setThinkingFields 注入);null 时
    // normalizeReasoningDelta 回退到已知方言清单
    let thinkingFields = null;
    // 背压:客户端读得慢时暂停读上游。入口先查断开状态——客户端已断开时
    // 'close' 早已发过,新挂的 drain/close 监听器永不触发,promise 将永久挂起,
    // 该请求从此没有收尾(日志缺失、连接占住 maxConnections 名额)
    const waitDrain = () => {
      if (clientGone || res.destroyed || res.writableEnded) return Promise.resolve();
      return new Promise(r => {
        const done = () => { res.removeListener('drain', done); res.removeListener('close', done); r(); };
        res.once('drain', done);
        res.once('close', done);
      });
    };

    const ctx = {
      req, res, rawBody, size, started,
      abortController: ac,
      clientGone: () => clientGone,
      headersSent: () => res.headersSent,
      // SSE 透传面
      ensureSseHeaders() {
        if (sseHeadersSent) return;
        sseHeadersSent = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...extraHeaders,
        });
      },
      sseHeadersSent: () => sseHeadersSent,
      sseBytes: () => passthroughBytes,
      async writeSseChunk(obj) {
        ctx.ensureSseHeaders();
        // 思考字段归一:上游逐模型用不同字段名吐思考(qwen 是 `reasoning`,
        // DeepSeek 系是 `reasoning_content`),而客户端只认后者。不归一的话
        // qwen 的思考会以"客户端不认识的字段"抵达,被静默丢弃——用户看到的是
        // 全程没有思考,而换 DeepSeek 就正常(2026-09-29 实测定位)。
        // 放在这个唯一的写出点上做:补发路径、缓冲冲刷、逐帧透传最终都经此,
        // 漏在任何一条路径上都会"半好半坏"。
        // thinkingFields 由 service 注入(见 ctx.setThinkingFields);未注入时
        // 由 thinking.js 的已知方言清单兜底
        normalizeReasoningDelta(obj, thinkingFields);
        return ctx.writeSseLine(`data: ${JSON.stringify(obj)}\n\n`);
      },
      writeSseLine(line) {
        // Buffer.byteLength:line.length 数的是 UTF-16 码元,中文流的 KB 日志
        // 会偏小约 3 倍
        passthroughBytes += Buffer.byteLength(line);
        if (!res.write(line)) return waitDrain();
      },
      endResponse() {
        if (!res.writableEnded) res.end();
      },
      // 终态响应面
      sendJson(status, body, headers) { sendJson(res, status, body, headers); },
      sendError(status, message, type, headers) { openAiError(res, status, message, type, headers); },
      // 失败请求体落盘(默认关,隐私考虑:body 含完整对话内容)
      dumpFailed() {
        if (!config.dumpFailed) return;
        try {
          // 写状态目录而非仓库目录:诊断文件可能被 git add -f / 打包发布带出仓库。
          // 走 atomicWrite:该文件含完整对话,是状态目录里最敏感的一份,权限
          // (0600)与原子替换都与其余状态文件一致
          atomicWrite(path.join(path.dirname(config.tokenFile), 'last-failed-request.json'), rawBody);
        } catch (e) { /* 诊断文件写失败不影响主流程 */ }
      },
    };
    // service 完成 token 检查后注入续期提示头(SSE 头尚未发出时生效)
    ctx.setExtraHeaders = headers => { extraHeaders = headers; };
    // service 把本模型的思考字段名(上游方言)交进来,供 SSE 出口归一化使用。
    // 出口这层拿不到模型名,不注入就只能用硬编码清单——那样上游换字段名时
    // 该层会把裸方言键原样发给客户端(其余三条交付路径已用 meta 兜住,这里
    // 是最后一道,应当同样自足)
    ctx.setThinkingFields = fields => { thinkingFields = fields; };

    return service.handleRequest(ctx);
  }

  server.maxConnections = config.maxConnections;
  // headersTimeout 与 Node 默认的 60s 持平;requestTimeout 从默认 300s 收紧到
  // 120s(下限由同行的 bodyTimeout 60s 加处理余量决定);keepAliveTimeout 从
  // 默认 5s 放宽到 10s——本机客户端复用连接的间隔常超过 5s,反复重建不划算
  server.headersTimeout = 60e3;
  server.requestTimeout = 120e3; // 含 body 接收(bodyTimeout 60s + 处理余量)
  server.keepAliveTimeout = 10e3;

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已占用，请检查已运行的代理，或用 PROXY_PORT 换端口。`);
      process.exit(1);
    }
    // 只打 code/message:完整 error 对象的堆栈含本机绝对路径
    console.error('HTTP 服务错误:', e?.code || '', e?.message || e);
  });

  return {
    server,
    auth: { getToken, tokenState },
  };
}

module.exports = { createHttpServer, createTokenCache, createTokenState, createCredentialWaiter, extractApiKey, apiKeyAccepted };
