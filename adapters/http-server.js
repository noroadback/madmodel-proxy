// adapters/http-server.js
// HTTP 适配层:路由(模型端点/根路径/chat)、Host 白名单、请求体读取
// (Content-Length 预检/限额/超时)、响应写出(JSON/SSE/错误)、token 文件的
// mtime 热加载缓存。业务判定在 core/proxy-service.js。
// 本模块是 core 与 platform 之间的装配点:core 不接触 req/res/fs。
// 本地无鉴权:只监听 127.0.0.1 + Host 白名单即为本机边界(设计取舍见 README)。

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { jwtExpiresAt } = require('../madmodel-auth');
const credentials = require('../platform/credentials');
const paths = require('../platform/paths');

// ===== 响应格式(OpenAI 兼容) =====
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

// ===== token 热加载缓存 =====
// token.json 为 DPAPI 加密格式(v1)或旧明文格式。解密要 spawn PowerShell(约百毫秒),
// 不能每请求做:以"密文记录 mtime"为缓存键——续期进程原子替换文件后 mtime 必变,
// 变了才重新解密。测试注入(tokenFileInjected)的文件直接走明文 JSON。
function createTokenCache(config) {
  let cache = { mtime: 0, data: null };
  return function getToken() {
    try {
      const stat = fs.statSync(config.tokenFile);
      // 仅以 mtime 为缓存键(含 null 负结果):token.json 存在但密文永久
      // 解不开(换账户/损坏)时,每个请求重走 stat+read+DPAPI(同步阻塞
      // 100-300ms)只为再得到一次 null——负结果同样按 mtime 缓存,用户
      // 重新 login 原子替换文件、mtime 变化自然失效
      if (stat.mtimeMs === cache.mtime) {
        return cache.data;
      }
      let data;
      if (config.tokenFileInjected) {
        // 测试注入:明文 JSON(测试 token 无需 DPAPI,且假 token 走 DPAPI 会失败)
        data = JSON.parse(fs.readFileSync(config.tokenFile, 'utf8'));
        if (!data.token) data = null;
      } else {
        data = credentials.readToken(); // 平台解密(DPAPI/钥匙串/机器绑定),坏记录返回 null
      }
      const hadPrevious = !!cache.data;
      cache = { mtime: stat.mtimeMs, data };
      // 热加载可见化:替换既有 token 时打一行日志,确认 watch 续期已被代理接住
      // (首次读取不打——启动横幅已覆盖)
      if (hadPrevious && data?.token) {
        const remainMin = Math.round((data.expiresAt - Date.now()) / 60e3);
        console.log(`[${new Date().toTimeString().slice(0, 8)}] token 已热加载` +
          (remainMin > 0 ? `,剩余 ${remainMin} 分钟(watch 续期完成)` : '(⚠ 新 token 仍为过期状态)'));
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
function readBody(req, limit, timeout) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    const deadline = setTimeout(() => {
      if (aborted) return;
      aborted = true;
      cleanup();
      const e = new Error(`请求体接收超时(${timeout / 1000}s)。慢速或中断的上传已被放弃。`);
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
        const e = new Error(`请求体 ${(size / 1024).toFixed(0)}KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。`);
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
    const e = new Error(`请求体 ${(declaredLen / 1024).toFixed(0)}KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。`);
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
    const exp = data.expiresAt || jwtExpiresAt(data.token);
    const msLeft = exp - Date.now();
    if (msLeft < 0) return { code: 'token-expired' };
    // cookie:WebVPN 隧道会话凭证,随 token 一同续期;旧记录无此字段时为
    // undefined,上游侧按"不带 Cookie 头"处理(直连上游的老配置仍可工作)
    return { ok: true, token: data.token, msLeft, cookie: data.cookie };
  };
}

function createHttpServer({ config, service, getToken }) {
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`,
    '127.0.0.1', 'localhost', '[::1]',
  ]);
  const tokenState = createTokenState(getToken);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = (req.url || '').split('?')[0];

    // socket 层错误兜底:单条连接的故障不应击穿整个进程
    req.on('error', () => {});
    res.on('error', () => {});

    // Host 白名单:防 DNS rebinding(外部域名解析到 127.0.0.1 后,浏览器借合法
    // Origin 跨域读本代理响应)。只认本机地址。早退路径同样记日志:这些是防御
    // 被触发的信号,不留痕则威胁模型永远无法验证
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) {
      service.logReq(req, 403, started, 0, 'host-rejected');
      return openAiError(res, 403, 'Host 头不在白名单,已拒绝(本代理仅限本机使用)');
    }
    // 浏览器 CSRF 缓解:恶意网页可用 no-cors POST 向本机端口盲发请求(Host
    // 是浏览器正确设置的,白名单防不住写入通道;浏览器对跨源 POST 必带
    // Origin)。非本机来源拒绝;非浏览器客户端(SDK/智能体)不发 Origin,
    // 自然豁免;localhost 系页面(本地 Web UI)放行
    if (req.headers.origin !== undefined) {
      let localOrigin = false;
      try {
        const h = new URL(req.headers.origin).hostname;
        localOrigin = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
      } catch (e) { /* 非法 Origin(含 null)按非本机拒绝 */ }
      if (!localOrigin) {
        service.logReq(req, 403, started, 0, 'origin-rejected');
        return openAiError(res, 403, '跨源请求已拒绝(本代理仅限本机与本地页面使用)');
      }
    }

    // 伪造 models 端点(上游不存在该端点,返回 SPA HTML)。附带能力元数据:
    // dsh/pi-ai 读 context_window/context_length/max_output_tokens/max_tokens,
    // LM Studio 读 max_context_length,vLLM 惯例是 max_model_len——各客户端
    // 约定不同,一并挂上,让接入的 agent 工具自动拿到真实上下文而非猜默认
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: config.models.map(id => ({
          id,
          object: 'model',
          created: 1720000000,
          owned_by: 'tsinghua-madmodel',
          name: id,
          context_window: config.contextWindow,
          context_length: config.contextWindow,
          max_model_len: config.contextWindow,
          max_context_length: config.contextWindow,
          max_output_tokens: config.maxModelTokens,
          max_tokens: config.maxModelTokens,
        })),
      });
    }
    // OpenAI 风格根路径
    if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/v1/')) {
      return sendJson(res, 200, { status: 'ok', proxy: 'madmodel', models: config.models });
    }

    if (req.method !== 'POST' || !/\/(v1\/)?chat\/completions$/.test(url)) {
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
      }
    });
  });

  // 读取阶段错误的响应映射(鉴权已过;body 层错误在进入业务前挡回)
  function handleReadError(req, res, e, started) {
    if (e.code === 'CLIENT_ABORT') return; // 客户端已断开,无响应可写
    if (e.code === 'BODY_TIMEOUT') {
      service.logReq(req, 408, started, e.size || 0, 'body-timeout');
      openAiError(res, 408, e.message);
      req.destroy();
      return;
    }
    if (e.code === 'BODY_TOO_LARGE') {
      service.logReq(req, 413, started, e.size || 0, e.note || 'body-overflow');
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
          // 写状态目录而非仓库目录:诊断文件可能被 git add -f / 打包发布带出仓库
          fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
          fs.writeFileSync(path.join(path.dirname(config.tokenFile), 'last-failed-request.json'), rawBody);
        } catch (e) { /* 诊断文件写失败不影响主流程 */ }
      },
    };
    // service 完成 token 检查后注入续期提示头(SSE 头尚未发出时生效)
    ctx.setExtraHeaders = headers => { extraHeaders = headers; };

    return service.handleRequest(ctx);
  }

  server.maxConnections = config.maxConnections;
  // Node 默认 headersTimeout=60s/requestTimeout=300s/keepAliveTimeout=5s,
  // 对本机个人代理已够;显式设 keepAliveTimeout 略缩,降低连接囤积面
  server.headersTimeout = 60e3;
  server.requestTimeout = 120e3; // 含 body 接收(bodyTimeout 60s + 处理余量)
  server.keepAliveTimeout = 10e3;

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用:代理可能已在运行。如需另开实例,可用环境变量 PROXY_PORT。`);
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

module.exports = { createHttpServer, createTokenCache, createTokenState };
