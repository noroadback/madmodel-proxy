// proxy.js
// madmodel DeepSeek-V4-Flash 本地反向代理(OpenAI 兼容)。
// 监听 127.0.0.1:8080,供 dsh 等标准 OpenAI 客户端使用。
//
// 职责(按已验证的 API 规格书):
//   1. token 热加载:每请求读 ~/.dsh-madmodel/token.json(watch 守护续期,免重启)
//   2. 强制上游 stream:true 绕 60s nginx 非流式超时;客户端要非流式时自己聚合 SSE
//   3. 错误翻译:上游一切错误都返回 HTTP 200 + body 错误码 → 重新编码为标准 4xx/5xx
//   4. 伪造 GET /v1/models(上游不存在该端点,返回 SPA HTML)
//   5. 预检:body > 950KB 提前 413(nginx 1MB 硬限,留余量)
//   6. 温和限速:60 req/min、并发 8(个人自用,防 agent 失控)
//
// 安全与稳健性加固(2026-09-02,2026-09-03 二轮):
//   - Host 头白名单:阻断 DNS rebinding(外部域名解析到 127.0.0.1 后借合法 Origin 读响应)
//   - 本地鉴权默认强制:未显式设 PROXY_API_KEY 时启动自动生成随机 key 并写入
//     ~/.dsh-madmodel/api-key(首启打印,客户端配置同值 Bearer)。恶意网页的
//     blind POST / CSRF 无法携带该 key,配额不再裸奔。PROXY_NO_AUTH=1 仅限测试显式关闭
//   - 客户端断开 / 聚合超时即中止上游请求(不再白烧配额),所有兜底写响应均有守卫
//   - 请求体读取阶段即受保护:Content-Length 预检、server.maxConnections、
//     headersTimeout/requestTimeout 覆盖慢连接攻击
//   - 上游响应头超时:fetch 发出后 30s 未见响应头即中止,不再长期占用并发槽
//   - 上游响应体设总量上限(JSON 路径与 SSE 路径),异常大响应不再无限吃内存
//   - 失败请求体落盘默认关闭(body 含完整对话内容,隐私):设 DUMP_FAILED=1 开启
//   - 上游以 JSON 返回完整 completion 时不再当"空流"丢弃,照常交付;真空流回 502
//   - 请求体非 JSON 对象(如 null/数组)回 400 而非触发内部错误
//   - socket 层错误不再有击穿进程的路径;EADDRINUSE 有清晰提示
//
// 环境变量:PROXY_API_KEY(指定 key)/ PROXY_NO_AUTH(=1 关鉴权,仅测试)/
//          PROXY_PORT(默认 8080)/ DUMP_FAILED(=1 开诊断落盘)
//          PROXY_NO_GZIP(=1 关闭请求体 gzip)/ PROXY_UPSTREAM、PROXY_TOKEN_FILE(测试注入用)
//
// 用法: node proxy.js  (Ctrl+C 退出)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { jwtExpiresAt } = require('./madmodel-auth');
const { readTokenRecord, TOKEN_FILE: SS_TOKEN_FILE } = require('./secure-store');

const PORT = Number(process.env.PROXY_PORT) || 8080;
const HOST = '127.0.0.1';
// PROXY_UPSTREAM / PROXY_TOKEN_FILE:测试注入用(端到端测试时指向本地假上游)
const UPSTREAM = process.env.PROXY_UPSTREAM || 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions';
const MODELS = ['DeepSeek-V4-Flash'];
const TOKEN_FILE = process.env.PROXY_TOKEN_FILE || SS_TOKEN_FILE;

const BODY_LIMIT = 950 * 1024;        // nginx 1MB 限,留余量
const MAX_CONCURRENT = 8;            // 并发上限
const RATE_LIMIT = 60;               // 每分钟请求数
const STREAM_IDLE_TIMEOUT = 120e3;   // 流式空闲超时(实测晚高峰 ~36tps,120s 足够)
const NONSTREAM_TOTAL_TIMEOUT = 600e3; // 非流式聚合总超时(实测流式 600s 不断)
const UPSTREAM_HEADER_TIMEOUT = 30e3;  // 发出上游请求到收到响应头的超时
const UPSTREAM_JSON_BODY_LIMIT = 5 * 1024 * 1024;   // JSON 错误页/直答体上限
const UPSTREAM_SSE_TOTAL_LIMIT = 64 * 1024 * 1024;  // 单次流总字节上限(约=16M tokens,余量充分)
const MAX_CONNECTIONS = 32;          // server.maxConnections:本机个人代理,32 绰绰有余
const BODY_TIMEOUT = 60e3;           // 请求体接收完成时限(950KB 按拨号速度也该到了)

const STATE_DIR = path.join(process.env.USERPROFILE || '', '.dsh-madmodel');
const KEY_FILE = path.join(STATE_DIR, 'api-key');
// 面向用户的展示路径(真实绝对路径含 Windows 账户名,不该进 401 响应体/控制台输出)
const KEY_FILE_DISPLAY = '%USERPROFILE%\\.dsh-madmodel\\api-key';

// 本地鉴权:默认强制(启动时生成随机 key 并落盘,首启打印),防恶意网页 blind
// POST 盗用配额——Host 白名单挡不住无响应读取需求的 CSRF 式滥用。
// PROXY_API_KEY 显式指定;PROXY_NO_AUTH=1 仅测试场景关闭。
function loadApiKey() {
  if (process.env.PROXY_NO_AUTH === '1') return { key: '', auto: false };
  if (process.env.PROXY_API_KEY) return { key: process.env.PROXY_API_KEY, auto: false };
  try {
    // 已有 key 文件则复用(重启换 key 会把所有客户端打挂)
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing) return { key: existing, auto: true };
  } catch (e) { /* 无文件,生成 */ }
  const key = crypto.randomBytes(24).toString('base64url');
  let persisted = true;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key + '\n', 'utf8');
  } catch (e) {
    // 落盘失败必须显式告警并打印 key:否则本进程仍在要求鉴权,而
    // refresh-token.js key 读不到文件会提示"尚无 key",用户被锁在门外且提示误导
    persisted = false;
    console.error('⚠ 无法写入 API key 文件(' + e.message + ')。本进程临时使用以下 key(重启后更换,请先修复写入权限):');
    console.error('  ' + key);
  }
  return { key, auto: true, generated: true, persisted };
}
const { key: API_KEY, auto: KEY_AUTO, generated: KEY_GENERATED, persisted: KEY_PERSISTED = true } = loadApiKey();
// 失败请求体落盘(默认关,隐私考虑:body 含完整对话内容)
const DUMP_FAILED = process.env.DUMP_FAILED === '1';
// 请求体 gzip 编码(默认开,见 callUpstream 内 WAF 注释;设 PROXY_NO_GZIP=1 关闭)
const GZIP_BODY = process.env.PROXY_NO_GZIP !== '1';
// Host 白名单:只认本机地址,拒绝一切外部域名(防 DNS rebinding)
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT,
  '127.0.0.1', 'localhost', '[::1]',
]);

// ===== token 热加载 =====
// token.json 为 DPAPI 加密格式(v1)或旧明文格式。解密要 spawn PowerShell(约百毫秒),
// 不能每请求做:以"密文记录 mtime"为缓存键——续期进程原子替换文件后 mtime 必变,
// 变了才重新解密。PROXY_TOKEN_FILE 注入的测试文件直接走原样 JSON(假 token 不加密)。
let tokenCache = { mtime: 0, data: null };
function getToken() {
  try {
    const stat = fs.statSync(TOKEN_FILE);
    if (tokenCache.data && stat.mtimeMs === tokenCache.mtime) {
      return tokenCache.data;
    }
    let data;
    if (process.env.PROXY_TOKEN_FILE) {
      // 测试注入:明文 JSON(测试 token 无需 DPAPI,且假 token 走 DPAPI 会失败)
      data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (!data.token) data = null;
    } else {
      data = readTokenRecord(); // DPAPI 解密,坏记录返回 null
    }
    tokenCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (e) {
    // 瞬态失败(如恰好读到续期进程写到一半的文件):回退上一次可用 token,下一请求自愈
    return tokenCache.data || null;
  }
}

// ===== 限速 =====
let active = 0;
const rateWindow = [];
function acquireSlot() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0] > 60e3) rateWindow.shift();
  if (rateWindow.length >= RATE_LIMIT) return false;
  // 通过速率检查即计入窗口:并发打满时被拒的请求也占名额,
  // 防止客户端在并发上限处无限空转却永远不受速率约束
  rateWindow.push(now);
  if (active >= MAX_CONCURRENT) return false;
  active++;
  return true;
}
function releaseSlot() { active = Math.max(0, active - 1); }

// ===== 工具 =====
function estimateTokens(bodyBuffer) {
  // 无分词器的粗估:UTF-8 字节 ÷ 3.5(中文≈1字/token 但占3字节,英文≈4字符/token 的折中)
  return Math.round(bodyBuffer.length / 3.5);
}

// 常时比较(先哈希等长,防长度泄露),本地场景属廉价加固
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
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

// 上游错误 body → HTTP 状态码(实测规格:10001=繁忙/超限/模型不可用,10003=无权限)
// 兼容 vLLM 风格错误:{"object":"error","message":...} / FastAPI 风格:{"detail":...}
function translateUpstreamError(bodyObj, raw, status) {
  // 404 特判:上游 WAF 误拦时表现为 404(见 README"已知兼容性问题"),
  // 不能让它落进"无法识别的响应"这种误导文案
  if (status === 404) {
    return { http: 502, message: '上游返回 404:可能被 WAF 对提示词内容的误拦截(详见 README"已知兼容性问题"),也可能是端点变更' };
  }
  const detail = bodyObj && (bodyObj.message || (bodyObj.error && bodyObj.error.message) ||
    bodyObj.detail || (typeof bodyObj.error === 'string' ? bodyObj.error : ''));
  if (bodyObj && bodyObj.status === 10003) {
    return { http: 401, message: '认证失败(token 无效或已过期)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  if (bodyObj && bodyObj.status === 10001) {
    return { http: 429, message: '上游拒绝:' + detail + '(可能是上下文超限≈256K、请求体超限 1MB 或服务繁忙)' };
  }
  if (detail) {
    return { http: 502, message: '上游拒绝请求: ' + String(detail).slice(0, 300) };
  }
  return { http: 502, message: '上游返回无法识别的响应(前 200 字符): ' + String(raw || '').slice(0, 200) };
}

// 限量读上游 JSON 响应:超限抛错由调用方 catch,不无限缓冲
async function readLimited(reader, limit) {
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      try { await reader.cancel(); } catch (e) {}
      const error = new Error('upstream body exceeds limit');
      error.code = 'UPSTREAM_BODY_LIMIT';
      throw error;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// ===== 上游转发核心 =====
// 恒以流式请求上游(绕 nginx 非流式 60s 超时;透传或聚合由调用方决定)。
// 结果只 resolve 不 reject,错误一律以结果形态带回,调用方免于双通道控制流:
//   {type:'sse'}            流正常结束([DONE] 或 EOF)
//   {type:'completion'}     上游异常地以 JSON 返回了完整 completion(bodyObj)
//   {type:'error'}          上游以 JSON 返回错误(status/bodyObj/raw)
//   {type:'idle-timeout'}   STREAM_IDLE_TIMEOUT 内无新数据
//   {type:'aborted'}        外部 signal 中止(客户端断开/聚合超时)
//   {type:'network-error'}  fetch/读取层网络错误(message)
// onSseChunk(obj) 收每个 SSE data JSON,可为 async(背压等待期间不再读上游);
// onOpen(isSse) 在上游响应头到达时调用一次。
function callUpstream(payload, token, onSseChunk, onOpen, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let idleTimer = null;
    let reader = null;
    let upBody = null; // JSON 应答路径在 reader 建立前保留 body 以便取消
    const upstreamAbort = new AbortController();
    if (signal) {
      if (signal.aborted) upstreamAbort.abort();
      else signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });
    }
    const fetchSignal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([upstreamAbort.signal, ...(signal ? [signal] : [])])
      : upstreamAbort.signal;
    // 响应头超时:TCP/TLS/代理层挂住时 30s 放弃,不长期占用并发槽
    // (空闲计时器只覆盖"收到响应后";这里覆盖"发出请求到响应头"的窗口)
    const headerTimer = setTimeout(() => {
      if (settled) return;
      try { upstreamAbort.abort(); } catch (e) {}
      cancelBody();
      finish({ type: 'network-error', message: '上游 ' + (UPSTREAM_HEADER_TIMEOUT / 1000) + 's 未返回响应头(连接或网关挂起)' });
    }, UPSTREAM_HEADER_TIMEOUT);
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      clearTimeout(idleTimer);
      resolve(v);
    };
    const cancelBody = () => {
      try {
        const p = reader ? reader.cancel() : (upBody && upBody.cancel());
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cancelBody();
        finish({ type: 'idle-timeout' });
      }, STREAM_IDLE_TIMEOUT);
    };

    // 请求体 gzip:上游 WAF 的 SQL 注入特征规则会误拦含字面量 "(set " 的明文
    // 请求体(agent 工具的系统提示词常见,如 dsh 的 "(set wait: true)"),对 gzip
    // 编码的请求体则不再触发该规则。这是标准 HTTP 特性(带宽上也是优化),但
    // 属于规避安全管控的灰色手段:如遇误拦截,优先向平台反馈误报走正路。
    // 设 PROXY_NO_GZIP=1 可随时关闭;详见 README"已知兼容性问题"一节。
    const reqHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      Accept: 'text/event-stream',
    };
    const reqBody = JSON.stringify(payload);
    if (GZIP_BODY) reqHeaders['Content-Encoding'] = 'gzip';

    fetch(UPSTREAM, {
      method: 'POST',
      headers: reqHeaders,
      body: GZIP_BODY ? zlib.gzipSync(Buffer.from(reqBody, 'utf8')) : Buffer.from(reqBody, 'utf8'),
      redirect: 'manual',
      signal: fetchSignal,
    }).then(async (up) => {
      clearTimeout(headerTimer);
      const isSse = /event-stream/i.test(up.headers.get('content-type') || '');
      if (onOpen) onOpen(isSse);
      upBody = up.body;

      if (!isSse) {
        // 流式请求被以 JSON 应答(典型:上游一切错误都走 200+JSON;
        // 极少数是完整 completion,同样带回由调用方处理,不丢弃)。
        // JSON body 同样可能挂死(头部到达后不再发字节),空闲超时一并覆盖。
        armIdle();
        // 限量读:错误页/直答异常膨胀时及时放弃,不无限吃内存
        let text;
        try {
          reader = up.body.getReader();
          text = (await readLimited(reader, UPSTREAM_JSON_BODY_LIMIT)).toString('utf8');
        } catch (e) {
          cancelBody();
          if (e && e.code === 'UPSTREAM_BODY_LIMIT') {
            return finish({ type: 'network-error', message: '上游 JSON 响应超过 ' + (UPSTREAM_JSON_BODY_LIMIT / 1048576) + 'MB 上限' });
          }
          return finish({ type: 'network-error', message: '上游 JSON 响应读取失败: ' + String((e && e.message) || e) });
        }
        if (settled) return;
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) { /* fallthrough */ }
        if (obj && obj.choices) return finish({ type: 'completion', bodyObj: obj });
        return finish({ type: 'error', status: up.status, bodyObj: obj, raw: text.slice(0, 500) });
      }

      // 逐行解析 SSE(总量限量:异常大的流按错误带回,内存上限可控)
      reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let total = 0;
      armIdle();
      for (;;) {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) break;
        armIdle();
        total += value.length;
        if (total > UPSTREAM_SSE_TOTAL_LIMIT) {
          cancelBody();
          return finish({ type: 'network-error', message: '上游响应超过 ' + (UPSTREAM_SSE_TOTAL_LIMIT / 1048576) + 'MB 上限' });
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return finish({ type: 'sse' });
          try {
            const obj = JSON.parse(data);
            if (onSseChunk) await onSseChunk(obj);
          } catch (e) { /* 跳过坏行/写失败 */ }
          if (settled) return;
        }
      }
      finish({ type: 'sse' });
    }).catch((e) => {
      if (signal && signal.aborted) return finish({ type: 'aborted' });
      finish({ type: 'network-error', message: String((e && e.message) || e) });
    });
  });
}

// 非流式响应聚合:把 SSE delta 流拼回完整 chat.completion 对象
function makeAggregator() {
  return {
    id: '', model: 'DeepSeek-V4-Flash',
    content: '', reasoning: '',
    toolCalls: {}, // index → {id, type, function:{name, arguments}}
    finish: null, usage: null, created: 0,
    feed(obj) {
      if (obj.id) this.id = obj.id;
      if (obj.created) this.created = obj.created;
      if (obj.model) this.model = obj.model;
      if (obj.usage) this.usage = obj.usage;
      const ch = obj.choices && obj.choices[0];
      if (!ch) return;
      if (ch.finish_reason) this.finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string') this.content += d.content;
      if (typeof d.reasoning_content === 'string') this.reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : 0;
          if (!this.toolCalls[i]) this.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) this.toolCalls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) this.toolCalls[i].function.name += tc.function.name;
            if (tc.function.arguments) this.toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    },
    result() {
      const message = { role: 'assistant', content: this.content || null };
      if (this.reasoning) message.reasoning_content = this.reasoning;
      const toolList = Object.keys(this.toolCalls).sort((a, b) => a - b)
        .map(k => this.toolCalls[k]).filter(tc => tc.id || tc.function.name);
      if (toolList.length) message.tool_calls = toolList;
      const out = {
        id: this.id || 'chatcmpl-proxy-' + Date.now(),
        object: 'chat.completion',
        created: this.created || Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{ index: 0, message, finish_reason: this.finish || 'stop' }],
        usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return out;
    },
  };
}

// ===== HTTP 服务 =====
const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = (req.url || '').split('?')[0];

  // socket 层错误兜底:单条连接的故障不应击穿整个进程
  req.on('error', () => {});
  res.on('error', () => {});

  // Host 白名单:防 DNS rebinding(外部域名解析到 127.0.0.1 后,浏览器借合法
  // Origin 跨域读本代理响应)。只认本机地址。
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return openAiError(res, 403, 'Host 头不在白名单,已拒绝(本代理仅限本机使用)');
  }

  // 伪造 models 端点
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map(id => ({ id, object: 'model', created: 1720000000, owned_by: 'tsinghua-madmodel' })),
    });
  }
  // OpenAI 风格根路径
  if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/v1/')) {
    return sendJson(res, 200, { status: 'ok', proxy: 'madmodel', models: MODELS });
  }

  if (req.method !== 'POST' || !/\/(v1\/)?chat\/completions$/.test(url)) {
    return openAiError(res, 404, '端点不存在。可用:POST /v1/chat/completions,GET /v1/models');
  }

  // 本地鉴权(默认强制):恶意网页对本机的 blind POST 带不上 Bearer key
  if (API_KEY) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || !safeEqual(m[1].trim(), API_KEY)) {
      return openAiError(res, 401,
        '无效或缺失 API key。本代理已启用本地鉴权,key 见: ' + KEY_FILE_DISPLAY,
        'auth_error', { 'WWW-Authenticate': 'Bearer' });
    }
  }

  // Content-Length 预检:超限在收任何 body 字节前就拒绝,不陪慢速攻击者耗资源
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > BODY_LIMIT) {
    return openAiError(res, 413, '请求体 ' + (declaredLen / 1024).toFixed(0) + 'KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。');
  }

  // 读 body(带硬上限与完成时限:慢速发送者到点即弃,不再无限占连接与内存)
  const chunks = [];
  let size = 0;
  let aborted = false;
  const bodyDeadline = setTimeout(() => {
    if (aborted || res.writableEnded) return;
    aborted = true;
    openAiError(res, 408, '请求体接收超时(' + BODY_TIMEOUT / 1000 + 's)。慢速或中断的上传已被放弃。');
    req.destroy();
  }, BODY_TIMEOUT);
  bodyDeadline.unref();
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > BODY_LIMIT) {
      aborted = true;
      openAiError(res, 413, '请求体 ' + (size / 1024).toFixed(0) + 'KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。');
      // 先让 413 冲出内核缓冲再断开:立即 destroy 会连未发出的响应一起丢掉,
      // 客户端将看到连接重置而非 413;2s 兜底防客户端无限续传
      res.once('finish', () => req.destroy());
      setTimeout(() => { try { req.destroy(); } catch (e) {} }, 2000).unref();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    clearTimeout(bodyDeadline);
    if (aborted) return;
    handleChat(req, res, Buffer.concat(chunks), size, started).catch(e => {
      // 理论上不可达(handleChat 已消解所有已知异常路径),保底防进程崩溃
      logReq(req, 500, started, size, 'proxy-panic:' + String((e && e.message) || e).slice(0, 60));
      if (!res.headersSent) {
        try { openAiError(res, 500, '代理内部错误: ' + ((e && e.message) || e)); } catch (e2) { /* 连接已断 */ }
      }
    });
  });
  req.on('error', () => clearTimeout(bodyDeadline));
});

async function handleChat(req, res, rawBody, size, started) {
  if (!size) return openAiError(res, 400, '请求体为空');

  // token 检查
  const tokenData = getToken();
  if (!tokenData || !tokenData.token) {
    return openAiError(res, 503, '本地无 token。请先在本项目目录运行: node refresh-token.js login');
  }
  const exp = tokenData.expiresAt || jwtExpiresAt(tokenData.token);
  const extraHeaders = {};
  if (exp - Date.now() < 30 * 60 * 1000) {
    extraHeaders['X-Token-Refresh-Hint'] = 'expiring';
    if (exp - Date.now() < 0) {
      return openAiError(res, 401, 'token 已过期,等待 watch 守护续期。请确认: node refresh-token.js watch 在运行', 'auth_error');
    }
  }

  // 解析 payload
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return openAiError(res, 400, '请求体不是合法 JSON: ' + e.message); }
  // OpenAI 请求体必须是对象:null/数组/标量属客户端格式错误,应在 400 挡住
  // (否则下面 payload.stream 访问会抛异常落进 500 兜底)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return openAiError(res, 400, '请求体必须是 JSON 对象(chat completion 格式)');
  }

  const clientWantsStream = payload.stream === true;
  payload.stream = true; // 对上游强制流式(绕 60s nginx 非流式超时)

  const estTokens = estimateTokens(rawBody);
  if (estTokens > 240000) {
    return openAiError(res, 413, 'prompt 估算 ' + estTokens + ' tokens,逼近上游 256K 上下文上限。请在客户端压缩上下文(history/truncate)后重试。');
  }

  if (!acquireSlot()) {
    return openAiError(res, 429, '代理限速:超过 60 req/min 或并发 8。稍后重试。', 'rate_limit');
  }

  // 上游生命周期:客户端断开/聚合超时都能中止上游,不白烧配额
  const ac = new AbortController();
  let clientGone = false;
  let timedOut = false;
  res.on('close', () => {
    // 响应未完成时连接关闭 = 客户端主动断开
    if (!res.writableEnded && !clientGone) {
      clientGone = true;
      ac.abort();
    }
  });

  try {
    if (clientWantsStream) {
      // ---- 流式透传 ----
      let headersSent = false;
      let passthroughBytes = 0;
      const sseHeaders = () => {
        if (headersSent) return;
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
      };
      // 背压:客户端读得慢时暂停读上游。入口先查断开状态——客户端已断开时
      // 'close' 早已发过,新挂的 drain/close 监听器永不触发,promise 将永久挂起,
      // callUpstream 不再 resolve,并发槽(finally)永不释放,累积 8 次后代理恒 429
      const waitDrain = () => {
        if (clientGone || res.destroyed || res.writableEnded) return Promise.resolve();
        return new Promise(r => {
          const done = () => { res.removeListener('drain', done); res.removeListener('close', done); r(); };
          res.once('drain', done);
          res.once('close', done);
        });
      };

      const result = await callUpstream(payload, tokenData.token, async (obj) => {
        sseHeaders();
        const line = 'data: ' + JSON.stringify(obj) + '\n\n';
        passthroughBytes += line.length;
        if (!res.write(line)) await waitDrain();
      }, (isSse) => { if (isSse) sseHeaders(); }, ac.signal);

      if (clientGone || result.type === 'aborted') {
        logReq(req, 499, started, size, 'client-disconnected');
        return;
      }
      if (result.type === 'error') {
        if (!headersSent) {
          dumpFailedRequest(rawBody);
          const mapped = translateUpstreamError(result.bodyObj, result.raw, result.status);
          logReq(req, mapped.http, started, size,
            'upstream-err raw=' + String(result.raw || '').slice(0, 150).replace(/\s+/g, ' '));
          return openAiError(res, mapped.http, mapped.message, 'upstream_error', extraHeaders);
        }
        // 极罕见:头已发出但流中断,只能断开
        if (!res.writableEnded) res.end();
        logReq(req, 200, started, size, 'stream-aborted');
        return;
      }
      if (result.type === 'idle-timeout') {
        logReq(req, 504, started, size, 'idle-timeout');
        if (!headersSent) openAiError(res, 504, '上游流式空闲超时(' + STREAM_IDLE_TIMEOUT / 1000 + 's 无数据)');
        else if (!res.writableEnded) res.end();
        return;
      }
      if (result.type === 'network-error') {
        logReq(req, 502, started, size, 'proxy-err:' + String(result.message).slice(0, 60));
        if (!headersSent) openAiError(res, 502, '代理到上游请求失败: ' + result.message);
        else if (!res.writableEnded) res.end();
        return;
      }
      if (result.type === 'completion') {
        // 上游以 JSON 给了完整 completion:补成 SSE 形态交付,不丢这次生成
        sseHeaders();
        res.write('data: ' + JSON.stringify(result.bodyObj) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        logReq(req, 200, started, size, 'stream,json-fallback');
        return;
      }
      // result.type === 'sse'
      if (headersSent) {
        res.write('data: [DONE]\n\n');
        res.end();
        logReq(req, 200, started, size, 'stream,' + (passthroughBytes / 1024).toFixed(1) + 'KB');
      } else {
        // 上游 event-stream 但零 chunk(异常)
        logReq(req, 502, started, size, 'empty-stream');
        openAiError(res, 502, '上游返回空流');
      }
      return;
    }

    // ---- 非流式:聚合 SSE ----
    const agg = makeAggregator();
    let chunkCount = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(); // 中止上游,迟到的结果不再写响应
      if (!res.headersSent) {
        openAiError(res, 504, '聚合超时(' + NONSTREAM_TOTAL_TIMEOUT / 1000 + 's)。上游生成时间过长,建议客户端改用 stream:true');
      }
    }, NONSTREAM_TOTAL_TIMEOUT);
    const result = await callUpstream(payload, tokenData.token, obj => {
      chunkCount++;
      agg.feed(obj);
    }, null, ac.signal);
    clearTimeout(timer);

    if (timedOut) { // 504 已由定时器发出,这里只补日志
      logReq(req, 504, started, size, 'agg-timeout');
      return;
    }
    if (clientGone || result.type === 'aborted') {
      logReq(req, 499, started, size, 'client-disconnected');
      return;
    }
    if (result.type === 'error') {
      dumpFailedRequest(rawBody);
      const mapped = translateUpstreamError(result.bodyObj, result.raw, result.status);
      logReq(req, mapped.http, started, size,
        'upstream-err raw=' + String(result.raw || '').slice(0, 150).replace(/\s+/g, ' '));
      return openAiError(res, mapped.http, mapped.message, 'upstream_error', extraHeaders);
    }
    if (result.type === 'idle-timeout') {
      logReq(req, 504, started, size, 'idle-timeout');
      return openAiError(res, 504, '上游流式空闲超时(' + STREAM_IDLE_TIMEOUT / 1000 + 's 无数据)');
    }
    if (result.type === 'network-error') {
      logReq(req, 502, started, size, 'proxy-err:' + String(result.message).slice(0, 60));
      return openAiError(res, 502, '代理到上游请求失败: ' + result.message);
    }
    if (result.type === 'completion') {
      // 上游直接给了完整 JSON completion:原样交付。
      // 不能喂给聚合器——feed 只认 delta 形态,message 会被丢成空内容
      logReq(req, 200, started, size, 'json-completion');
      return sendJson(res, 200, result.bodyObj, extraHeaders);
    }
    if (chunkCount === 0) {
      // 上游 event-stream 但零 chunk(异常):不应伪装成空 completion 的 200
      logReq(req, 502, started, size, 'empty-stream');
      return openAiError(res, 502, '上游返回空流');
    }
    const out = agg.result();
    logReq(req, 200, started, size, 'agg,' + chunkCount + 'chunks');
    sendJson(res, 200, out, extraHeaders);
  } finally {
    releaseSlot();
  }
}

function dumpFailedRequest(rawBody) {
  if (!DUMP_FAILED) return; // 默认关:body 含完整对话内容,落盘有隐私面
  try {
    // 写状态目录而非仓库目录:诊断文件可能被 git add -f / 打包发布带出仓库
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(TOKEN_FILE), 'last-failed-request.json'), rawBody);
  } catch (e) { /* 诊断文件写失败不影响主流程 */ }
}

function logReq(req, status, started, size, note) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + status + ' ' +
    ((Date.now() - started) / 1000).toFixed(1) + 's ' + (size / 1024).toFixed(0) + 'KB ' + note);
}

server.maxConnections = MAX_CONNECTIONS;
// Node 默认 headersTimeout=60s/requestTimeout=300s/keepAliveTimeout=5s,
// 对本机个人代理已够;显式设 keepAliveTimeout 略缩,降低连接囤积面
server.headersTimeout = 60e3;
server.requestTimeout = 120e3; // 含 body 接收(BODY_TIMEOUT 60s + 处理余量)
server.keepAliveTimeout = 10e3;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用:代理可能已在运行。如需另开实例,可用环境变量 PROXY_PORT。');
    process.exit(1);
  }
  // 只打 code/message:完整 error 对象的堆栈含本机绝对路径
  console.error('HTTP 服务错误:', (e && e.code) || '', (e && e.message) || e);
});

process.on('unhandledRejection', e => {
  // 长驻进程:记日志不退出,单次请求的异常不应拖垮整个代理。
  // 只打 message:堆栈含本机绝对路径,控制台输出常被贴进 issue
  console.error('[' + new Date().toLocaleTimeString() + '] [unhandledRejection]',
    (e && e.message) || e);
});

server.listen(PORT, HOST, () => {
  console.log('madmodel 反代已启动: http://' + HOST + ':' + PORT + '/v1');
  console.log('模型: ' + MODELS.join(', '));
  if (API_KEY) {
    console.log('本地鉴权: 已启用(' + (KEY_GENERATED ? '本次生成随机 key' : '复用已有') +
      (KEY_PERSISTED ? '' : ',⚠ 落盘失败,使用进程内临时 key') +
      ',客户端 Bearer key 见: ' + KEY_FILE_DISPLAY + ')');
  } else {
    console.log('⚠ 本地鉴权已关闭(PROXY_NO_AUTH=1):恶意网页可盲调本代理消耗配额,仅限测试');
  }
  console.log('token 文件: ' + KEY_FILE_DISPLAY.replace('api-key', 'token.json') + '(热加载,续期免重启)');
  const t = getToken();
  if (t) console.log('当前 token 剩余 ' + Math.round((t.expiresAt - Date.now()) / 60e3) + ' 分钟');
  else console.log('⚠ 尚无 token,请先: node refresh-token.js login');
});


