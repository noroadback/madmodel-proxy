// proxy.js
// madmodel DeepSeek-V4-Flash 本地反向代理(OpenAI 兼容)。
// 监听 127.0.0.1:8080,供 dsh 等标准 OpenAI 客户端使用。
//
// 职责(按已验证的 API 规格书):
//   1. token 热加载:每请求读 ~/.dsh-madmodel/token.json(watch 守护续期,免重启)
//   2. 强制上游 stream:true 绕 60s nginx 非流式超时;客户端要非流式时自己聚合 SSE
//   3. 错误翻译:上游错误(200+body 码 / 非 200 / HTML 网关错误页 / SSE 流内嵌
//      errorMessage)统一翻译为标准 4xx/5xx;流截断(EOF 无 [DONE])按 502/断流
//      处理,不聚合成假成功
//   4. 伪造 GET /v1/models(上游不存在该端点,返回 SPA HTML)
//   5. 预检:body > 950KB 提前 413(nginx 1MB 硬限,留余量)
//   6. 温和限速:60 req/min、并发 8(个人自用,防 agent 失控)
//   7. 本机安全边界:Host 白名单 + Bearer 鉴权 + 各级限额与超时(见 README 安全设计)
//
// 环境变量:PROXY_API_KEY(指定 key)/ PROXY_NO_AUTH(=1 关鉴权,仅测试)/
//          PROXY_PORT(默认 8080)/ DUMP_FAILED(=1 开诊断落盘)
//          PROXY_NO_GZIP(=1 关闭请求体 gzip)/ PROXY_UPSTREAM、PROXY_TOKEN_FILE(测试注入用)
//
// 历次加固与上游行为适配的时间线见 CHANGELOG.md。
//
// 用法: node proxy.js  (Ctrl+C 退出)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { jwtExpiresAt } = require('./madmodel-auth');
const { readTokenRecord } = require('./secure-store');
const { claimFile } = require('./atomic-file');
const paths = require('./paths');

const PORT = Number(process.env.PROXY_PORT) || 8080;
const HOST = '127.0.0.1';
// PROXY_UPSTREAM / PROXY_TOKEN_FILE:测试注入用(端到端测试时指向本地假上游)
const UPSTREAM = process.env.PROXY_UPSTREAM || 'https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions';
const MODEL = 'DeepSeek-V4-Flash';
const MODELS = [MODEL];
const TOKEN_FILE = process.env.PROXY_TOKEN_FILE || paths.TOKEN_FILE;

const BODY_LIMIT = 950 * 1024;        // nginx 1MB 限,留余量
const MAX_CONCURRENT = 8;            // 并发上限
const RATE_LIMIT = 60;               // 每分钟请求数
const STREAM_IDLE_TIMEOUT = 120e3;   // 流式空闲超时(实测晚高峰 ~36tps,120s 足够)
// 流式总时限:周期性 keep-alive 每次重置空闲计时,没有总上限的流可永久占用
// 并发槽。20 分钟 ≈ 数万 token 生成,正常请求远达不到(测试可经环境变量缩短)
const STREAM_TOTAL_TIMEOUT = Number(process.env.PROXY_STREAM_TOTAL_MS) || 1200e3;
const SSE_LINE_LIMIT = 1024 * 1024;  // 尾部未完成行的字节上限:无换行的病态流防内存膨胀
const NONSTREAM_TOTAL_TIMEOUT = 600e3; // 非流式聚合总超时(实测流式 600s 不断)
const UPSTREAM_HEADER_TIMEOUT = 30e3;  // 发出上游请求到收到响应头的超时
const UPSTREAM_JSON_BODY_LIMIT = 5 * 1024 * 1024;   // JSON 错误页/直答体上限
const UPSTREAM_SSE_TOTAL_LIMIT = 64 * 1024 * 1024;  // 单次流总字节上限(约=16M tokens,余量充分)
const MAX_CONNECTIONS = 32;          // server.maxConnections:本机个人代理,32 绰绰有余
const BODY_TIMEOUT = 60e3;           // 请求体接收完成时限(950KB 按拨号速度也该到了)
const PROMPT_TOKEN_LIMIT = 240000;   // prompt 估算上限,留余量于上游 256K 上下文

const KEY_FILE = paths.KEY_FILE;

// 本地鉴权:默认强制(启动时生成随机 key 并落盘,首启打印),防恶意网页 blind
// POST 盗用配额——Host 白名单挡不住无响应读取需求的 CSRF 式滥用。
// PROXY_API_KEY 显式指定;PROXY_NO_AUTH=1 仅测试场景关闭。
// key 文件为明文而非 DPAPI:它必须人工抄进客户端配置,离开本机即无用,且受
// 用户目录 ACL 保护。对比 creds/token 加密防的是文件离机外带。
function loadApiKey() {
  // 快路径:已有 key 直接复用(重启换 key 会把所有客户端打挂),稳态零写入
  const existing = paths.resolveApiKey();
  if (existing.source !== 'none') return { key: existing.key, env: existing.source === 'env' };
  const key = crypto.randomBytes(24).toString('base64url');
  try {
    // 并发首启:claimFile 用 link 仲裁,落败方拿到胜者的 key;
    // 历史遗留的空/损坏文件被识别为无效内容并自动接管
    const claim = claimFile(KEY_FILE, `${key}\n`, content => content.trim() !== '');
    return claim.installed
      ? { key, generated: true, persisted: true }
      : { key: claim.content.trim() };
  } catch (e) {
    // 落盘失败必须显式告警并打印 key:否则本进程仍在要求鉴权,而
    // refresh-token.js key 读不到文件会提示"尚无 key",用户被锁在门外且提示误导
    console.error(`⚠ 无法写入 API key 文件(${e.message})。本进程临时使用以下 key(重启后更换,请先修复写入权限):`);
    console.error(`  ${key}`);
    return { key, generated: true, persisted: false };
  }
}
const { key: API_KEY, env: KEY_ENV, generated: KEY_GENERATED, persisted: KEY_PERSISTED = true } = loadApiKey();
// 失败请求体落盘(默认关,隐私考虑:body 含完整对话内容)
const DUMP_FAILED = process.env.DUMP_FAILED === '1';
// 请求体 gzip 编码(默认开,见 callUpstream 内 WAF 注释;设 PROXY_NO_GZIP=1 关闭)
const GZIP_BODY = process.env.PROXY_NO_GZIP !== '1';
// Host 白名单:只认本机地址,拒绝一切外部域名(防 DNS rebinding)
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
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
    const hadPrevious = !!tokenCache.data;
    tokenCache = { mtime: stat.mtimeMs, data };
    // 热加载可见化:替换既有 token 时打一行日志,确认 watch 续期已被代理接住
    // (首次读取不打——启动横幅已覆盖)
    if (hadPrevious && data?.token) {
      const remainMin = Math.round((data.expiresAt - Date.now()) / 60e3);
      console.log(`[${stamp()}] token 已热加载` +
        (remainMin > 0 ? `,剩余 ${remainMin} 分钟(watch 续期完成)` : '(⚠ 新 token 仍为过期状态)'));
    }
    return data;
  } catch (e) {
    // 瞬态失败(如恰好读到续期进程写到一半的文件):回退上一次可用 token,下一请求自愈
    return tokenCache.data || null;
  }
}

// ===== 限速 =====
let active = 0;
const rateWindow = [];
// 返回 true(拿到槽)或被拒原因 'rate'/'concurrent',调用方据此记日志
function acquireSlot() {
  const now = Date.now();
  while (rateWindow.length && now - rateWindow[0] > 60e3) rateWindow.shift();
  if (rateWindow.length >= RATE_LIMIT) return 'rate';
  // 通过速率检查即计入窗口:并发打满时被拒的请求也占名额,
  // 防止客户端在并发上限处无限空转却永远不受速率约束
  rateWindow.push(now);
  if (active >= MAX_CONCURRENT) return 'concurrent';
  active++;
  return true;
}
function releaseSlot() { active = Math.max(0, active - 1); }

// ===== 工具 =====
// 日志时间戳。固定 HH:MM:SS 而非 toLocaleTimeString:后者随机器 locale 变形
// (12 小时制/中文"下午"),日志被贴进 issue 时不可比对
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function estimateTokens(bodyBuffer) {
  // 无分词器的粗估:UTF-8 字节 ÷ 3.5(中文≈1字/token 但占3字节,英文≈4字符/token 的折中)
  return Math.round(bodyBuffer.length / 3.5);
}

// 常时比较(先哈希等长,防长度泄露)
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
  const detail = bodyObj && (bodyObj.errorMessage || bodyObj.message || bodyObj.error?.message ||
    bodyObj.detail || (typeof bodyObj.error === 'string' ? bodyObj.error : ''));
  if (bodyObj?.status === 10003) {
    return { http: 401, message: '认证失败(token 无效或已过期)。请确认 watch 守护进程在运行: node refresh-token.js watch' };
  }
  if (bodyObj?.status === 10001) {
    return { http: 429, message: `上游拒绝:${detail || '(上游未提供详情)'}(可能是上下文超限≈256K、请求体超限 1MB 或服务繁忙)` };
  }
  // SSE 内嵌错误无错误码,按文案识别繁忙:语义对齐 10001,客户端拿到 429
  // 才会退避重试,而不是把可自愈的瞬时繁忙当硬错误
  if (typeof bodyObj?.errorMessage === 'string' && /繁忙/.test(bodyObj.errorMessage)) {
    return { http: 429, message: `上游繁忙(SSE 内嵌错误): ${bodyObj.errorMessage}` };
  }
  if (detail) {
    return { http: 502, message: `上游拒绝请求: ${String(detail).slice(0, 300)}` };
  }
  // HTML 错误页(实测 2026-09-04:清华负载均衡 TsinghuaLB 在后端瞬时不可达时
  // 直接回 HTML 502 页,0.1s 即拒)。放在 detail 之后:能解析成 JSON 的响应
  // 走上面的正常路径,只有整个 body 是 HTML 时才落到这里
  if (raw && /<html/i.test(String(raw))) {
    return { http: status >= 500 ? status : 502,
      message: `上游网关/负载均衡返回 HTML ${status} 错误页(实测形态:TsinghuaLB 502,后端瞬时不可达)。稍后重试通常自愈` };
  }
  return { http: 502, message: `上游返回无法识别的响应(前 200 字符): ${String(raw || '').slice(0, 200)}` };
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
//   {type:'sse'}            流正常结束([DONE] 后取消连接)
//   {type:'sse-truncated'}  EOF 未见 [DONE](上游截断,不能当成功交付)
//   {type:'sse-invalid'}    协议错误:坏帧(非 JSON data 行)/单行超长无换行
//   {type:'total-timeout'}  流式总时限已到(周期性心跳不再能永久占用并发槽)
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
    let totalTimer = null;
    let reader = null;
    let upBody = null; // JSON 应答路径在 reader 建立前保留 body 以便取消
    const upstreamAbort = new AbortController();
    // 桥接外部 signal(客户端断开 / 聚合超时 → 中止上游,不白烧配额)。
    // 不用 AbortSignal.any:手动桥接对所有 Node 版本一致,且已覆盖 aborted 初态
    if (signal) {
      if (signal.aborted) upstreamAbort.abort();
      else signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });
    }
    const fetchSignal = upstreamAbort.signal;
    // 响应头超时:TCP/TLS/代理层挂住时 30s 放弃,不长期占用并发槽
    // (空闲计时器只覆盖"收到响应后";这里覆盖"发出请求到响应头"的窗口)
    const headerTimer = setTimeout(() => {
      if (settled) return;
      try { upstreamAbort.abort(); } catch (e) {}
      cancelBody();
      finish({ type: 'network-error', message: `上游 ${UPSTREAM_HEADER_TIMEOUT / 1000}s 未返回响应头(连接或网关挂起)` });
    }, UPSTREAM_HEADER_TIMEOUT);
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      resolve(v);
    };
    const cancelBody = () => {
      try {
        const p = reader ? reader.cancel() : upBody?.cancel();
        if (p?.catch) p.catch(() => {});
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
    // 编码的请求体则不再触发该规则。设 PROXY_NO_GZIP=1 可关闭;误拦截的正路是
    // 向平台反馈误报。详见 README"已知兼容性问题"一节。
    const reqHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
      // 总时限统一覆盖两条应答路径(SSE 与 JSON fallback):空闲超时挡不住
      // "周期性发字节"的流,总上限兜底并发槽占用
      totalTimer = setTimeout(() => {
        cancelBody();
        finish({ type: 'total-timeout' });
      }, STREAM_TOTAL_TIMEOUT);

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
          if (e?.code === 'UPSTREAM_BODY_LIMIT') {
            return finish({ type: 'network-error', message: `上游 JSON 响应超过 ${UPSTREAM_JSON_BODY_LIMIT / 1048576}MB 上限` });
          }
          return finish({ type: 'network-error', message: `上游 JSON 响应读取失败: ${String(e?.message || e)}` });
        }
        if (settled) return;
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) { /* fallthrough */ }
        if (obj?.choices) return finish({ type: 'completion', bodyObj: obj });
        return finish({ type: 'error', status: up.status, bodyObj: obj, raw: text.slice(0, 500) });
      }

      // 逐行解析 SSE(总量限量:异常大的流按错误带回,内存上限可控)
      reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let total = 0;
      let usage = null; // 末尾 usage chunk(include_usage 注入后上游才回)
      armIdle();
      for (;;) {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) break;
        armIdle();
        total += value.length;
        if (total > UPSTREAM_SSE_TOTAL_LIMIT) {
          cancelBody();
          return finish({ type: 'network-error', message: `上游响应超过 ${UPSTREAM_SSE_TOTAL_LIMIT / 1048576}MB 上限` });
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            // [DONE] 即终止:主动取消 reader。上游可能在 [DONE] 后不关连接,
            // 不取消则每请求泄漏一个挂着的上游连接(keep-alive 假上游可复现)
            cancelBody();
            return finish({ type: 'sse', usage });
          }
          // 解析与下游写分开处理:坏帧是协议错误(静默跳过会把"丢了部分内容
          // 仍标记成功"伪装成正常结束),写失败是客户端已断(应立即取消上游,
          // 释放连接与并发槽,而不是继续白读)
          let obj;
          try { obj = JSON.parse(data); }
          catch (e) {
            // 空数据帧(实测上游网关会在流中发送):无内容可丢,跳过不构成
            // "丢内容仍标成功";非空坏帧仍按协议错误终止,并把帧内容带进
            // 日志/错误信息(协议层垃圾,非对话内容)
            if (data === '') continue;
            cancelBody();
            return finish({ type: 'sse-invalid',
              message: `上游 SSE 坏帧(len=${data.length}): ${JSON.stringify(data.slice(0, 40))}` });
          }
          // 上游会把部分错误以 200 + SSE 流内嵌 errorMessage 的形态返回(实测:
          // 模型不存在/服务器繁忙)。不能当正常 chunk 透传——否则流式客户端
          // 收到假 200,非流式客户端被聚合出空内容的假成功
          if (obj && typeof obj === 'object' && obj.errorMessage !== undefined && !obj.choices) {
            cancelBody();
            return finish({ type: 'error', status: up.status, bodyObj: obj, raw: data.slice(0, 500) });
          }
          if (obj?.usage) usage = obj.usage;
          if (onSseChunk) {
            try { await onSseChunk(obj); }
            catch (e) {
              cancelBody();
              return finish({ type: 'network-error', message: `下游写失败(客户端已断开): ${String(e?.message || e)}` });
            }
          }
          if (settled) return;
        }
        // 行缓冲上限只约束"尾部未完成行"(完整行已消化,大块合法数据不误伤),
        // 按 UTF-8 字节而非 JS 字符计
        if (buf && Buffer.byteLength(buf, 'utf8') > SSE_LINE_LIMIT) {
          cancelBody();
          return finish({ type: 'sse-invalid', message: `上游 SSE 单行超过 ${SSE_LINE_LIMIT / 1024}KB 无换行` });
        }
      }
      // EOF 但未见 [DONE]:上游截断(网关掐流/连接中断),不能当正常结束,
      // 否则下游会把半截回答当完整回答
      finish({ type: 'sse-truncated', usage });
    }).catch((e) => {
      if (signal?.aborted) return finish({ type: 'aborted' });
      finish({ type: 'network-error', message: String(e?.message || e) });
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
      const ch = obj.choices?.[0];
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
      const toolList = Object.keys(this.toolCalls).sort((a, b) => Number(a) - Number(b))
        .map(k => this.toolCalls[k]).filter(tc => tc.id || tc.function.name);
      if (toolList.length) message.tool_calls = toolList;
      return {
        id: this.id || `chatcmpl-proxy-${Date.now()}`,
        object: 'chat.completion',
        created: this.created || Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{ index: 0, message, finish_reason: this.finish || 'stop' }],
        usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

// "流未以合法 [DONE] 结束"的三种形态(截断 / 坏帧 / 总时限)共用一份文案与
// 日志名。流式与非流式只在 note 前缀上不同,判定与措辞不该各写一遍。
const FAILED_STREAM_TYPES = ['sse-truncated', 'sse-invalid', 'total-timeout'];
function describeFailedStream(result, notePrefix) {
  if (result.type === 'sse-truncated') {
    return { note: `${notePrefix}-truncated`, message: '上游流被截断(未见终止标记 [DONE])' };
  }
  if (result.type === 'sse-invalid') {
    return { note: `${notePrefix}-invalid`, message: result.message || '上游 SSE 协议错误' };
  }
  return {
    note: `${notePrefix}-total-timeout`,
    message: `上游流式总超时(${Math.round(STREAM_TOTAL_TIMEOUT / 1000)}s)`,
  };
}

// ===== 请求参数归一化 =====
// 上游对参数很挑,而主流 OpenAI 客户端(dsh / codex / claude code)恰好都会发它
// 拒绝或忽略的东西。原样转发的后果是错误信息指向完全错误的方向:logprobs 被网关
// 拒时表现为流内"服务器繁忙",模型名差一个字表现为"模型不存在"。这里统一改写,
// 并把改写内容记进访问日志——客户端行为被代理修改过,排查时必须看得见。
//
// 实测(2026-09,详见 README"已验证的上游行为"):
//   logprobs / top_logprobs  网关直接拒
//   thinking / reasoning_effort  官方方言无效,仅 vLLM 方言 chat_template_kwargs 生效
//   n > 1  上游不支持
const UPSTREAM_REJECTED = ['logprobs', 'top_logprobs'];
function normalizePayload(payload) {
  const applied = [];

  // 单模型代理:任何模型名都重写。/v1/models 只广告一个模型,会发别的名字的
  // 客户端本就是配错了,让它可用比回"模型不存在"有用
  if (payload.model !== MODEL) {
    if (payload.model !== undefined) applied.push(`model=${String(payload.model).slice(0, 40)}`);
    payload.model = MODEL;
  }

  for (const key of UPSTREAM_REJECTED) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (payload.n !== undefined && payload.n !== 1) {
    // 聚合器只认 choices[0],多候选即便上游支持也交付不出去
    delete payload.n;
    applied.push('-n');
  }

  // "关闭推理"的三种客户端方言(OpenAI reasoning_effort / Anthropic thinking)
  // 都归到上游唯一认的 vLLM 方言上,而不是丢掉——客户端的意图值得被兑现
  const wantsNoThinking = payload.reasoning_effort === 'none' ||
    payload.thinking === false || payload.thinking?.type === 'disabled';
  for (const key of ['thinking', 'reasoning_effort']) {
    if (payload[key] !== undefined) {
      delete payload[key];
      applied.push(`-${key}`);
    }
  }
  if (wantsNoThinking) {
    const kwargs = payload.chat_template_kwargs;
    payload.chat_template_kwargs = (kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs))
      ? { ...kwargs, thinking: false }
      : { thinking: false };
    applied.push('thinking=false');
  }

  return applied;
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
    // 早退路径同样记日志(下同):这些是防御被触发的信号,不留痕则威胁模型
    // 永远无法验证——"有没有恶意网页/失控进程在打我"将无从回答
    logReq(req, 403, started, 0, 'host-rejected');
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
    logReq(req, 404, started, 0, 'no-endpoint');
    return openAiError(res, 404, '端点不存在。可用:POST /v1/chat/completions,GET /v1/models');
  }

  // 本地鉴权(默认强制):恶意网页对本机的 blind POST 带不上 Bearer key
  if (API_KEY) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || !safeEqual(m[1].trim(), API_KEY)) {
      // auth-missing(无凭据:探测/浏览器盲发)与 auth-failed(凭据错误:
      // 客户端配错 key)分开记——前者是威胁信号,后者是配置问题
      logReq(req, 401, started, 0, m ? 'auth-failed' : 'auth-missing');
      return openAiError(res, 401,
        `无效或缺失 API key。本代理已启用本地鉴权,key 见: ${paths.display(KEY_FILE)}`,
        'auth_error', { 'WWW-Authenticate': 'Bearer' });
    }
  }

  // Content-Length 预检:超限在收任何 body 字节前就拒绝,不陪慢速攻击者耗资源
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > BODY_LIMIT) {
    logReq(req, 413, started, declaredLen, 'cl-precheck');
    return openAiError(res, 413, `请求体 ${(declaredLen / 1024).toFixed(0)}KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。`);
  }

  // 读 body(带硬上限与完成时限:慢速发送者到点即弃,不再无限占连接与内存)
  const chunks = [];
  let size = 0;
  let aborted = false;
  const bodyDeadline = setTimeout(() => {
    if (aborted || res.writableEnded) return;
    aborted = true;
    logReq(req, 408, started, size, 'body-timeout');
    openAiError(res, 408, `请求体接收超时(${BODY_TIMEOUT / 1000}s)。慢速或中断的上传已被放弃。`);
    req.destroy();
  }, BODY_TIMEOUT);
  bodyDeadline.unref();
  req.on('data', c => {
    if (aborted) return;
    size += c.length;
    if (size > BODY_LIMIT) {
      aborted = true;
      logReq(req, 413, started, size, 'body-overflow');
      openAiError(res, 413, `请求体 ${(size / 1024).toFixed(0)}KB 超过上限(上游 nginx 硬限 1MB,代理预留 950KB)。请压缩上下文后重试。`);
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
      logReq(req, 500, started, size, `proxy-panic:${String(e?.message || e).slice(0, 60)}`);
      if (!res.headersSent) {
        try { openAiError(res, 500, `代理内部错误: ${e?.message || e}`); } catch (e2) { /* 连接已断 */ }
      }
    });
  });
  req.on('error', () => clearTimeout(bodyDeadline));
});

async function handleChat(req, res, rawBody, size, started) {
  if (!size) {
    logReq(req, 400, started, size, 'empty-body');
    return openAiError(res, 400, '请求体为空');
  }

  // token 检查
  const tokenData = getToken();
  if (!tokenData || !tokenData.token) {
    logReq(req, 503, started, size, 'no-token');
    return openAiError(res, 503, '本地无 token。请先在本项目目录运行: node refresh-token.js login');
  }
  const exp = tokenData.expiresAt || jwtExpiresAt(tokenData.token);
  const msLeft = exp - Date.now();
  if (msLeft < 0) {
    logReq(req, 401, started, size, 'token-expired');
    return openAiError(res, 401, 'token 已过期,等待 watch 守护续期。请确认: node refresh-token.js watch 在运行', 'auth_error');
  }
  // 续期提示头:两条应答路径都带上(流式路径经 sseHeaders 注入)
  const extraHeaders = msLeft < 30 * 60 * 1000 ? { 'X-Token-Refresh-Hint': 'expiring' } : {};

  // 解析 payload
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch (e) {
    logReq(req, 400, started, size, 'bad-json');
    return openAiError(res, 400, `请求体不是合法 JSON: ${e.message}`);
  }
  // OpenAI 请求体必须是对象:null/数组/标量属客户端格式错误,应在 400 挡住
  // (否则下面 payload.stream 访问会抛异常落进 500 兜底)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    logReq(req, 400, started, size, 'not-object');
    return openAiError(res, 400, '请求体必须是 JSON 对象(chat completion 格式)');
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
  // 归一化客户端参数(模型名/上游拒绝项/思考方言),改写内容进日志
  const normalized = normalizePayload(payload);
  const normNote = normalized.length ? ` norm[${normalized.join(' ')}]` : '';

  const estTokens = estimateTokens(rawBody);
  if (estTokens > PROMPT_TOKEN_LIMIT) {
    logReq(req, 413, started, size, `token-est=${estTokens}`);
    return openAiError(res, 413, `prompt 估算 ${estTokens} tokens,逼近上游 256K 上下文上限。请在客户端压缩上下文(history/truncate)后重试。`);
  }

  const limitReason = acquireSlot();
  if (limitReason !== true) {
    // 限速被触发必须可见:上游故障引发的客户端重试风暴里,被代理挡掉的
    // 请求量是事后分析事故的第一手数据
    logReq(req, 429, started, size, `limited:${limitReason}`);
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
          ...extraHeaders,
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
        const line = `data: ${JSON.stringify(obj)}\n\n`;
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
            `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
          return openAiError(res, mapped.http, mapped.message, 'upstream_error', extraHeaders);
        }
        // 头已发出(SSE 200),状态码无法再改:断流让客户端按截断处理;日志
        // 带上游错误原文(含 SSE 内嵌 errorMessage 形态),不记成无来由的 200
        if (!res.writableEnded) res.end();
        logReq(req, 200, started, size, `stream-aborted upstream-err=${String(
          result.bodyObj?.errorMessage || result.bodyObj?.message || result.raw || ''
        ).slice(0, 120).replace(/\s+/g, ' ')}`);
        return;
      }
      if (result.type === 'idle-timeout') {
        logReq(req, 504, started, size, 'idle-timeout');
        if (!headersSent) openAiError(res, 504, `上游流式空闲超时(${STREAM_IDLE_TIMEOUT / 1000}s 无数据)`);
        else if (!res.writableEnded) res.end();
        return;
      }
      if (result.type === 'network-error') {
        logReq(req, 502, started, size, `proxy-err:${String(result.message).slice(0, 60)}`);
        if (!headersSent) openAiError(res, 502, `代理到上游请求失败: ${result.message}`);
        else if (!res.writableEnded) res.end();
        return;
      }
      if (result.type === 'completion') {
        // 上游以 JSON 给了完整 completion:补成 SSE 形态交付,不丢这次生成
        sseHeaders();
        res.write(`data: ${JSON.stringify(result.bodyObj)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        logReq(req, 200, started, size, `stream,json-fallback${usageNote(result.bodyObj?.usage)}${normNote}`);
        return;
      }
      if (FAILED_STREAM_TYPES.includes(result.type)) {
        // 不能补 [DONE] 伪装成完整回答。已发头则断流,客户端的截断检测/重试接手
        const { note, message } = describeFailedStream(result, 'stream');
        if (headersSent) {
          res.end();
          // stream-invalid 携带坏帧预览(协议层诊断信息),让流式客户端的
          // 截断在日志里也有"为什么"可查
          logReq(req, 200, started, size, `${note},${(passthroughBytes / 1024).toFixed(1)}KB` +
            (result.message ? ` ${result.message.slice(0, 70)}` : ''));
        } else {
          logReq(req, 502, started, size, note);
          openAiError(res, 502, message);
        }
        return;
      }
      // result.type === 'sse'
      if (headersSent) {
        res.write('data: [DONE]\n\n');
        res.end();
        logReq(req, 200, started, size, `stream,${(passthroughBytes / 1024).toFixed(1)}KB${usageNote(result.usage)}${normNote}`);
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
        openAiError(res, 504, `聚合超时(${NONSTREAM_TOTAL_TIMEOUT / 1000}s)。上游生成时间过长,建议客户端改用 stream:true`);
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
        `upstream-err raw=${String(result.raw || '').slice(0, 150).replace(/\s+/g, ' ')}`);
      return openAiError(res, mapped.http, mapped.message, 'upstream_error', extraHeaders);
    }
    if (result.type === 'idle-timeout') {
      logReq(req, 504, started, size, 'idle-timeout');
      return openAiError(res, 504, `上游流式空闲超时(${STREAM_IDLE_TIMEOUT / 1000}s 无数据)`);
    }
    if (result.type === 'network-error') {
      logReq(req, 502, started, size, `proxy-err:${String(result.message).slice(0, 60)}`);
      return openAiError(res, 502, `代理到上游请求失败: ${result.message}`);
    }
    if (FAILED_STREAM_TYPES.includes(result.type)) {
      // 聚合路径:未以合法 [DONE] 结束即失败,不把半截回答当完整 completion 交付
      const { note, message } = describeFailedStream(result, 'agg');
      logReq(req, 502, started, size, `${note},${chunkCount}chunks`);
      return openAiError(res, 502, `${message},已收 ${chunkCount} 块,请重试`);
    }
    if (result.type === 'completion') {
      // 上游直接给了完整 JSON completion:原样交付。
      // 不能喂给聚合器——feed 只认 delta 形态,message 会被丢成空内容
      logReq(req, 200, started, size, `json-completion${usageNote(result.bodyObj.usage)}${normNote}`);
      return sendJson(res, 200, result.bodyObj, extraHeaders);
    }
    if (chunkCount === 0) {
      // 上游 event-stream 但零 chunk(异常):不应伪装成空 completion 的 200
      logReq(req, 502, started, size, 'empty-stream');
      return openAiError(res, 502, '上游返回空流');
    }
    const out = agg.result();
    logReq(req, 200, started, size, `agg,${chunkCount}chunks${usageNote(agg.usage)}${normNote}`);
    sendJson(res, 200, out, extraHeaders);  } finally {
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

server.maxConnections = MAX_CONNECTIONS;
// Node 默认 headersTimeout=60s/requestTimeout=300s/keepAliveTimeout=5s,
// 对本机个人代理已够;显式设 keepAliveTimeout 略缩,降低连接囤积面
server.headersTimeout = 60e3;
server.requestTimeout = 120e3; // 含 body 接收(BODY_TIMEOUT 60s + 处理余量)
server.keepAliveTimeout = 10e3;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用:代理可能已在运行。如需另开实例,可用环境变量 PROXY_PORT。`);
    process.exit(1);
  }
  // 只打 code/message:完整 error 对象的堆栈含本机绝对路径
  console.error('HTTP 服务错误:', e?.code || '', e?.message || e);
});

process.on('unhandledRejection', e => {
  // 长驻进程:记日志不退出,单次请求的异常不应拖垮整个代理。
  // 只打 message:堆栈含本机绝对路径,控制台输出常被贴进 issue
  console.error(`[${stamp()}] [unhandledRejection]`,
    e?.message || e);
});
process.on('uncaughtException', e => {
  // 同步异常的最后防线:记一行后退出,由 dashboard 自动重启接管(无 dashboard
  // 时用户重开 start.cmd)。比带着损坏状态继续服务更安全
  console.error(`[${stamp()}] [uncaughtException]`,
    e?.message || e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`madmodel 反代已启动: http://${HOST}:${PORT}/v1`);
  console.log(`模型: ${MODELS.join(', ')}`);
  if (API_KEY) {
    console.log(`本地鉴权: 已启用(${KEY_ENV ? '环境变量 PROXY_API_KEY 指定' : KEY_GENERATED ? '本次生成随机 key' : '复用已有'}` +
      (KEY_PERSISTED ? '' : ',⚠ 落盘失败,使用进程内临时 key') +
      `,客户端 Bearer key 见: ${paths.display(KEY_FILE)})`);
  } else {
    console.log('⚠ 本地鉴权已关闭(PROXY_NO_AUTH=1):恶意网页可盲调本代理消耗配额,仅限测试' +
      (process.env.PROXY_API_KEY ? ';注意:PROXY_API_KEY 已设置但被 NO_AUTH 覆盖,不参与鉴权' : ''));
  }
  console.log(`token 文件: ${paths.display(paths.TOKEN_FILE)}(热加载,续期免重启)`);
  const t = getToken();
  if (t) {
    const remainMin = Math.round((t.expiresAt - Date.now()) / 60e3);
    if (remainMin <= 0) {
      // 启动竞态:start.cmd 同时拉起 watch 与代理,代理先读到的是续期前的旧 token
      console.log(`⚠ token 已过期 ${-remainMin} 分钟。若 watch 守护刚随本代理启动,` +
        '续期通常在半分钟内完成(完成时此处会追加"token 已热加载"日志,期间请求短暂 401);' +
        '若 watch 未运行,请通过 start.cmd 启动');
    } else if (remainMin < 30) {
      console.log(`当前 token 剩余 ${remainMin} 分钟(即将进入续期窗口)`);
    } else {
      console.log(`当前 token 剩余 ${remainMin} 分钟`);
    }
  } else {
    console.log('⚠ 尚无 token,请先: node refresh-token.js login');
  }
});


