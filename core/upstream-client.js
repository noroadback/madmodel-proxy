// core/upstream-client.js
// 上游转发核心，流式或非流式由调用方指定。
// 整个生命周期由一个 AbortController 管理；header / idle / total 三类
// 超时在统一收尾路径清理;外部取消立即中止 fetch、reader 与全部计时器。
// 不写日志、不写 HTTP response、不拼接 completion、不判断客户端是否流式。
//
// 结果类型(全集,只 resolve 不 reject,调用方免于双通道控制流):
//   {type:'stream', usage}                      流正常结束([DONE] 后已取消 reader)
//   {type:'completion', body}                   上游异常地以 JSON 返回完整 completion
//   {type:'upstream-error', status, body, raw}  上游以 JSON/SSE 内嵌返回错误
//   {type:'timeout', phase:'headers'|'idle'|'total'}
//   {type:'aborted'}                            外部 signal 中止(客户端断开/聚合超时)
//   {type:'protocol-error', reason:'truncated'|'invalid', message}
//   {type:'network-error', cause, phase, codes, requestBytes, receivedBytes, responseStatus}
//                                               请求/读取/交付层错误；不携带原始 cause
// requestBytes 是序列化后的请求体大小，不表示已上传字节数。
//
// truncated 结果额外带 idleMs(距上一帧收到的时长;从未收到字节时即整个请求
// 已等待时长)与 sawBytes(是否收到过任何字节),错误文案据此区分"首帧都没等到"
// 与"中途停帧"两形态。
//
// idle 守卫的口径:按"上游产出字节"计时,下游交付(onChunk,含背压等待)期间
// 挂起——客户端停读造成的静默不是上游挂死。交付完成后重新计时。
//
// onChunk(obj, {receivedAt}) 收每个 SSE data JSON，receivedAt 是网络块的
// 单调读取时间；同块所有事件共享该值，不把逐事件交付耗时当成生成间隔。
// 可为 async(背压等待期间不再读上游);
// onOpen(isSse) 在上游响应头到达时调用一次。
//
// === 异常契约(调用方依赖) ===
// request() 的返回 promise **只 resolve 结果对象,不 reject**(内部唯一的
// 主错误通道是 .catch → 按结果形态带回)。mock 或未来实现若违反此契约
// 直接 reject,调用方(proxy-service.handleRequest)的 try/finally 仍会释放
// inflight,但异常会向上传播到 HTTP adapter,由其兜底转 500——行为可预期,
// 不是静默吞掉。

'use strict';

const { randomUUID } = require('crypto');
const { performance } = require('node:perf_hooks');
const { SseParser } = require('./stream-parser');
const { createFailureDiagnostics } = require('./failure-diagnostics');

// 限量读:错误页/直答异常膨胀时及时放弃,不无限缓冲(超限抛 UPSTREAM_BODY_LIMIT)
async function readLimited(reader, limit, onProgress) {
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length && onProgress) onProgress(value.length);
    total += value.length;
    if (total > limit) {
      // 已结束的 reader 再次 cancel 属重复取消,是该忽略的清理错误
      try { await reader.cancel(); } catch (e) { /* 重复取消 */ }
      const error = new Error('upstream body exceeds limit');
      error.code = 'UPSTREAM_BODY_LIMIT';
      throw error;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// 在唯一的序列化出口剔除保留的 `__` 顶层字段，不修改调用方的对象。
function stripInternalFields(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  let out = null;
  for (const k of Object.keys(payload)) {
    if (k.startsWith('__')) {
      if (!out) out = { ...payload };
      delete out[k];
    }
  }
  return out || payload;
}

// 只保留错误类型和有限的错误码，不把 cause 中的 URL、凭据或任意错误消息写入日志。
function networkErrorCodes(error) {
  const pending = [error], seen = new Set(), codes = new Set();
  for (let n = 0; pending.length && n < 16; n++) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code)) codes.add(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
    if (codes.size >= 8) break;
  }
  return [...codes];
}

function createUpstreamClient(config) {
  const {
    upstream, tunnelMode,
    streamIdleTimeout, streamTotalTimeout, upstreamHeaderTimeout,
    upstreamJsonBodyLimit, upstreamSseTotalLimit, sseLineLimit,
  } = config;

  function request({ payload, token, cookie, signal, onChunk, onOpen }) {
    return new Promise((resolve) => {
      const diagnostics = createFailureDiagnostics(config);
      // 零字节截断时"已等待多久"的计时起点(见 truncated 结果的 idleMs)
      const requestStart = Date.now();
      // 单一 AbortController:外部 signal(客户端断开/聚合超时)与 header 超时
      // 都汇入这里;idle/total 超时经 cancelBody 令读取循环结束。
      // 不用 AbortSignal.any:手动桥接对所有 Node 版本一致,且已覆盖 aborted 初态
      const lifecycle = new AbortController();
      const onAbort = () => lifecycle.abort();
      if (signal) {
        if (signal.aborted) lifecycle.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      let settled = false;
      let idleTimer = null;
      let totalTimer = null;
      let headerTimer = null;
      let reader = null;
      let upBody = null; // JSON 应答路径在 reader 建立前保留 body 以便取消
      let phase = 'request', requestBytes = 0, receivedBytes = 0, responseStatus = null;
      const networkError = (error, message) => {
        const known = /^(fetch failed|terminated|network error)$/i.test(error?.message || '')
          ? error.message : (/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error?.name || '') ? error.name : '网络异常');
        return { type: 'network-error', cause: message || known, phase,
          requestBytes, receivedBytes, responseStatus, codes: networkErrorCodes(error) };
      };
      const received = bytes => { receivedBytes += bytes; armIdle(); };

      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(headerTimer);
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (diagnostics) v.diagnostics = diagnostics.finish({ phase, requestBytes, receivedBytes, responseStatus });
        resolve(v);
      };
      const cancelBody = () => {
        if (!reader && !upBody) return;
        // 已结束/已断开的 body 再次 cancel 只会重复取消或抛"连接已关闭",
        // 均为可忽略的清理错误
        try {
          const p = reader ? reader.cancel() : upBody.cancel();
          if (p?.catch) p.catch(() => {});
        } catch (e) { /* 连接已关闭 */ }
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          cancelBody();
          finish({ type: 'timeout', phase: 'idle' });
        }, streamIdleTimeout);
      };
      // 响应头超时覆盖连接、上传及等待响应头；收到头后由 idle / total 接管。
      headerTimer = setTimeout(() => {
        lifecycle.abort(); // abort() 无抛出路径;中止尚未建立的连接
        cancelBody();
        finish({ type: 'timeout', phase: 'headers' });
      }, upstreamHeaderTimeout);

      (async () => {
        // 请求体明文直发,不做 gzip。1.4.1 之前压缩过,为绕上游 WAF 的 SQL
        // 注入特征规则:它误拦含字面量 "(set " 的明文请求体(agent 工具的
        // 系统提示词常见),症状是 404 + 一串 SPA HTML。上游 2026-09-08 移除
        // 该规则后规避删除(完整实现见 git 历史 b377a5e)。若 404 + HTML 再现,
        // 先按"提示词内容被 WAF 拦"查,而不是先怀疑端点变更
        const reqHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        };
        // WebVPN 隧道会话凭证:仅隧道形态回传——不带会被隧道当未登录踢回
        // 登录页(表现为 upstream-error 502/307);直连覆盖(PROXY_UPSTREAM)时
        // webvpn 域签发的 cookie 不发给 madmodel.cs 域(凭据卫生:cookie 只
        // 回传给签发它的 origin)
        if (cookie && tunnelMode) reqHeaders.Cookie = cookie;

        let outgoingPayload = stripInternalFields(payload);
        // Qwen 曾在复用前缀缓存时输出多语言乱码，固定盐重用也会复发。
        // 每次实际发送都换盐（含凭据重试），仅改发送副本；保留此防护，
        // 直到长对话与开启思考的对照验证足以支持移除。
        if (outgoingPayload?.model === 'qwen3.8-27b') {
          outgoingPayload = { ...outgoingPayload, cache_salt: randomUUID() };
        }
        const requestBody = Buffer.from(JSON.stringify(outgoingPayload), 'utf8');
        requestBytes = requestBody.length;
        const fetchRequest = () => fetch(upstream, {
          method: 'POST',
          headers: reqHeaders,
          body: requestBody,
          redirect: 'manual',
          signal: lifecycle.signal,
        });
        const up = await (diagnostics ? diagnostics.run(fetchRequest) : fetchRequest());
        clearTimeout(headerTimer);
        upBody = up.body;
        phase = 'response-body';
        responseStatus = up.status;
        // 所有响应体均受总时限约束，含持续发字节的错误响应。
        totalTimer = setTimeout(() => {
          cancelBody();
          finish({ type: 'timeout', phase: 'total' });
        }, streamTotalTimeout);
        // 非 2xx 一律走错误翻译,不再按 content-type 决定路径(1.8.1):
        // 实测复现过 500 + text/event-stream + 标准 error 对象帧的形态,旧
        // 逻辑把它当正常流送进聚合器,下游收到 200 + content:null 的假成功。
        // 本上游的合法应答恒为 200(直连实测),非 2xx 必是错误(网关 502/504
        // HTML、302 登录跳转、307 门禁),读完有限 body 交给翻译层
        if (!up.ok) {
          armIdle();
          let text;
          try {
            reader = up.body.getReader();
            text = (await readLimited(reader, upstreamJsonBodyLimit, received)).toString('utf8');
          } catch (e) {
            cancelBody();
            return finish(networkError(e, '上游错误响应读取失败'));
          }
          if (settled) return;
          let obj = null;
          try { obj = JSON.parse(text); } catch (e) { /* HTML 错误页等:按 body=null 带回原文 */ }
          cancelBody();
          // location 一并带回:302 → /login 是 WebVPN 会话失效的确认签名
          // (proxy-service 的等待重试据此判定),直连门禁的 307 指向 oauth 不含
          return finish({
            type: 'upstream-error', status: up.status, body: obj,
            raw: text.slice(0, 500), location: up.headers.get('location'),
            retryAfter: up.headers.get('retry-after'),
          });
        }
        const isSse = /event-stream/i.test(up.headers.get('content-type') || '');
        diagnostics?.open(isSse);
        if (onOpen) onOpen(isSse);

        if (!isSse) {
          // 流式请求被以 JSON 应答(典型:上游一切错误都走 200+JSON;
          // 极少数是完整 completion,同样带回由调用方处理,不丢弃)。
          // JSON body 同样可能挂死(头部到达后不再发字节),空闲超时一并覆盖。
          armIdle();
          let bytes;
          try {
            reader = up.body.getReader();
            bytes = await readLimited(reader, upstreamJsonBodyLimit, received);
          } catch (e) {
            cancelBody();
            if (e?.code === 'UPSTREAM_BODY_LIMIT') {
              return finish(networkError(e, `上游 JSON 响应超过 ${upstreamJsonBodyLimit / 1048576}MB 上限`));
            }
            return finish(networkError(e, '上游 JSON 响应读取失败'));
          }
          if (settled) return; // 等待读取期间超时/取消已收尾
          diagnostics?.json(bytes);
          let text;
          try {
            // 200 JSON 也可能携带原生工具调用，不能把损坏字节替换后交付。
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            cancelBody();
            return finish({ type: 'protocol-error', reason: 'invalid',
              message: '上游 JSON 响应含非法 UTF-8，已停止交付，避免替换字符改变正文或工具参数' });
          }
          let obj = null;
          try { obj = JSON.parse(text); } catch (e) { /* 非 JSON 错误页:按 body=null 带回原文 */ }
          if (obj?.choices) return finish({ type: 'completion', body: obj });
          return finish({ type: 'upstream-error', status: up.status, body: obj, raw: text.slice(0, 500), retryAfter: up.headers.get('retry-after') });
        }

        // SSE 路径:解析器负责 UTF-8 解码与行边界;总量限量防异常大流吃内存
        reader = up.body.getReader();
        const parser = new SseParser(sseLineLimit);
        let total = 0;
        let usage = null;
        // 上游产出与"我们读到的字节"绑定的两个量:是否收到过任何字节、最后
        // 一个字节的时刻。空闲守卫按字节到达重排(R2 的 idleMs 同源,不可各记
        // 一份——口径漂移会让日志时长与判定对不上)
        let sawBytes = false;
        let lastBytesAt = 0;
        armIdle();
        for (;;) {
          const { done, value } = await reader.read();
          const receivedAt = performance.now();
          if (settled) return;
          let events;
          if (done) {
            diagnostics?.end();
            events = parser.finish();
          } else {
            sawBytes = true;
            receivedBytes += value.length;
            lastBytesAt = Date.now();
            armIdle();
            total += value.length;
            if (total > upstreamSseTotalLimit) {
              cancelBody();
              return finish(networkError({ code: 'UPSTREAM_BODY_LIMIT' }, `上游响应超过 ${upstreamSseTotalLimit / 1048576}MB 上限`));
            }
            diagnostics?.bytes(value);
            events = parser.push(value);
          }
          for (const event of events) {
            if (event.type === 'done') {
              // [DONE] 即终止:立即取消 reader,不等上游关闭连接
              cancelBody();
              return finish({ type: 'stream', usage, completedAt: receivedAt });
            }
            if (event.type === 'invalid') {
              cancelBody();
              return finish({ type: 'protocol-error', reason: 'invalid', message: event.message });
            }
            const obj = event.value;
            // 显式错误优先于 choices/usage，不能让混合错误帧冲刷成功收尾。
            // event:error 的 data 可直接是裸错误对象，不要求再包一层 error。
            if (event.type === 'error' || (obj && typeof obj === 'object' &&
                (obj.errorMessage !== undefined || obj.error !== undefined))) {
              cancelBody();
              return finish({ type: 'upstream-error', status: up.status, body: obj, raw: JSON.stringify(obj).slice(0, 500), retryAfter: up.headers.get('retry-after') });
            }
            if (obj?.usage) usage = obj.usage;
            if (onChunk) {
              // 下游交付期间挂起空闲守卫(onChunk 可以是 async:透传路径的
              // waitDrain 就等在它内部)。客户端停读造成的背压会让本循环长
              // 时间不读上游,但那段静默是代理自己造成的,不是上游挂死——
              // 计入的话守卫会在 streamIdleTimeout 处掐掉健康流,还把死因
              // 记成上游空闲(2026-09-16 复现)。交付完成后按"现在"重新计时;
              // 客户端永久停读仍有 streamTotalTimeout 兜底,不会无限挂住
              clearTimeout(idleTimer);
              try { phase = 'delivery'; await onChunk(obj, { receivedAt }); }
              catch (e) {
                cancelBody();
                if (e?.code === 'UPSTREAM_TOOL_INDEX' || e?.code === 'UPSTREAM_TOOL_CALL') {
                  return finish({ type: 'protocol-error', reason: 'invalid', message: e.message });
                }
                return finish(networkError(e));
              }
              phase = 'response-body';
              if (settled) return;
              // 背压等待不计入 idleMs:lastBytesAt 只在读上游时更新,若不
              // 刷新,下游停读 N 秒后截断时文案里的"距上一帧"会虚高 N 秒
              lastBytesAt = Date.now();
              armIdle();
            }
            if (settled) return;
          }
          if (done) break;
        }
        // EOF 但未见 [DONE]:上游截断(网关掐流/连接中断),不能当正常结束,
        // 否则下游会把半截回答当完整回答。idleMs 一并带回:距上一帧收到的
        // 时长(首帧都没等到时为整个请求已等待时长),供错误文案区分两形态
        finish({
          type: 'protocol-error', reason: 'truncated',
          message: '上游流被截断(未见终止标记 [DONE])',
          idleMs: Date.now() - (sawBytes ? lastBytesAt : requestStart),
          sawBytes,
        });
      })().catch((e) => {
        // 唯一的主错误通道:外部取消优先,其余按网络错误带回 cause
        if (signal?.aborted) return finish({ type: 'aborted' });
        cancelBody();
        lifecycle.abort();
        finish(networkError(e));
      });
    });
  }

  return { request };
}

module.exports = { createUpstreamClient };
