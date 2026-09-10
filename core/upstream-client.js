// core/upstream-client.js
// 上游转发核心:恒以流式请求上游(绕 nginx 非流式 60s 超时;透传或聚合由调用方
// 决定)。整个生命周期由一个 AbortController 管理;header / idle / total 三类
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
//   {type:'network-error', cause}               fetch/读取层网络错误
//
// onChunk(obj) 收每个 SSE data JSON,可为 async(背压等待期间不再读上游);
// onOpen(isSse) 在上游响应头到达时调用一次。
//
// === 异常契约(调用方依赖) ===
// request() 的返回 promise **只 resolve 结果对象,不 reject**(内部唯一的
// 主错误通道是 .catch → 按结果形态带回)。mock 或未来实现若违反此契约
// 直接 reject,调用方(proxy-service.handleRequest)的 try/finally 仍会释放
// inflight,但异常会向上传播到 HTTP adapter,由其兜底转 500——行为可预期,
// 不是静默吞掉。

'use strict';

const { SseParser } = require('./stream-parser');

// 限量读:错误页/直答异常膨胀时及时放弃,不无限缓冲(超限抛 UPSTREAM_BODY_LIMIT)
async function readLimited(reader, limit) {
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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

function createUpstreamClient(config) {
  const {
    upstream,
    streamIdleTimeout, streamTotalTimeout, upstreamHeaderTimeout,
    upstreamJsonBodyLimit, upstreamSseTotalLimit, sseLineLimit,
  } = config;

  function request({ payload, token, cookie, signal, onChunk, onOpen }) {
    return new Promise((resolve) => {
      // 单一 AbortController:外部 signal(客户端断开/聚合超时)与 header 超时
      // 都汇入这里;idle/total 超时经 cancelBody 令读取循环结束。
      // 不用 AbortSignal.any:手动桥接对所有 Node 版本一致,且已覆盖 aborted 初态
      const lifecycle = new AbortController();
      if (signal) {
        if (signal.aborted) lifecycle.abort();
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true });
      }

      let settled = false;
      let idleTimer = null;
      let totalTimer = null;
      let headerTimer = null;
      let reader = null;
      let upBody = null; // JSON 应答路径在 reader 建立前保留 body 以便取消

      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(headerTimer);
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
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
      // 响应头超时:TCP/TLS/代理层挂住时 30s 放弃,不长期占用并发槽
      // (空闲计时器只覆盖"收到响应后";这里覆盖"发出请求到响应头"的窗口)
      headerTimer = setTimeout(() => {
        lifecycle.abort(); // abort() 无抛出路径;中止尚未建立的连接
        cancelBody();
        finish({ type: 'timeout', phase: 'headers' });
      }, upstreamHeaderTimeout);

      (async () => {
        const reqHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        };
        // WebVPN 隧道会话凭证:上游走隧道前缀时必带,否则隧道把请求当未登录
        // 踢回登录页(表现为 upstream-error 502/307)。直连上游的老配置不带
        // 此头不受影响
        if (cookie) reqHeaders.Cookie = cookie;

        const up = await fetch(upstream, {
          method: 'POST',
          headers: reqHeaders,
          body: Buffer.from(JSON.stringify(payload), 'utf8'),
          redirect: 'manual',
          signal: lifecycle.signal,
        });
        clearTimeout(headerTimer);
        const isSse = /event-stream/i.test(up.headers.get('content-type') || '');
        if (onOpen) onOpen(isSse);
        upBody = up.body;
        // 总时限统一覆盖两条应答路径(SSE 与 JSON fallback):空闲超时挡不住
        // "周期性发字节"的流,总上限兜底并发槽占用
        totalTimer = setTimeout(() => {
          cancelBody();
          finish({ type: 'timeout', phase: 'total' });
        }, streamTotalTimeout);

        if (!isSse) {
          // 流式请求被以 JSON 应答(典型:上游一切错误都走 200+JSON;
          // 极少数是完整 completion,同样带回由调用方处理,不丢弃)。
          // JSON body 同样可能挂死(头部到达后不再发字节),空闲超时一并覆盖。
          armIdle();
          let text;
          try {
            reader = up.body.getReader();
            text = (await readLimited(reader, upstreamJsonBodyLimit)).toString('utf8');
          } catch (e) {
            cancelBody();
            if (e?.code === 'UPSTREAM_BODY_LIMIT') {
              return finish({ type: 'network-error', cause: `上游 JSON 响应超过 ${upstreamJsonBodyLimit / 1048576}MB 上限` });
            }
            return finish({ type: 'network-error', cause: `上游 JSON 响应读取失败: ${String(e?.message || e)}` });
          }
          if (settled) return; // 等待读取期间超时/取消已收尾
          let obj = null;
          try { obj = JSON.parse(text); } catch (e) { /* 非 JSON 错误页:按 body=null 带回原文 */ }
          if (obj?.choices) return finish({ type: 'completion', body: obj });
          return finish({ type: 'upstream-error', status: up.status, body: obj, raw: text.slice(0, 500) });
        }

        // SSE 路径:解析器负责 UTF-8 解码与行边界;总量限量防异常大流吃内存
        reader = up.body.getReader();
        const parser = new SseParser(sseLineLimit);
        let total = 0;
        let usage = null;
        armIdle();
        for (;;) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) break;
          armIdle();
          total += value.length;
          if (total > upstreamSseTotalLimit) {
            cancelBody();
            return finish({ type: 'network-error', cause: `上游响应超过 ${upstreamSseTotalLimit / 1048576}MB 上限` });
          }
          for (const event of parser.push(value)) {
            if (event.type === 'done') {
              // [DONE] 即终止:立即取消 reader,不等上游关闭连接
              cancelBody();
              return finish({ type: 'stream', usage });
            }
            if (event.type === 'invalid') {
              cancelBody();
              return finish({ type: 'protocol-error', reason: 'invalid', message: event.message });
            }
            const obj = event.value;
            if (obj && typeof obj === 'object' && obj.errorMessage !== undefined && !obj.choices) {
              cancelBody();
              return finish({ type: 'upstream-error', status: up.status, body: obj, raw: JSON.stringify(obj).slice(0, 500) });
            }
            if (obj?.usage) usage = obj.usage;
            if (onChunk) {
              try { await onChunk(obj); }
              catch (e) {
                cancelBody();
                return finish({ type: 'network-error', cause: `下游写失败(客户端已断开): ${String(e?.message || e)}` });
              }
            }
            if (settled) return;
          }
        }
        // EOF 但未见 [DONE]:上游截断(网关掐流/连接中断),不能当正常结束,
        // 否则下游会把半截回答当完整回答
        finish({ type: 'protocol-error', reason: 'truncated', message: '上游流被截断(未见终止标记 [DONE])' });
      })().catch((e) => {
        // 唯一的主错误通道:外部取消优先,其余按网络错误带回 cause
        if (signal?.aborted) return finish({ type: 'aborted' });
        finish({ type: 'network-error', cause: String(e?.message || e) });
      });
    });
  }

  return { request };
}

module.exports = { createUpstreamClient };
